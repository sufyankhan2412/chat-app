/**
 * Regenerate action items for existing transcripts
 * 
 * Run this after fixing the AI extraction service to add action items
 * to calls that were processed before the fix.
 */

const mongoose = require('mongoose');
const fs = require('fs').promises;
const Call = require('./models/Call');
const aiAgentService = require('./services/AIAgentService');

require('dotenv').config();

async function regenerateActionItems() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected!\n');

    // Check if AI service is available
    if (!aiAgentService.isAvailable()) {
      console.error('❌ AI Agent service is not available. Check GROQ_API_KEY.');
      process.exit(1);
    }

    console.log('✅ AI Agent service is available');
    console.log('Model:', aiAgentService.getConfig().model);
    console.log('');

    // Get all calls with completed transcripts but no action items
    const calls = await Call.find({
      'transcript.status': 'completed',
      'transcript.txtPath': { $exists: true, $ne: null },
      $or: [
        { 'transcript.actionItems': { $exists: false } },
        { 'transcript.actionItems': { $size: 0 } }
      ]
    }).select('roomId transcript startedAt');

    console.log(`Found ${calls.length} calls needing action item extraction\n`);

    if (calls.length === 0) {
      console.log('No calls to process. All done!');
      return;
    }

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const call of calls) {
      processed++;
      console.log(`[${processed}/${calls.length}] Processing call: ${call.roomId}`);

      try {
        // Read the transcript file
        const transcriptPath = call.transcript.txtPath;
        const transcriptText = await fs.readFile(transcriptPath, 'utf8');

        // Remove header/footer formatting to focus on actual conversation
        const cleanedText = transcriptText
          .replace(/={40,}/g, '') // Remove separator lines
          .replace(/CALL TRANSCRIPT/g, '')
          .replace(/END OF TRANSCRIPT/g, '')
          .replace(/AI-EXTRACTED ACTION ITEMS/g, '')
          .replace(/Call ID:.*?\n/g, '')
          .replace(/Date:.*?\n/g, '')
          .replace(/Duration:.*?\n/g, '')
          .replace(/Participants:.*?\n/g, '')
          .trim();

        if (cleanedText.length < 50) {
          console.log('  ⚠️  Transcript too short, skipping');
          continue;
        }

        // Extract action items
        console.log('  🤖 Extracting action items...');
        const result = await aiAgentService.extractActionItems(cleanedText);

        if (result.success) {
          const analysis = result.analysis;
          const actionItemCount = analysis.actionItems?.length || 0;

          console.log(`  ✅ Extracted ${actionItemCount} action items`);

          // Add calendar links to each action item
          const itemsWithLinks = (analysis.actionItems || []).map(item => ({
            ...item,
            calendarLink: aiAgentService.generateCalendarLink(item)
          }));

          // Update the call document
          const update = {
            'transcript.actionItems': itemsWithLinks,
            'transcript.keyDecisions': analysis.keyDecisions || [],
            'transcript.nextSteps': analysis.nextSteps || [],
            'transcript.summary': analysis.summary || ''
          };

          await Call.updateOne({ _id: call._id }, { $set: update });

          // Append action items to the transcript file
          if (actionItemCount > 0) {
            const actionItemsSection = generateActionItemsSection(analysis);
            await fs.appendFile(transcriptPath, '\n\n' + actionItemsSection, 'utf8');
            console.log('  📝 Updated transcript file');
          }

          succeeded++;
        } else {
          console.log(`  ❌ Extraction failed: ${result.error}`);
          failed++;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`  ❌ Error processing call: ${error.message}`);
        failed++;
      }

      console.log('');
    }

    console.log('\n=== Summary ===');
    console.log(`Total processed: ${processed}`);
    console.log(`Succeeded: ${succeeded}`);
    console.log(`Failed: ${failed}`);

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

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

regenerateActionItems();
