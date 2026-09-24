/**
 * Google Calendar Service
 * 
 * Handles OAuth flow and syncing action items to Google Calendar.
 * Users connect their Google account once, then action items from
 * transcripts are automatically added to their calendar.
 */

const { google } = require('googleapis');
const User = require('../models/User');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/calendar/oauth/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email'
];

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn('[GoogleCalendarService] Google OAuth credentials not configured. Calendar sync unavailable.');
}

/**
 * Create OAuth2 client
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

/**
 * Generate OAuth consent URL for user to authorize
 * 
 * @param {string} userId - User ID to attach to state parameter
 * @returns {string} Authorization URL
 */
function getAuthorizationUrl(userId) {
  const oauth2Client = createOAuth2Client();
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Get refresh token
    scope: SCOPES,
    state: userId, // Pass userId in state to identify user after OAuth
    prompt: 'consent' // Force consent screen to get refresh token
  });
  
  return authUrl;
}

/**
 * Exchange authorization code for access/refresh tokens
 * 
 * @param {string} code - Authorization code from OAuth callback
 * @returns {Promise<Object>} Tokens and user email
 */
async function exchangeCodeForTokens(code) {
  const oauth2Client = createOAuth2Client();
  
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  
  // Get user's email
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiry: new Date(tokens.expiry_date),
    email: data.email
  };
}

/**
 * Save tokens to user document
 * 
 * @param {string} userId - User ID
 * @param {Object} tokens - Token data
 */
async function saveUserTokens(userId, tokens) {
  await User.findByIdAndUpdate(userId, {
    $set: {
      'googleCalendar.connected': true,
      'googleCalendar.accessToken': tokens.accessToken,
      'googleCalendar.refreshToken': tokens.refreshToken,
      'googleCalendar.tokenExpiry': tokens.tokenExpiry,
      'googleCalendar.email': tokens.email,
      'googleCalendar.connectedAt': new Date()
    }
  });
}

/**
 * Disconnect Google Calendar for a user
 * 
 * @param {string} userId - User ID
 */
async function disconnectCalendar(userId) {
  await User.findByIdAndUpdate(userId, {
    $set: {
      'googleCalendar.connected': false,
      'googleCalendar.accessToken': null,
      'googleCalendar.refreshToken': null,
      'googleCalendar.tokenExpiry': null,
      'googleCalendar.email': null
    }
  });
}

/**
 * Get valid OAuth2 client for a user (refreshes token if needed)
 * 
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Authenticated OAuth2 client
 */
async function getAuthenticatedClient(userId) {
  const user = await User.findById(userId).select('googleCalendar');
  
  if (!user?.googleCalendar?.connected || !user.googleCalendar.refreshToken) {
    throw new Error('Google Calendar not connected');
  }
  
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: user.googleCalendar.accessToken,
    refresh_token: user.googleCalendar.refreshToken,
    expiry_date: user.googleCalendar.tokenExpiry?.getTime()
  });
  
  // Refresh token if expired
  if (user.googleCalendar.tokenExpiry && user.googleCalendar.tokenExpiry < new Date()) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    
    // Update stored tokens
    await User.findByIdAndUpdate(userId, {
      $set: {
        'googleCalendar.accessToken': credentials.access_token,
        'googleCalendar.tokenExpiry': new Date(credentials.expiry_date)
      }
    });
  }
  
  return oauth2Client;
}

/**
 * Parse deadline string to Date object
 * 
 * @param {string} deadline - Natural language deadline
 * @returns {Date|null}
 */
function parseDeadline(deadline) {
  if (!deadline || deadline === 'Not specified') {
    return null;
  }
  
  const now = new Date();
  const lowerDeadline = deadline.toLowerCase();
  
  // Today
  if (lowerDeadline.includes('today')) {
    return now;
  }
  
  // Tomorrow
  if (lowerDeadline.includes('tomorrow')) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }
  
  // Next week
  if (lowerDeadline.includes('next week')) {
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    return nextWeek;
  }
  
  // End of week (Friday)
  if (lowerDeadline.includes('end of week') || lowerDeadline.includes('this friday')) {
    const endOfWeek = new Date(now);
    const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
    endOfWeek.setDate(endOfWeek.getDate() + daysUntilFriday);
    return endOfWeek;
  }
  
  // Next month
  if (lowerDeadline.includes('next month')) {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return nextMonth;
  }
  
  // Try to parse as ISO date (YYYY-MM-DD)
  const isoMatch = deadline.match(/\d{4}-\d{2}-\d{2}/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  
  return null;
}

