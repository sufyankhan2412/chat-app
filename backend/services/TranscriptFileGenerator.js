/**
 * Transcript File Generator
 * 
 * Generates downloadable .txt transcript files from MongoDB TranscriptSegments
 * after a call completes. This replaces the live transcript UI - users now
 * receive a formatted text file they can download from call history.
 */

const fs = require('fs').promises;
const path = require('path');
const TranscriptSegment = require('../models/TranscriptSegment');
const Call = require('../models/Call');
const User = require('../models/User');
const aiAgentService = require('./AIAgentService');

// Directory for storing transcript files
const TRANSCRIPTS_DIR = path.join(__dirname, '../uploads/transcripts');

// Ensure transcripts directory exists
async function ensureTranscriptsDir() {
  try {
    await fs.mkdir(TRANSCRIPTS_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error('[TranscriptFileGenerator] Failed to create transcripts directory:', error);
      throw error;
    }
  }
}

/**
 * Format duration in seconds to HH:MM:SS or MM:SS
 */
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format timestamp in milliseconds to [HH:MM:SS] or [MM:SS]
 */
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Generate a formatted .txt transcript file from MongoDB segments
 * 
 * @param {string} roomId - The call/room ID
 * @param {Object} options - Optional parameters
 * @param {boolean} options.includeActionItems - Whether to extract and include AI action items
 * @returns {Promise<Object>} { success, txtPath, actionItems, error }
 */
async function generateTranscriptFile(roomId, options = {}) {
  const { includeActionItems = true } = options;
  
  try {
    console.log('[TranscriptFileGenerator] Starting transcript generation for room:', roomId);
    
    await ensureTranscriptsDir();
    
    // Fetch the call document
    const call = await Call.findOne({ roomId })
      .populate('initiator', 'username')
      .populate('participants.user', 'username');
    
    if (!call) {
      throw new Error(`Call not found: ${roomId}`);
    }
    
    // Fetch all transcript segments for this call, sorted chronologically
    const segments = await TranscriptSegment.find({ roomId })
      .sort({ startTimeMs: 1, createdAt: 1 }) // Primary: speech start time, Secondary: creation order
      .lean();
    
    if (!segments || segments.length === 0) {
      console.warn('[TranscriptFileGenerator] No transcript segments found for room:', roomId);
      return {
        success: false,
        error: 'No transcript segments available',
        txtPath: null
      };
    }
    
    // Build the transcript text
    const lines = [];
    
    // Header
    lines.push('==================================================');
    lines.push('CALL TRANSCRIPT');
    lines.push('==================================================');
    lines.push('');
    lines.push(`Call ID: ${roomId}`);
    lines.push(`Date: ${call.startedAt.toISOString().split('T')[0]}`);
    
    // Calculate duration
    if (call.endedAt && call.startedAt) {
      const durationSeconds = Math.round((call.endedAt - call.startedAt) / 1000);
      lines.push(`Duration: ${formatDuration(durationSeconds)}`);
    }
    
    lines.push('');
    
    // Participants list
    lines.push('Participants:');
    const participantNames = new Set();
    for (const participant of call.participants) {
      const name = participant.user?.username || 'Unknown';
      participantNames.add(name);
    }
    participantNames.forEach(name => {
      lines.push(`  • ${name}`);
    });
    
    lines.push('');
    lines.push('==================================================');
    lines.push('');
    
    // Transcript segments
    for (const segment of segments) {
      const startTime = formatTimestamp(segment.startTimeMs);
      const endTime = formatTimestamp(segment.endTimeMs);
      const speaker = segment.speakerName || 'Unknown';
      
      lines.push(`[${startTime} - ${endTime}] ${speaker}:`);
      lines.push(segment.text);
      lines.push('');
    }
    
    // Footer
    lines.push('==================================================');
    lines.push('END OF TRANSCRIPT');
    lines.push('==================================================');
    
    const transcriptText = lines.join('\n');
    
    // Save transcript file
    const fileName = `${roomId}.txt`;
    const txtPath = path.join(TRANSCRIPTS_DIR, fileName);
    
    await fs.writeFile(txtPath, transcriptText, 'utf8');
    
    console.log('[TranscriptFileGenerator] Transcript file generated successfully:', {
      roomId,
      txtPath,
      segmentCount: segments.length,
      participants: Array.from(participantNames)
    });
    
    // Extract action items using AI (if enabled and available)
    let actionItemsResult = null;
    if (includeActionItems && aiAgentService.isAvailable()) {
      try {
        console.log('[TranscriptFileGenerator] Extracting action items with AI...');
        actionItemsResult = await aiAgentService.extractActionItems(transcriptText);
        
        if (actionItemsResult.success && actionItemsResult.analysis.actionItems.length > 0) {
          console.log('[TranscriptFileGenerator] Action items extracted:', {
            count: actionItemsResult.analysis.actionItems.length,
            model: actionItemsResult.metadata.model
          });
          
          // Append action items to the transcript file
          const actionItemsSection = generateActionItemsSection(actionItemsResult.analysis);
          await fs.appendFile(txtPath, '\n\n' + actionItemsSection, 'utf8');
        } else {
          console.log('[TranscriptFileGenerator] No action items found or extraction failed');
        }
      } catch (aiError) {
        console.error('[TranscriptFileGenerator] AI action item extraction failed:', aiError.message);
        // Don't fail the whole transcript if AI fails - it's a nice-to-have
      }
    }
    
    return {
      success: true,
      txtPath,
      segmentCount: segments.length,
      actionItems: actionItemsResult?.success ? actionItemsResult.analysis : null,
      error: null
    };
    
  } catch (error) {
    console.error('[TranscriptFileGenerator] Failed to generate transcript:', {
      roomId,
      error: error.message,
      stack: error.stack
    });
    
    return {
      success: false,
      txtPath: null,
      error: error.message
    };
  }
}

