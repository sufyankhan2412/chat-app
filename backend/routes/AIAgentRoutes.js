const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const aiAgentService = require('../services/AIAgentService');

/**
 * @route   POST /api/ai-agent/test
 * @desc    Test connection to GPT-5.6-Luna
 * @access  Public (for development - add auth in production)
 */
router.post('/test', async (req, res) => {
  try {
    const result = await aiAgentService.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   POST /api/ai-agent/analyze
 * @desc    Send task to GPT-5.6-Luna for analysis and instructions
 * @access  Public (for development - add auth in production)
 */
router.post('/analyze', async (req, res) => {
  try {
    const { task, filePaths = [] } = req.body;

    if (!task) {
      return res.status(400).json({ success: false, error: 'Task is required' });
    }

    // Read relevant files if specified
    const files = [];
    for (const filePath of filePaths) {
      try {
        const fullPath = path.join(__dirname, '..', filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        files.push({ path: filePath, content });
      } catch (err) {
        console.warn(`Could not read file ${filePath}:`, err.message);
      }
    }

    const context = `This is a real-time chat application with:
- 1-to-1 text messaging
- 1-to-1 audio/video calls using WebRTC
- Group calls with persistent meeting rooms
- Socket.IO for real-time communication
- Call transcription using Whisper`;

    const result = await aiAgentService.getInstructions({
      task,
      context,
      files
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   POST /api/ai-agent/get-instructions
 * @desc    Pre-configured endpoint for the current task
 * @access  Public (for development)
 */
router.post('/get-instructions', async (req, res) => {
  try {
    // Read relevant frontend and backend files for the calling feature
    const filesToAnalyze = [
      'socket/Socketmanager.js',
      '../sockets/context/SocketContext.jsx',
    ];

    const files = [];
    for (const filePath of filesToAnalyze) {
      try {
        const fullPath = path.join(__dirname, '..', filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        files.push({ path: filePath, content });
      } catch (err) {
        console.warn(`Could not read file ${filePath}:`, err.message);
      }
    }

    const task = `
REQUIREMENTS:

1. **Speaker Mode Control for Audio/Video Calls:**
   - Currently: Audio/video calls automatically use speaker mode (loud speaker)
   - Required: By default, audio should play through earpiece (not speaker)
   - User should be able to toggle speaker on/off intentionally
   - This applies to both 1-to-1 calls and group calls

2. **Call End Behavior Bug Fix:**
   - Currently: In 1-to-1 calls, when one person ends the call, the other person must also click "End Call"
   - Required: In 1-to-1 calls, when one person ends the call, it should automatically end for both parties
   - Group Calls: Should only end when the last participant leaves. Individual exits should only remove that person.

3. **Implementation Notes:**
   - This is a WebRTC-based calling system
   - Socket.IO handles signaling
   - Need to handle both frontend UI state and backend socket events
   - Consider mobile browser audio routing APIs
`;

    const context = `This is a MERN stack real-time chat application with WebRTC calling:
- Backend: Node.js, Express, Socket.IO, MongoDB
- Frontend: React with Socket.IO client
- WebRTC for peer-to-peer audio/video
- Real-time signaling via Socket.IO
- Supports 1-to-1 calls and group calls with meeting links`;

    const result = await aiAgentService.getInstructions({
      task,
      context,
      files
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
