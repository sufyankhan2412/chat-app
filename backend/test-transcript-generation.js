/**
 * Test Script for Transcript Generation
 * 
 * Tests the new transcript file generation workflow without requiring a live call.
 * 
 * Usage:
 *   node test-transcript-generation.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const TranscriptSegment = require('./models/TranscriptSegment');
const Call = require('./models/Call');
const User = require('./models/User');
const transcriptFileGenerator = require('./services/TranscriptFileGenerator');

// Test data
const TEST_ROOM_ID = 'test-transcript-' + Date.now();

async function createTestData() {
  console.log('\n=== Creating Test Data ===\n');
  
  // Find or create test users
  let user1 = await User.findOne({ username: 'TestUser1' });
  let user2 = await User.findOne({ username: 'TestUser2' });
  
  if (!user1) {
    user1 = await User.create({
      username: 'TestUser1',
      email: 'test1@example.com',
      password: 'hashedpassword123'
    });
    console.log('Created TestUser1:', user1._id);
  }
  
  if (!user2) {
    user2 = await User.create({
      username: 'TestUser2',
      email: 'test2@example.com',
      password: 'hashedpassword123'
    });
    console.log('Created TestUser2:', user2._id);
  }
  
  // Create test call
  const callStartedAt = new Date();
  const call = await Call.create({
    roomId: TEST_ROOM_ID,
    initiator: user1._id,
    callType: 'video',
    status: 'ended',
    participants: [
      {
        user: user1._id,
        mode: 'video',
        joinedAt: callStartedAt,
        leftAt: new Date(callStartedAt.getTime() + 120000), // 2 minutes later
        duration: 120
      },
      {
        user: user2._id,
        mode: 'video',
        joinedAt: callStartedAt,
        leftAt: new Date(callStartedAt.getTime() + 120000),
        duration: 120
      }
    ],
    startedAt: callStartedAt,
    endedAt: new Date(callStartedAt.getTime() + 120000)
  });
  
  console.log('Created test call:', call.roomId);
  
  // Create test transcript segments
  const segments = [
    {
      roomId: TEST_ROOM_ID,
      callId: TEST_ROOM_ID,
      call: call._id,
      participantId: String(user1._id),
      userId: user1._id,
      user: user1._id,
      speakerName: 'TestUser1',
      startTimeMs: 4000,
      endTimeMs: 7000,
      text: 'We need to finish this project today.',
      language: 'en'
    },
    {
      roomId: TEST_ROOM_ID,
      callId: TEST_ROOM_ID,
      call: call._id,
      participantId: String(user2._id),
      userId: user2._id,
      user: user2._id,
      speakerName: 'TestUser2',
      startTimeMs: 8000,
      endTimeMs: 11000,
      text: 'Yes, I will work on the backend.',
      language: 'en'
    },
    {
      roomId: TEST_ROOM_ID,
      callId: TEST_ROOM_ID,
      call: call._id,
      participantId: String(user1._id),
      userId: user1._id,
      user: user1._id,
      speakerName: 'TestUser1',
      startTimeMs: 12000,
      endTimeMs: 15000,
      text: 'Okay, let us continue.',
      language: 'en'
    },
    {
      roomId: TEST_ROOM_ID,
      callId: TEST_ROOM_ID,
      call: call._id,
      participantId: String(user2._id),
      userId: user2._id,
      user: user2._id,
      speakerName: 'TestUser2',
      startTimeMs: 16000,
      endTimeMs: 20000,
      text: 'I will push the changes tonight.',
      language: 'en'
    },
    {
      roomId: TEST_ROOM_ID,
      callId: TEST_ROOM_ID,
      call: call._id,
      participantId: String(user1._id),
      userId: user1._id,
      user: user1._id,
      speakerName: 'TestUser1',
      startTimeMs: 21000,
      endTimeMs: 24000,
      text: 'Perfect, thank you!',
      language: 'en'
    }
  ];
  
  for (const segmentData of segments) {
    await TranscriptSegment.create(segmentData);
  }
  
  console.log(`Created ${segments.length} test transcript segments`);
  
  return { call, user1, user2 };
}

async function testTranscriptGeneration() {
  console.log('\n=== Testing Transcript Generation ===\n');
  
  const result = await transcriptFileGenerator.finalizeTranscript(TEST_ROOM_ID);
  
  if (result.success) {
    console.log('✅ Transcript generated successfully!');
    console.log('   File path:', result.txtPath);
    
    // Read and display the file
    const fs = require('fs').promises;
    const content = await fs.readFile(result.txtPath, 'utf8');
    
    console.log('\n=== Generated Transcript Content ===\n');
    console.log(content);
    console.log('\n=== End of Transcript ===\n');
    
    // Verify Call document updated
    const call = await Call.findOne({ roomId: TEST_ROOM_ID });
    console.log('\n=== Call Document Transcript Status ===');
    console.log('Status:', call.transcript.status);
    console.log('TXT Path:', call.transcript.txtPath);
    console.log('Completed At:', call.transcript.completedAt);
    
    if (call.transcript.status === 'completed' && call.transcript.txtPath) {
      console.log('\n✅ All tests passed!');
      return true;
    } else {
      console.log('\n❌ Call document not updated correctly');
      return false;
    }
  } else {
    console.log('❌ Transcript generation failed');
    console.log('   Error:', result.error);
    return false;
  }
}

async function cleanup() {
  console.log('\n=== Cleaning Up Test Data ===\n');
  
  await TranscriptSegment.deleteMany({ roomId: TEST_ROOM_ID });
  console.log('Deleted transcript segments');
  
  await Call.deleteOne({ roomId: TEST_ROOM_ID });
  console.log('Deleted test call');
  
  // Optional: Delete test users (commented out to avoid disrupting other tests)
  // await User.deleteMany({ username: { $in: ['TestUser1', 'TestUser2'] } });
  // console.log('Deleted test users');
  
  console.log('Cleanup complete');
}

async function main() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');
    
    // Create test data
    await createTestData();
    
    // Test transcript generation
    const success = await testTranscriptGeneration();
    
    // Cleanup
    await cleanup();
    
    if (success) {
      console.log('\n🎉 All tests completed successfully!\n');
      process.exit(0);
    } else {
      console.log('\n⚠️  Some tests failed. Check output above.\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Test error:', error);
    process.exit(1);
  }
}

// Run tests
main();
