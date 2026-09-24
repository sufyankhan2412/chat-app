/**
 * AI Agent Service
 * 
 * Uses Groq's LLM to extract action items, deadlines, and priorities
 * from meeting transcripts. This provides intelligent post-meeting analysis
 * to help users track what needs to be done.
 * 
 * Two-step AI chain:
 * 1. Groq Whisper → Transcription (already done in TranscriptionWorker)
 * 2. Groq LLM (llama/mixtral) → Action item extraction (this service)
 * 
 * All using free-tier Groq APIs.
 */

const axios = require('axios');
const fs = require('fs').promises;

const GROQ_CHAT_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 30000; // 30 second timeout

// Load from environment at runtime, not at module load time
function getGroqApiKey() {
  return process.env.GROQ_API_KEY;
}

function getGroqLlmModel() {
  return process.env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b';
}

/**
 * System prompt for action item extraction
 */
const SYSTEM_PROMPT = `You are an expert meeting analyst. Your job is to extract actionable items, deadlines, and priorities from meeting transcripts.

Analyze the transcript and identify:
1. **Action Items**: Clear tasks that need to be done (who, what, when)
2. **Deadlines**: Any time-sensitive commitments or due dates
3. **Priorities**: Importance level (High/Medium/Low)
4. **Owners**: Who is responsible for each action

Return your analysis as a JSON object with this structure:
{
  "actionItems": [
    {
      "task": "Brief description of the task",
      "owner": "Person responsible (name from transcript)",
      "deadline": "Extracted deadline or 'Not specified'",
      "priority": "High|Medium|Low",
      "context": "Brief context from the conversation"
    }
  ],
  "keyDecisions": [
    "Important decision 1",
    "Important decision 2"
  ],
  "nextSteps": [
    "Overall next step 1",
    "Overall next step 2"
  ],
  "summary": "2-3 sentence summary of the meeting"
}

Guidelines:
- Only extract EXPLICIT action items, not assumptions
- Deadline format: "YYYY-MM-DD" if specific date mentioned, "Next week/month" if relative, "Not specified" if unclear
- Priority based on: urgency words (ASAP, urgent, critical), discussion time, speaker emphasis
- If no action items found, return empty arrays but still provide summary
- Be concise but informative`;

/**
 * Extract action items from a transcript using Groq LLM
 * 
 * @param {string} transcriptText - The full transcript text
 * @param {Object} options - Optional parameters
 * @returns {Promise<Object>} Extracted action items and analysis
 */
async function extractActionItems(transcriptText, options = {}) {
  const GROQ_API_KEY = getGroqApiKey();
  const GROQ_LLM_MODEL = getGroqLlmModel();
  
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const {
    temperature = 0.3, // Lower temperature for more consistent extraction
    maxTokens = 2000
  } = options;

  try {
    console.log('[AIAgentService] Extracting action items from transcript...', {
      transcriptLength: transcriptText.length,
      model: GROQ_LLM_MODEL
    });

    const startTime = Date.now();

    const response = await axios.post(
      GROQ_CHAT_API_URL,
      {
        model: GROQ_LLM_MODEL,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: `Analyze this meeting transcript and extract action items:\n\n${transcriptText}`
          }
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' } // Ensure JSON response
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: GROQ_TIMEOUT_MS
      }
    );

    const processingTime = Date.now() - startTime;

    if (!response.data?.choices?.[0]?.message?.content) {
      throw new Error('Invalid response from Groq LLM');
    }

    const content = response.data.choices[0].message.content;
    let analysis;

    try {
      analysis = JSON.parse(content);
    } catch (parseError) {
      console.error('[AIAgentService] Failed to parse LLM response as JSON:', content);
      throw new Error('LLM returned invalid JSON');
    }

    // Validate structure
    if (!analysis.actionItems || !Array.isArray(analysis.actionItems)) {
      analysis.actionItems = [];
    }
    if (!analysis.keyDecisions || !Array.isArray(analysis.keyDecisions)) {
      analysis.keyDecisions = [];
    }
    if (!analysis.nextSteps || !Array.isArray(analysis.nextSteps)) {
      analysis.nextSteps = [];
    }
    if (!analysis.summary) {
      analysis.summary = 'No summary available';
    }

    console.log('[AIAgentService] Action items extracted successfully:', {
      actionItemCount: analysis.actionItems.length,
      keyDecisionCount: analysis.keyDecisions.length,
      processingTimeMs: processingTime,
      model: getGroqLlmModel()
    });

    return {
      success: true,
      analysis,
      metadata: {
        model: getGroqLlmModel(),
        processingTimeMs: processingTime,
        transcriptLength: transcriptText.length,
        extractedAt: new Date()
      }
    };

  } catch (error) {
    console.error('[AIAgentService] Action item extraction failed:', {
      error: error.message,
      response: error.response?.data,
      status: error.response?.status
    });

    // Return graceful fallback
    return {
      success: false,
      analysis: {
        actionItems: [],
        keyDecisions: [],
        nextSteps: [],
        summary: 'Action item extraction failed. Please review transcript manually.'
      },
      error: error.message,
      metadata: {
        model: getGroqLlmModel(),
        extractedAt: new Date()
      }
    };
  }
}

