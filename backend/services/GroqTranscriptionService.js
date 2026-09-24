/**
 * Groq Whisper Transcription Service
 * 
 * Replaces whisper.cpp for LIVE transcription during calls.
 * Post-call processing still uses whisper.cpp (Transcriptionservice.js)
 * for the final, post-processed historical transcript.
 */

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

if (!GROQ_API_KEY) {
  console.warn(
    '[GroqTranscriptionService] GROQ_API_KEY is not set. ' +
    'Live transcription will fail. Set it in backend/.env'
  );
}

/**
 * Transcribe an audio buffer using Groq Whisper API
 * 
 * @param {Buffer} audioBuffer - Audio file buffer (WAV, MP3, etc.)
 * @param {Object} options - Transcription options
 * @param {string} options.language - Language code (e.g. 'en', 'es', 'auto')
 * @param {boolean} options.timestamp - Enable word-level timestamps
 * @param {string} options.responseFormat - 'json' | 'verbose_json' | 'text'
 * @param {number} options.temperature - Sampling temperature (0-1)
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeAudio(audioBuffer, options = {}) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const {
    language = 'en',
    timestamp = true,
    responseFormat = 'verbose_json',
    temperature = 0.0,
    prompt = '' // Optional context/previous text to improve accuracy
  } = options;

  try {
    const formData = new FormData();
    
    // Groq expects a file with extension
    formData.append('file', audioBuffer, {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    
    formData.append('model', GROQ_TRANSCRIPTION_MODEL);
    formData.append('response_format', responseFormat);
    formData.append('temperature', temperature.toString());
    
    if (language !== 'auto') {
      formData.append('language', language);
    }
    
    if (timestamp) {
      formData.append('timestamp_granularities[]', 'segment');
    }
    
    if (prompt) {
      formData.append('prompt', prompt);
    }

    const startTime = Date.now();
    
    const response = await axios.post(GROQ_API_URL, formData, {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 30000 // 30 second timeout
    });

    const processingTime = Date.now() - startTime;

    // Parse response based on format
    if (responseFormat === 'text') {
      return {
        text: response.data,
        language: null,
        segments: [],
        processingTimeMs: processingTime
      };
    }

    // verbose_json or json format
    const result = response.data;
    
    return {
      text: result.text || '',
      language: result.language || language,
      segments: result.segments || [],
      duration: result.duration || null,
      processingTimeMs: processingTime
    };

  } catch (error) {
    console.error('[GroqTranscriptionService] Transcription failed:', {
      error: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    
    throw new Error(
      `Groq transcription failed: ${error.response?.data?.error?.message || error.message}`
    );
  }
}

/**
 * Transcribe an audio file from disk
 * 
 * @param {string} filePath - Path to audio file
 * @param {Object} options - Transcription options
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeFile(filePath, options = {}) {
  try {
    const audioBuffer = await fs.promises.readFile(filePath);
    return await transcribeAudio(audioBuffer, options);
  } catch (error) {
    console.error('[GroqTranscriptionService] File transcription failed:', error.message);
    throw error;
  }
}

/**
 * Check if Groq service is available
 * 
 * @returns {boolean}
 */
function isAvailable() {
  return Boolean(GROQ_API_KEY);
}

/**
 * Get current configuration
 * 
 * @returns {Object}
 */
function getConfig() {
  return {
    model: GROQ_TRANSCRIPTION_MODEL,
    isConfigured: Boolean(GROQ_API_KEY),
    apiUrl: GROQ_API_URL
  };
}

module.exports = {
  transcribeAudio,
  transcribeFile,
  isAvailable,
  getConfig
};