/**
 * Create a calendar event for an action item
 * 
 * @param {string} userId - User ID
 * @param {Object} actionItem - Action item data
 * @param {Object} callInfo - Call metadata
 * @returns {Promise<Object>} Created event
 */
async function createActionItemEvent(userId, actionItem, callInfo = {}) {
  const oauth2Client = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  // Parse deadline
  const deadline = parseDeadline(actionItem.deadline);
  const startDate = deadline || new Date();
  
  // Set time to 9 AM if deadline is just a date
  startDate.setHours(9, 0, 0, 0);
  
  const endDate = new Date(startDate);
  endDate.setHours(10, 0, 0, 0); // 1 hour duration
  
  // Build description
  const description = [
    actionItem.context || '',
    '',
    `Owner: ${actionItem.owner || 'Not specified'}`,
    `Priority: ${actionItem.priority}`,
    callInfo.roomId ? `\nFrom call: ${callInfo.roomId}` : '',
    callInfo.callDate ? `Call date: ${callInfo.callDate}` : ''
  ].filter(Boolean).join('\n');
  
  // Create event
  const event = {
    summary: actionItem.task,
    description: description,
    start: {
      dateTime: startDate.toISOString(),
      timeZone: 'UTC'
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: 'UTC'
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 }, // 1 hour before
        { method: 'popup', minutes: 1440 } // 1 day before
      ]
    },
    colorId: actionItem.priority === 'High' ? '11' : actionItem.priority === 'Medium' ? '5' : '2'
  };
  
  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event
  });
  
  console.log('[GoogleCalendarService] Created calendar event:', {
    eventId: response.data.id,
    task: actionItem.task,
    deadline: startDate.toISOString()
  });
  
  return response.data;
}

/**
 * Sync all action items from a call to Google Calendar
 * 
 * @param {string} userId - User ID
 * @param {Array} actionItems - Action items to sync
 * @param {Object} callInfo - Call metadata
 * @returns {Promise<Object>} Sync results
 */
async function syncActionItemsToCalendar(userId, actionItems, callInfo = {}) {
  if (!actionItems || actionItems.length === 0) {
    return {
      success: true,
      synced: 0,
      message: 'No action items to sync'
    };
  }
  
  const results = {
    success: true,
    synced: 0,
    failed: 0,
    events: []
  };
  
  for (const item of actionItems) {
    try {
      const event = await createActionItemEvent(userId, item, callInfo);
      results.synced++;
      results.events.push({
        task: item.task,
        eventId: event.id,
        htmlLink: event.htmlLink
      });
    } catch (error) {
      console.error('[GoogleCalendarService] Failed to sync action item:', {
        task: item.task,
        error: error.message
      });
      results.failed++;
    }
  }
  
  if (results.failed > 0) {
    results.success = false;
    results.message = `Synced ${results.synced} items, ${results.failed} failed`;
  } else {
    results.message = `Successfully synced ${results.synced} action items`;
  }
  
  return results;
}

/**
 * Check if user has Google Calendar connected
 * 
 * @param {string} userId - User ID
 * @returns {Promise<boolean>}
 */
async function isCalendarConnected(userId) {
  const user = await User.findById(userId).select('googleCalendar.connected');
  return user?.googleCalendar?.connected || false;
}

/**
 * Get calendar connection status for a user
 * 
 * @param {string} userId - User ID
 * @returns {Promise<Object>}
 */
async function getConnectionStatus(userId) {
  const user = await User.findById(userId).select('googleCalendar');
  
  if (!user?.googleCalendar?.connected) {
    return {
      connected: false,
      email: null,
      connectedAt: null
    };
  }
  
  return {
    connected: true,
    email: user.googleCalendar.email,
    connectedAt: user.googleCalendar.connectedAt
  };
}

/**
 * Check if service is available
 */
function isAvailable() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  saveUserTokens,
  disconnectCalendar,
  getAuthenticatedClient,
  createActionItemEvent,
  syncActionItemsToCalendar,
  isCalendarConnected,
  getConnectionStatus,
  isAvailable
};
