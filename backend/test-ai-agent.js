/**
 * Test script to call GPT-5.6-Luna and get instructions
 * Run with: node test-ai-agent.js
 */

const aiAgentService = require('./services/AIAgentService');
const fs = require('fs').promises;
const path = require('path');

async function testAIAgent() {
  console.log('🤖 Testing GPT-5.6-Luna Connection via Experiential Gateway...\n');

  // Test 1: Simple connection test
  console.log('📡 Test 1: Testing API connection...');
  const connectionTest = await aiAgentService.testConnection();
  
  if (connectionTest.success) {
    console.log('✅ Connection successful!');
    console.log('📝 Response:', connectionTest.message);
    console.log('📊 Token usage:', connectionTest.usage);
    console.log('🤖 Model:', connectionTest.model);
  } else {
    console.log('❌ Connection failed:', connectionTest.error);
    return;
  }

  console.log('\n' + '='.repeat(80) + '\n');

  // Test 2: Get instructions for the actual task
  console.log('📡 Test 2: Getting instructions from GPT-5.6-Luna...\n');

  try {
    // Read relevant files
    const filesToRead = [
      'socket/Socketmanager.js',
    ];

    const files = [];
    for (const filePath of filesToRead) {
      try {
        const fullPath = path.join(__dirname, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        files.push({ 
          path: filePath, 
          content: content.substring(0, 3000) // Limit to first 3000 chars for API limits
        });
        console.log(`✅ Read file: ${filePath} (${content.length} chars)`);
      } catch (err) {
        console.log(`⚠️  Could not read ${filePath}: ${err.message}`);
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

    if (result.success) {
      console.log('\n✅ Instructions received from GPT-5.6-Luna:\n');
      console.log('='.repeat(80));
      console.log(result.instructions);
      console.log('='.repeat(80));
      console.log('\n📊 Token usage:', result.usage);
      console.log('🤖 Model:', result.model);
      console.log('⏰ Timestamp:', result.timestamp);

      // Save instructions to a file
      const outputPath = path.join(__dirname, 'ai-instructions.txt');
      await fs.writeFile(outputPath, `
GPT-5.6-Luna Instructions
Generated: ${result.timestamp}
Model: ${result.model}
Token Usage: ${JSON.stringify(result.usage, null, 2)}

${'='.repeat(80)}

${result.instructions}

${'='.repeat(80)}
`, 'utf-8');
      console.log(`\n💾 Instructions saved to: ${outputPath}`);
    } else {
      console.log('❌ Failed to get instructions:', result.error);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Run the test
testAIAgent().catch(console.error);
