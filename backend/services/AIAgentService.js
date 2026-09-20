const axios = require('axios');
require('dotenv').config();

/**
 * AI Agent Service - Connects to GPT-5.6-Luna via Experiential Gateway
 * This service sends codebase context to the AI agent and receives
 * structured instructions for code modifications.
 */

class AIAgentService {
  constructor() {
    this.baseURL = 'https://api.experientiallabs.ai/v1';
    this.apiKey = process.env.EXPLABS_API_KEY;
    this.model = 'gpt-5.6-luna';
    
    if (!this.apiKey) {
      throw new Error('EXPLABS_API_KEY not found in environment variables');
    }
  }

  /**
   * Sends a request to GPT-5.6-Luna with project context and requirements
   * @param {Object} params - Request parameters
   * @param {string} params.task - The task description
   * @param {string} params.context - Code context
   * @param {Array} params.files - Array of relevant files with content
   * @returns {Promise<Object>} AI response with instructions
   */
  async getInstructions({ task, context, files = [] }) {
    try {
      const systemPrompt = `You are an expert software architect analyzing a MERN stack chat application with WebRTC calling features.
Your role is to provide detailed, actionable instructions for implementing features and fixing bugs.

Project Stack:
- Backend: Node.js, Express, Socket.IO, MongoDB
- Frontend: React, Vite
- WebRTC for audio/video calls
- Real-time communication via Socket.IO

Provide instructions in this format:
1. Analysis of current implementation
2. Step-by-step changes needed (be specific with file paths and code changes)
3. Testing recommendations
4. Edge cases to consider`;

      const userPrompt = `TASK: ${task}

PROJECT CONTEXT:
${context}

RELEVANT FILES:
${files.map(f => `\n--- ${f.path} ---\n${f.content}`).join('\n\n')}

Please analyze the code and provide detailed instructions for implementing this task.`;

      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 4000
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        instructions: response.data.choices[0].message.content,
        usage: response.data.usage,
        model: response.data.model,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('AI Agent Service Error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Makes a simple test call to verify the API connection
   */
  async testConnection() {
    try {
      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'user', content: 'Hello, please respond with "Connection successful"' }
          ],
          max_tokens: 50
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        message: response.data.choices[0].message.content,
        usage: response.data.usage,
        model: response.data.model
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }
}

module.exports = new AIAgentService();
