/**
 * Test script for automatic Google Calendar sync functionality
 * 
 * This simulates what happens when a call ends:
 * 1. Transcript is generated
 * 2. Action items are extracted
 * 3. Action items are automatically synced to all participants' calendars
 */

const mongoose = require('mongoose');
const Call = require('./models/Call');
const User = require('./models/User');
const TranscriptSegment = require('./models/TranscriptSegment');
const transcriptFileGenerator = require('./services/TranscriptFileGenerator');

require('dotenv').config();

async function testAutoSync() {
  try {
    console.log('=== Testing Automatic Calendar Sync ===\n');
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected!\n');

    // Find a recent call with action items
    const callWithActions = await Call.findOne({
      'transcript.actionItems': { $exists: true, $ne: [], $not: { $size: 0 } }
    })
      .sort({ startedAt: -1 })
      .select('roomId transcript participants initiator startedAt')
      .populate('participants.user', 'username email googleCalendar.connected')
      .populate('initiator', 'username email googleCalendar.connected');

    if (callWithActions) {
      console.log('✅ Found call with action items:', callWithActions.roomId);
      console.log('Action items count:', callWithActions.transcript.actionItems.length);
      console.log('');

      // Check participants
      console.log('Participants:');
      const participantIds = new Set();
      
      if (callWithActions.initiator) {
        participantIds.add(String(callWithActions.initiator._id));
        console.log(`  - ${callWithActions.initiator.username} (initiator)`);
        console.log(`    Calendar: ${callWithActions.initiator.googleCalendar?.connected ? '✅ Connected' : '❌ Not connected'}`);
      }
      
      callWithActions.participants.forEach(p => {
        if (p.user) {
          participantIds.add(String(p.user._id));
          console.log(`  - ${p.user.username}`);
          console.log(`    Calendar: ${p.user.googleCalendar?.connected ? '✅ Connected' : '❌ Not connected'}`);
        }
      });
      
      console.log('\nAction items that were extracted:');
      callWithActions.transcript.actionItems.forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.priority}] ${item.task}`);
        console.log(`     Owner: ${item.owner}, Deadline: ${item.deadline}`);
      });
    } else {
      console.log('⚠️  No calls with action items found');
    }

    console.log('\n');
    
    // Show all users with calendar connected
    const usersWithCalendar = await User.find({ 'googleCalendar.connected': true })
      .select('username email googleCalendar');
    
    console.log('=== Users with Google Calendar Connected ===');
    if (usersWithCalendar.length === 0) {
      console.log('❌ No users have connected their Google Calendar yet');
      console.log('\nTo test auto-sync:');
      console.log('1. Go to Settings in the frontend');
      console.log('2. Click "Connect Google Calendar"');
      console.log('3. Complete OAuth flow');
      console.log('4. Make a new call with actionable conversation');
      console.log('5. Action items will automatically sync to your calendar');
    } else {
      usersWithCalendar.forEach(user => {
        console.log(`\n✅ ${user.username} (${user.email})`);
        console.log(`   Calendar email: ${user.googleCalendar.email}`);
        console.log(`   Connected: ${user.googleCalendar.connectedAt}`);
        console.log(`   Token expiry: ${user.googleCalendar.tokenExpiry}`);
        
        const isExpired = user.googleCalendar.tokenExpiry && 
                         new Date(user.googleCalendar.tokenExpiry) < new Date();
        if (isExpired) {
          console.log('   ⚠️  Token expired - user needs to reconnect');
        }
      });
    }

    console.log('\n\n=== How Auto-Sync Works ===');
    console.log('1. When a call ends, transcription begins');
    console.log('2. AI extracts action items from the transcript');
    console.log('3. For each participant with Google Calendar connected:');
    console.log('   - Creates calendar events for all action items');
    console.log('   - Sets event date based on deadline');
    console.log('   - Sets event color based on priority');
    console.log('   - Adds reminders (1 hour & 1 day before)');
    console.log('4. All happens automatically - no manual button needed!');

    console.log('\n\n=== Testing New Call with Auto-Sync ===');
    console.log('To test the complete flow:');
    console.log('');
    console.log('1. Make sure at least one user has calendar connected (check above)');
    console.log('2. Start a call with that user');
    console.log('3. Have a conversation with action items, like:');
    console.log('   "John, please finalize the report by Friday."');
    console.log('   "Sarah will review it next Monday."');
    console.log('4. End the call');
    console.log('5. Wait ~30 seconds for transcript processing');
    console.log('6. Check backend logs for:');
    console.log('   [TranscriptFileGenerator] Auto-syncing action items to Google Calendar...');
    console.log('   [TranscriptFileGenerator] ✅ Synced X action items for user: ...');
    console.log('7. Open Google Calendar - you should see new events!');

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

testAutoSync();