/**
 * Extract action items from a transcript file
 * 
 * @param {string} filePath - Path to the transcript .txt file
 * @returns {Promise<Object>} Extracted action items
 */
async function extractActionItemsFromFile(filePath) {
  try {
    const transcriptText = await fs.readFile(filePath, 'utf8');
    
    // Remove header/footer formatting to focus on actual conversation
    const cleanedText = transcriptText
      .replace(/={40,}/g, '') // Remove separator lines
      .replace(/CALL TRANSCRIPT/g, '')
      .replace(/END OF TRANSCRIPT/g, '')
      .replace(/Call ID:.*?\n/g, '')
      .replace(/Date:.*?\n/g, '')
      .replace(/Duration:.*?\n/g, '')
      .replace(/Participants:.*?\n/g, '')
      .trim();

    return await extractActionItems(cleanedText);
  } catch (error) {
    console.error('[AIAgentService] Failed to read transcript file:', error.message);
    throw error;
  }
}

/**
 * Generate a natural language summary of action items for quick review
 * 
 * @param {Object} analysis - The analysis result from extractActionItems
 * @returns {string} Human-readable summary
 */
function generateActionItemSummary(analysis) {
  if (!analysis.actionItems || analysis.actionItems.length === 0) {
    return 'No action items identified in this meeting.';
  }

  const lines = [];
  lines.push(`📋 **${analysis.actionItems.length} Action Item${analysis.actionItems.length > 1 ? 's' : ''}**\n`);

  analysis.actionItems.forEach((item, index) => {
    const priority = item.priority === 'High' ? '🔴' : item.priority === 'Medium' ? '🟡' : '🟢';
    lines.push(`${index + 1}. ${priority} ${item.task}`);
    if (item.owner && item.owner !== 'Not specified') {
      lines.push(`   👤 ${item.owner}`);
    }
    if (item.deadline && item.deadline !== 'Not specified') {
      lines.push(`   ⏰ ${item.deadline}`);
    }
    lines.push('');
  });

  if (analysis.keyDecisions && analysis.keyDecisions.length > 0) {
    lines.push(`\n💡 **Key Decisions**`);
    analysis.keyDecisions.forEach(decision => {
      lines.push(`• ${decision}`);
    });
  }

  return lines.join('\n');
}

/**
 * Parse natural language deadline into structured date
 * 
 * @param {string} deadline - Natural language deadline from transcript
 * @returns {Date|null} Parsed date or null if can't parse
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
 * Generate Google Calendar quick add link
 * (No OAuth needed - uses public quick add URL)
 * 
 * @param {Object} actionItem - The action item to add to calendar
 * @returns {string} Google Calendar quick add URL
 */
function generateCalendarLink(actionItem) {
  const deadline = parseDeadline(actionItem.deadline);
  let dateStr = '';
  
  if (deadline) {
    // Format as YYYYMMDD for Google Calendar
    const year = deadline.getFullYear();
    const month = String(deadline.getMonth() + 1).padStart(2, '0');
    const day = String(deadline.getDate()).padStart(2, '0');
    dateStr = `${year}${month}${day}`;
  }

  const title = actionItem.task;
  const details = [
    actionItem.context || '',
    actionItem.owner ? `Assigned to: ${actionItem.owner}` : '',
    `Priority: ${actionItem.priority}`
  ].filter(Boolean).join('\n');

  // Use Google Calendar quick add URL (no OAuth required)
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    details: details,
    ...(dateStr && { dates: `${dateStr}/${dateStr}` })
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Check if the service is available
 */
function isAvailable() {
  return Boolean(getGroqApiKey());
}

/**
 * Get current configuration
 */
function getConfig() {
  return {
    model: getGroqLlmModel(),
    isConfigured: Boolean(getGroqApiKey()),
    timeout: GROQ_TIMEOUT_MS
  };
}

module.exports = {
  extractActionItems,
  extractActionItemsFromFile,
  generateActionItemSummary,
  parseDeadline,
  generateCalendarLink,
  isAvailable,
  getConfig
};