/**
 * Update the Call document with transcript file metadata
 * 
 * @param {string} roomId - The call/room ID
 * @param {string} status - 'processing' | 'completed' | 'failed'
 * @param {Object} data - Additional data (txtPath, error, actionItems, etc.)
 */
async function updateCallTranscriptStatus(roomId, status, data = {}) {
  try {
    const update = {
      'transcript.status': status,
      'transcript.completedAt': status === 'completed' ? new Date() : null
    };
    
    if (data.txtPath) {
      update['transcript.txtPath'] = data.txtPath;
    }
    
    if (data.error) {
      update['transcript.error'] = data.error;
    }
    
    // Save AI-extracted action items
    if (data.actionItems) {
      const analysis = data.actionItems;
      
      if (analysis.actionItems && analysis.actionItems.length > 0) {
        // Add calendar links to each action item
        const itemsWithLinks = analysis.actionItems.map(item => ({
          ...item,
          calendarLink: aiAgentService.generateCalendarLink(item)
        }));
        
        update['transcript.actionItems'] = itemsWithLinks;
      }
      
      if (analysis.keyDecisions) {
        update['transcript.keyDecisions'] = analysis.keyDecisions;
      }
      
      if (analysis.nextSteps) {
        update['transcript.nextSteps'] = analysis.nextSteps;
      }
      
      if (analysis.summary) {
        update['transcript.summary'] = analysis.summary;
      }
    }
    
    await Call.updateOne({ roomId }, { $set: update });
    
    console.log('[TranscriptFileGenerator] Updated call transcript status:', {
      roomId,
      status,
      txtPath: data.txtPath || null,
      actionItemCount: data.actionItems?.actionItems?.length || 0
    });
    
  } catch (error) {
    console.error('[TranscriptFileGenerator] Failed to update call transcript status:', {
      roomId,
      error: error.message
    });
  }
}

/**
 * Complete workflow: Generate transcript file and update Call document
 * 
 * @param {string} roomId - The call/room ID
 */
async function finalizeTranscript(roomId) {
  console.log('[TranscriptFileGenerator] Finalizing transcript for room:', roomId);
  
  // Mark as processing
  await updateCallTranscriptStatus(roomId, 'processing');
  
  // Generate the file
  const result = await generateTranscriptFile(roomId);
  
  if (result.success) {
    // Mark as completed with file path and action items
    await updateCallTranscriptStatus(roomId, 'completed', {
      txtPath: result.txtPath,
      actionItems: result.actionItems
    });
    
    console.log('[TranscriptFileGenerator] Transcript finalized successfully:', roomId);
    
    // Auto-sync action items to Google Calendar for all participants
    if (result.actionItems && result.actionItems.actionItems && result.actionItems.actionItems.length > 0) {
      console.log('[TranscriptFileGenerator] Auto-syncing action items to Google Calendar...');
      await autoSyncActionItemsToCalendar(roomId, result.actionItems.actionItems);
    }
    
    return { 
      success: true, 
      txtPath: result.txtPath,
      actionItems: result.actionItems
    };
  } else {
    // Mark as failed with error
    await updateCallTranscriptStatus(roomId, 'failed', {
      error: result.error
    });
    
    console.error('[TranscriptFileGenerator] Transcript finalization failed:', {
      roomId,
      error: result.error
    });
    return { success: false, error: result.error };
  }
}

/**
 * Generate action items section for the transcript file
 */
