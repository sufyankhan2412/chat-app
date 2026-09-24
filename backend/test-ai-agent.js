/**
 * Test Script for AI Action Item Extraction
 * 
 * Tests the Groq LLM-powered action item extraction from transcripts.
 * 
 * Usage:
 *   node test-ai-agent.js
 */

require('dotenv').config();
const aiAgentService = require('./services/AIAgentService');

// Sample meeting transcript for testing
const SAMPLE_TRANSCRIPT = `
[00:00:04 - 00:00:07] Sufyan Khan:
We need to finish this project today.

[00:00:08 - 00:00:11] Ahmed Ali:
Yes, I'll work on the backend.

[00:00:12 - 00:00:15] Sufyan Khan:
Okay, let's continue. Can you deploy the API changes by end of day?

[00:00:16 - 00:00:20] Ahmed Ali:
Absolutely. I'll push the changes tonight and deploy to production.

[00:00:21 - 00:00:27] Sufyan Khan:
Perfect. I'll review the frontend code and update the documentation by tomorrow morning.

[00:00:28 - 00:00:33] Ahmed Ali:
Sounds good. We should schedule a client demo for next Friday to showcase the new features.

[00:00:34 - 00:00:39] Sufyan Khan:
Great idea. I'll send out the calendar invite today. This is a high priority.

[00:00:40 - 00:00:45] Ahmed Ali:
Also, can you check the database backup script? It failed last night.

[00:00:46 - 00:00:50] Sufyan Khan:
Will do. I'll investigate and fix it this afternoon.
`;

async function testActionItemExtraction() {
  console.log('\n=== Testing AI Action Item Extraction ===\n');
  
  // Check if Groq API is configured
  if (!aiAgentService.isAvailable()) {
    console.error('❌ GROQ_API_KEY is not configured in .env file');
    process.exit(1);
  }
  
  const config = aiAgentService.getConfig();
  console.log('Configuration:');
  console.log(`  Model: ${config.model}`);
  console.log(`  Configured: ${config.isConfigured}`);
  console.log(`  Timeout: ${config.timeout}ms\n`);
  
  console.log('Sample Transcript:');
  console.log('--------------------------------------------------');
  console.log(SAMPLE_TRANSCRIPT);
  console.log('--------------------------------------------------\n');
  
  console.log('Extracting action items using Groq LLM...\n');
  
  const startTime = Date.now();
  const result = await aiAgentService.extractActionItems(SAMPLE_TRANSCRIPT);
  const elapsed = Date.now() - startTime;
  
  if (result.success) {
    console.log('✅ Extraction successful!\n');
    console.log(`Processing time: ${elapsed}ms\n`);
    
    console.log('=== EXTRACTED ANALYSIS ===\n');
    
    if (result.analysis.summary) {
      console.log('📝 MEETING SUMMARY:');
      console.log(result.analysis.summary);
      console.log('');
    }
    
    if (result.analysis.actionItems && result.analysis.actionItems.length > 0) {
      console.log(`📋 ACTION ITEMS (${result.analysis.actionItems.length}):`);
      console.log('');
      
      result.analysis.actionItems.forEach((item, index) => {
        const priorityEmoji = item.priority === 'High' ? '🔴' : item.priority === 'Medium' ? '🟡' : '🟢';
        console.log(`${index + 1}. ${priorityEmoji} ${item.task}`);
        console.log(`   👤 Owner: ${item.owner}`);
        console.log(`   ⏰ Deadline: ${item.deadline}`);
        console.log(`   ⭐ Priority: ${item.priority}`);
        if (item.context) {
          console.log(`   💬 Context: ${item.context}`);
        }
        
        // Test calendar link generation
        const calendarLink = aiAgentService.generateCalendarLink(item);
        console.log(`   📅 Calendar: ${calendarLink.substring(0, 80)}...`);
        console.log('');
      });
    }
    
    if (result.analysis.keyDecisions && result.analysis.keyDecisions.length > 0) {
      console.log('💡 KEY DECISIONS:');
      result.analysis.keyDecisions.forEach(decision => {
        console.log(`  • ${decision}`);
      });
      console.log('');
    }
    
    if (result.analysis.nextSteps && result.analysis.nextSteps.length > 0) {
      console.log('➡️  NEXT STEPS:');
      result.analysis.nextSteps.forEach(step => {
        console.log(`  • ${step}`);
      });
      console.log('');
    }
    
    // Test summary generation
    console.log('=== GENERATED SUMMARY ===\n');
    const summary = aiAgentService.generateActionItemSummary(result.analysis);
    console.log(summary);
    console.log('');
    
    console.log('=== METADATA ===');
    console.log(`Model: ${result.metadata.model}`);
    console.log(`Processing Time: ${result.metadata.processingTimeMs}ms`);
    console.log(`Transcript Length: ${result.metadata.transcriptLength} chars`);
    console.log(`Extracted At: ${result.metadata.extractedAt.toISOString()}`);
    console.log('');
    
    console.log('🎉 All tests passed!\n');
    process.exit(0);
  } else {
    console.log('❌ Extraction failed');
    console.log(`Error: ${result.error}\n`);
    
    console.log('Fallback analysis:');
    console.log(JSON.stringify(result.analysis, null, 2));
    console.log('');
    
    process.exit(1);
  }
}

// Run test
console.log('AI Agent Service Test');
console.log('====================\n');

testActionItemExtraction().catch(error => {
  console.error('\n❌ Test error:', error);
  process.exit(1);
});
