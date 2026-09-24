/**
 * Debug script to check if action items are being extracted and stored
 */

const mongoose = require('mongoose');
const Call = require('./models/Call');
const TranscriptSegment = require('./models/TranscriptSegment');
const aiAgentService = require('./services/AIAgentService');
const transcriptFileGenerator = require('./services/TranscriptFileGenerator');

require('dotenv').config();

async function debugActionItems() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected!\n');

    // Check if AI Agent is available
    console.log('=== AI Agent Configuration ===');
    console.log('GROQ_API_KEY exists:', !!process.env.GROQ_API_KEY);
    console.log('GROQ_LLM_MODEL:', process.env.GROQ_LLM_MODEL);
    console.log('AI Agent available:', aiAgentService.isAvailable());
    console.log('Config:', aiAgentService.getConfig());
    console.log('');

    // Get all calls with transcripts
    console.log('=== Checking Calls with Transcripts ===');
    const calls = await Call.find({ 'transcript.status': 'completed' })
      .select('roomId transcript startedAt endedAt')
      .sort({ startedAt: -1 })
      .limit(5);

    console.log(`Found ${calls.length} completed calls with transcripts\n`);

    for (const call of calls) {
      console.log(`\n--- Call: ${call.roomId} ---`);
      console.log('Started:', call.startedAt);
      console.log('Transcript status:', call.transcript?.status);
      console.log('Transcript file:', call.transcript?.txtPath);
      console.log('Action items count:', call.transcript?.actionItems?.length || 0);
      console.log('Has summary:', !!call.transcript?.summary);
      console.log('Has key decisions:', call.transcript?.keyDecisions?.length || 0);

      if (call.transcript?.actionItems?.length > 0) {
        console.log('\nAction items:');
        call.transcript.actionItems.forEach((item, i) => {
          console.log(`  ${i + 1}. [${item.priority}] ${item.task}`);
          console.log(`     Owner: ${item.owner}, Deadline: ${item.deadline}`);
        });
      } else {
        console.log('\n⚠️  No action items found for this call');
        
        // Check if there are transcript segments
        const segmentCount = await TranscriptSegment.countDocuments({ roomId: call.roomId });
        console.log(`   Transcript segments: ${segmentCount}`);
        
        if (segmentCount > 0) {
          console.log('   → Transcript exists but no action items extracted');
          console.log('   → Possible issue with AI extraction');
        }
      }
    }

    console.log('\n\n=== Testing Action Item Extraction ===');
    
    // Test with a sample transcript
    const testTranscript = `
[00:00 - 00:15] John:
We need to finalize the budget report by Friday. Sarah, can you handle that?

[00:15 - 00:30] Sarah:
Yes, I'll get it done by end of week. Should I also update the quarterly projections?

[00:30 - 00:45] John:
That would be great. Make sure to include the new hiring costs. This is high priority.

[00:45 - 01:00] Mike:
I'll review the projections next Monday and send feedback to both of you.
`;

    console.log('Testing with sample transcript...');
    const result = await aiAgentService.extractActionItems(testTranscript);
    
    console.log('\nExtraction result:');
    console.log('Success:', result.success);
    console.log('Action items found:', result.analysis?.actionItems?.length || 0);
    console.log('Processing time:', result.metadata?.processingTimeMs, 'ms');
    
    if (result.success && result.analysis?.actionItems?.length > 0) {
      console.log('\nExtracted items:');
      result.analysis.actionItems.forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.priority}] ${item.task}`);
        console.log(`     Owner: ${item.owner}, Deadline: ${item.deadline}`);
      });
    } else if (!result.success) {
      console.log('Error:', result.error);
    }

    console.log('\n\n=== Checking Google Calendar Status ===');
    const User = require('./models/User');
    const users = await User.find({ 'googleCalendar.connected': true })
      .select('username email googleCalendar');
    
    console.log(`Found ${users.length} users with connected calendars`);
    users.forEach(user => {
      console.log(`\n  User: ${user.username} (${user.email})`);
      console.log(`  Calendar email: ${user.googleCalendar?.email}`);
      console.log(`  Connected at: ${user.googleCalendar?.connectedAt}`);
      console.log(`  Token expiry: ${user.googleCalendar?.tokenExpiry}`);
    });

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

debugActionItems();