function generateActionItemsSection(analysis) {
  const lines = [];
  
  lines.push('');
  lines.push('==================================================');
  lines.push('AI-EXTRACTED ACTION ITEMS');
  lines.push('==================================================');
  lines.push('');
  
  if (analysis.summary) {
    lines.push('📝 MEETING SUMMARY:');
    lines.push(analysis.summary);
    lines.push('');
  }
  
  if (analysis.actionItems && analysis.actionItems.length > 0) {
    lines.push(`📋 ACTION ITEMS (${analysis.actionItems.length}):`);
    lines.push('');
    
    analysis.actionItems.forEach((item, index) => {
      const priorityEmoji = item.priority === 'High' ? '🔴' : item.priority === 'Medium' ? '🟡' : '🟢';
      lines.push(`${index + 1}. ${priorityEmoji} ${item.task}`);
      
      if (item.owner && item.owner !== 'Not specified') {
        lines.push(`   👤 Owner: ${item.owner}`);
      }
      
      if (item.deadline && item.deadline !== 'Not specified') {
        lines.push(`   ⏰ Deadline: ${item.deadline}`);
      }
      
      if (item.priority) {
        lines.push(`   ⭐ Priority: ${item.priority}`);
      }
      
      if (item.context) {
        lines.push(`   💬 Context: ${item.context}`);
      }
      
      lines.push('');
    });
  }
  
  if (analysis.keyDecisions && analysis.keyDecisions.length > 0) {
    lines.push('💡 KEY DECISIONS:');
    analysis.keyDecisions.forEach(decision => {
      lines.push(`  • ${decision}`);
    });
    lines.push('');
  }
  
  if (analysis.nextSteps && analysis.nextSteps.length > 0) {
    lines.push('➡️  NEXT STEPS:');
    analysis.nextSteps.forEach(step => {
      lines.push(`  • ${step}`);
    });
    lines.push('');
  }
  
  lines.push('--------------------------------------------------');
  lines.push('Generated by AI (Groq LLM) • Free & Open Source');
  lines.push('==================================================');
  
  return lines.join('\n');
}

/**
 * Check if transcript generation is available
 */
function isAvailable() {
  return true; // File generation always available (doesn't depend on external services)
}

/**
 * Auto-sync action items to Google Calendar for all call participants
 * This runs automatically after transcript finalization
 * 
 * @param {string} roomId - The call/room ID
 * @param {Array} actionItems - Extracted action items
 */
async function autoSyncActionItemsToCalendar(roomId, actionItems) {
  try {
    const googleCalendarService = require('./GoogleCalendarService');
    
    if (!googleCalendarService.isAvailable()) {
      console.log('[TranscriptFileGenerator] Google Calendar service not configured, skipping auto-sync');
      return;
    }
    
    // Get the call and its participants
    const call = await Call.findOne({ roomId })
      .populate('participants.user', '_id username email')
      .populate('initiator', '_id username email');
    
    if (!call) {
      console.warn('[TranscriptFileGenerator] Call not found for auto-sync:', roomId);
      return;
    }
    
    // Collect all participant user IDs
    const participantIds = new Set();
    
    // Add initiator if exists
    if (call.initiator && call.initiator._id) {
      participantIds.add(String(call.initiator._id));
    }
    
    // Add all participants
    call.participants.forEach(p => {
      if (p.user && p.user._id) {
        participantIds.add(String(p.user._id));
      }
    });
    
    console.log('[TranscriptFileGenerator] Checking calendar sync for', participantIds.size, 'participants');
    
    // Sync for each participant who has calendar connected
    let syncedCount = 0;
    let skippedCount = 0;
    
    for (const userId of participantIds) {
      try {
        // Check if this user has calendar connected
        const isConnected = await googleCalendarService.isCalendarConnected(userId);
        
        if (!isConnected) {
          console.log('[TranscriptFileGenerator] User', userId, 'does not have calendar connected, skipping');
          skippedCount++;
          continue;
        }
        
        // Sync action items to their calendar
        console.log('[TranscriptFileGenerator] Syncing action items to calendar for user:', userId);
        const syncResult = await googleCalendarService.syncActionItemsToCalendar(
          userId,
          actionItems,
          {
            roomId,
            callDate: call.startedAt.toISOString().split('T')[0]
          }
        );
        
        if (syncResult.success) {
          console.log('[TranscriptFileGenerator] ✅ Synced', syncResult.synced, 'action items for user:', userId);
          syncedCount++;
        } else {
          console.warn('[TranscriptFileGenerator] ⚠️ Failed to sync for user:', userId, syncResult.message);
        }
        
      } catch (userError) {
        console.error('[TranscriptFileGenerator] Error syncing for user:', userId, userError.message);
      }
    }
    
    console.log('[TranscriptFileGenerator] Auto-sync complete:', {
      totalParticipants: participantIds.size,
      syncedToCalendar: syncedCount,
      skippedNoCalendar: skippedCount,
      actionItemCount: actionItems.length
    });
    
  } catch (error) {
    console.error('[TranscriptFileGenerator] Auto-sync to calendar failed:', error.message);
    // Don't throw - auto-sync failure shouldn't break transcript generation
  }
}

module.exports = {
  generateTranscriptFile,
  updateCallTranscriptStatus,
  finalizeTranscript,
  isAvailable,
  TRANSCRIPTS_DIR
};
