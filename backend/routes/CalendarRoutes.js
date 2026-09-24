const express = require('express');
const { protect } = require('../middleware/Authmiddleware');
const googleCalendarService = require('../services/GoogleCalendarService');
const Call = require('../models/Call');

const router = express.Router();

// @route  GET /api/calendar/status
// Get user's calendar connection status
router.get('/status', protect, async (req, res) => {
  try {
    const status = await googleCalendarService.getConnectionStatus(req.user._id);
    res.json(status);
  } catch (error) {
    console.error('Calendar status error:', error);
    res.status(500).json({ message: 'Failed to get calendar status' });
  }
});

// @route  GET /api/calendar/connect
// Start OAuth flow - returns authorization URL
router.get('/connect', protect, async (req, res) => {
  try {
    if (!googleCalendarService.isAvailable()) {
      return res.status(503).json({ 
        message: 'Google Calendar integration is not configured on this server' 
      });
    }
    
    const authUrl = googleCalendarService.getAuthorizationUrl(String(req.user._id));
    res.json({ authUrl });
  } catch (error) {
    console.error('Calendar connect error:', error);
    res.status(500).json({ message: 'Failed to initiate calendar connection' });
  }
});

// @route  GET /api/calendar/oauth/callback
// OAuth callback - exchanges code for tokens
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code || !state) {
      return res.status(400).send('Missing authorization code or state');
    }
    
    const userId = state;
    
    // Exchange code for tokens
    const tokens = await googleCalendarService.exchangeCodeForTokens(code);
    
    // Save tokens to user
    await googleCalendarService.saveUserTokens(userId, tokens);
    
    console.log('[CalendarRoutes] Calendar connected for user:', userId);
    
    // Redirect back to frontend with success
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/settings?calendar=connected`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/settings?calendar=error`);
  }
});

// @route  POST /api/calendar/disconnect
// Disconnect Google Calendar
router.post('/disconnect', protect, async (req, res) => {
  try {
    await googleCalendarService.disconnectCalendar(req.user._id);
    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (error) {
    console.error('Calendar disconnect error:', error);
    res.status(500).json({ message: 'Failed to disconnect calendar' });
  }
});

// @route  POST /api/calendar/sync/:roomId
// Sync action items from a specific call to calendar
router.post('/sync/:roomId', protect, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    // Check if user has calendar connected
    const isConnected = await googleCalendarService.isCalendarConnected(req.user._id);
    if (!isConnected) {
      return res.status(400).json({ 
        message: 'Please connect your Google Calendar first' 
      });
    }
    
    // Get call with action items
    const call = await Call.findOne({ roomId }).select('participants transcript startedAt');
    
    if (!call) {
      return res.status(404).json({ message: 'Call not found' });
    }
    
    // Check if user was a participant
    const wasParticipant = call.participants.some(
      (p) => String(p.user) === String(req.user._id)
    );
    if (!wasParticipant) {
      return res.status(403).json({ message: "You weren't part of this call" });
    }
    
    // Check if action items exist
    if (!call.transcript?.actionItems || call.transcript.actionItems.length === 0) {
      return res.status(400).json({ 
        message: 'No action items found for this call' 
      });
    }
    
    // Sync to calendar
    const result = await googleCalendarService.syncActionItemsToCalendar(
      req.user._id,
      call.transcript.actionItems,
      {
        roomId,
        callDate: call.startedAt.toISOString().split('T')[0]
      }
    );
    
    res.json(result);
  } catch (error) {
    console.error('Calendar sync error:', error);
    
    if (error.message === 'Google Calendar not connected') {
      return res.status(400).json({ message: 'Calendar connection expired. Please reconnect.' });
    }
    
    res.status(500).json({ message: 'Failed to sync to calendar' });
  }
});

module.exports = router;
