/**
 * Transcription Worker
 * 
 * Handles real-time audio processing during calls:
 * 1. Collects audio chunks from uploads
 * 2. Applies VAD (Voice Activity Detection) - silence detection
 * 3. Sends speech segments to Groq Whisper
 * 4. Emits live transcript segments via Socket.IO
 * 
 * This runs DURING the call for live transcription.
 * Post-call processing still uses Transcriptionservice.js
 */

const fs = require('fs');
const path = require('path');
const groqService = require('./GroqTranscriptionService');
const TranscriptSegment = require('../models/TranscriptSegment');
const Call = require('../models/Call');
const User = require('../models/User');

// Configuration from environment
const TRANSCRIPTION_SAMPLE_RATE = parseInt(process.env.TRANSCRIPTION_SAMPLE_RATE || '16000', 10);
const TRANSCRIPTION_CHANNELS = parseInt(process.env.TRANSCRIPTION_CHANNELS || '1', 10);
const TRANSCRIPTION_CHUNK_MAX_MS = parseInt(process.env.TRANSCRIPTION_CHUNK_MAX_MS || '8000', 10);
const TRANSCRIPTION_VAD_SILENCE_MS = parseInt(process.env.TRANSCRIPTION_VAD_SILENCE_MS || '500', 10);
const TRANSCRIPTION_ENABLED = process.env.TRANSCRIPTION_ENABLED !== 'false'; // Default true
const TRANSCRIPTION_SILENCE_THRESHOLD = parseFloat(process.env.TRANSCRIPTION_SILENCE_THRESHOLD || '0.01');

// Active transcription sessions
// Map<roomId, Map<participantKey, Session>>
const activeSessions = new Map();

/**
 * Session structure for one participant in one call
 */
class TranscriptionSession {
  constructor({ roomId, userId, userName, joinedAtMs, callStartedAt, io }) {
    this.roomId = roomId;
    this.userId = userId;
    this.userName = userName;
    this.joinedAtMs = joinedAtMs;
    this.callStartedAt = callStartedAt;
    this.io = io;
    
    // Buffer for collecting PCM chunks
    this.audioBuffer = [];
    this.bufferedDurationMs = 0;
    this.processingPromise = Promise.resolve();
    
    // Sequence tracking
    this.lastProcessedSeq = -1;
    this.pendingChunks = new Map(); // seq -> chunkData
    
    console.log('[TranscriptionWorker] Session started:', {
      roomId,
      userId,
      userName,
      joinedAtMs
    });
  }

  /**
   * Add a new audio chunk to this session
   * Chunks may arrive out of order, so we buffer and sort
   */
  async addChunk(chunkData) {
    const { seq, pcmBuffer, sampleRate, timestamp } = chunkData;
    
    // Store pending chunk
    this.pendingChunks.set(seq, { pcmBuffer, sampleRate, timestamp });
    
    // Process chunks in order
    this.processingPromise = this.processingPromise
      .then(() => this.processOrderedChunks())
      .catch((error) => console.error('[TranscriptionWorker] Queue failed:', error.message));
    return this.processingPromise;
  }

  /**
   * Process chunks in sequence order, handling out-of-order arrival
   */
  async processOrderedChunks() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Process all consecutive chunks starting from lastProcessedSeq + 1
      let nextSeq = this.lastProcessedSeq + 1;
      
      while (this.pendingChunks.has(nextSeq)) {
        const chunk = this.pendingChunks.get(nextSeq);
        await this.processChunk(chunk);
        this.pendingChunks.delete(nextSeq);
        this.lastProcessedSeq = nextSeq;
        nextSeq++;
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Calculate RMS (Root Mean Square) audio level
   * Returns a value between 0 (silence) and 1 (max volume)
   */
  calculateAudioLevel(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length === 0) return 0;
    
    // PCM buffer is Int16 samples
    let sumSquares = 0;
    const view = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    
    for (let i = 0; i < view.length; i++) {
      const sample = view[i] / 32768.0; // Normalize to -1 to 1
      sumSquares += sample * sample;
    }
    
    const rms = Math.sqrt(sumSquares / view.length);
    return rms;
  }

  /**
   * Process a single audio chunk
   */
  async processChunk({ pcmBuffer, sampleRate, timestamp }) {
    // Check audio level to filter out silence and background noise
    const audioLevel = this.calculateAudioLevel(pcmBuffer);
    
    if (audioLevel < TRANSCRIPTION_SILENCE_THRESHOLD) {
      // Skip silent chunks - don't transcribe background noise
      console.log('[TranscriptionWorker] Skipping silent chunk:', {
        roomId: this.roomId,
        userId: this.userId,
        audioLevel: audioLevel.toFixed(4),
        threshold: TRANSCRIPTION_SILENCE_THRESHOLD
      });
      return;
    }
    
    // Add to buffer
    this.audioBuffer.push(pcmBuffer);
    
    // Calculate duration (16-bit PCM = 2 bytes per sample)
      const samples = pcmBuffer.length / 2; // Calculate number of samples
      const durationMs = (samples / sampleRate) * 1000; // Calculate duration in milliseconds
      const chunkStartTimeMs = Number(timestamp?.startTimeMs);
      const chunkEndTimeMs = Number(timestamp?.endTimeMs);
      if (Number.isFinite(chunkStartTimeMs)) {
        this.currentChunkStartMs = this.currentChunkStartMs == null
          ? chunkStartTimeMs
          : Math.min(this.currentChunkStartMs, chunkStartTimeMs);
      }
      if (Number.isFinite(chunkEndTimeMs)) {
        this.currentChunkEndMs = this.currentChunkEndMs == null
          ? chunkEndTimeMs
          : Math.max(this.currentChunkEndMs, chunkEndTimeMs);
      }
    this.bufferedDurationMs += durationMs;
    
    // VAD and chunk boundaries are decided in the browser. Transcribe each
    // short speech chunk promptly; the max duration remains a guard for any
    // unexpectedly large client payload.
    if (this.bufferedDurationMs >= TRANSCRIPTION_CHUNK_MAX_MS || timestamp) {
      await this.transcribeBuffer();
    }
  }

  /**
   * Transcribe the current audio buffer using Groq
   */
  async transcribeBuffer() {
    if (this.audioBuffer.length === 0) return;
    
    try {
      // Combine all PCM buffers
      const combinedPcm = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      const bufferedMs = this.bufferedDurationMs;
      const firstChunk = this.currentChunkStartMs;
      const lastChunk = this.currentChunkEndMs;
      this.bufferedDurationMs = 0;
      this.currentChunkStartMs = null;
      this.currentChunkEndMs = null;
      
      // Convert PCM to WAV (in memory)
      const wavBuffer = this.pcmToWavBuffer(combinedPcm, TRANSCRIPTION_SAMPLE_RATE);
      
      // Send to Groq
      console.log('[TranscriptionWorker] Transcribing:', {
        roomId: this.roomId,
        userId: this.userId,
        size: wavBuffer.length,
        durationMs: bufferedMs
      });
      
      const result = await groqService.transcribeAudio(wavBuffer, {
        language: process.env.TRANSCRIPTION_LANGUAGE || 'en',
        timestamp: true,
        responseFormat: 'verbose_json',
        temperature: 0.0
      });
      
      // Process segments
      if (result.text && result.text.trim()) {
        await this.saveSegment({
          text: result.text.trim(),
          segments: result.segments,
          durationMs: bufferedMs,
          chunkStartTimeMs: firstChunk,
          chunkEndTimeMs: lastChunk,
          processingTimeMs: result.processingTimeMs,
          language: result.language
        });
      } else {
        console.log('[TranscriptionWorker] No speech detected in chunk:', {
          roomId: this.roomId,
          userId: this.userId
        });
      }
      
    } catch (error) {
      console.error('[TranscriptionWorker] Transcription failed:', {
        roomId: this.roomId,
        userId: this.userId,
        error: error.message
      });
      
      // Reset buffer on error
      this.audioBuffer = [];
      this.bufferedDurationMs = 0;
    }
  }

  /**
   * Save a transcript segment to database and emit via Socket.IO
   */
  async saveSegment({ text, segments, durationMs, chunkStartTimeMs, chunkEndTimeMs, processingTimeMs, language }) {
    try {
      // Groq timestamps are relative to this short speech chunk. The client
      // timestamp anchors that chunk on the shared server call timeline.
      const currentTime = Date.now();
      const fallbackStart = Number.isFinite(chunkStartTimeMs)
        ? chunkStartTimeMs
        : Math.max(0, currentTime - this.callStartedAt - durationMs);
      const fallbackEnd = Number.isFinite(chunkEndTimeMs)
        ? chunkEndTimeMs
        : fallbackStart + durationMs;
      
      // Use Groq's segment timing if available, otherwise estimate
      let startTimeMs, endTimeMs;
      if (segments && segments.length > 0) {
        startTimeMs = fallbackStart + (segments[0].start * 1000);
        endTimeMs = fallbackStart + (segments[segments.length - 1].end * 1000);
      } else {
        startTimeMs = fallbackStart;
        endTimeMs = fallbackEnd;
      }
      startTimeMs = Math.max(0, Math.round(startTimeMs));
      endTimeMs = Math.max(startTimeMs, Math.round(endTimeMs));
      
      // Get call document
      const call = await Call.findOne({ roomId: this.roomId });
      if (!call) {
        console.warn('[TranscriptionWorker] Call not found:', this.roomId);
        return;
      }
      
      // Save segment
      const speaker = await User.findById(this.userId).select('username').lean();
      const speakerName = speaker?.username || this.userName || String(this.userId);
      const segment = await TranscriptSegment.create({
        roomId: this.roomId,
        callId: this.roomId,
        call: call._id,
        participantId: this.userId,
        userId: this.userId,
        user: this.userId,
        speakerName,
        startTimeMs,
        endTimeMs,
        text,
        language,
        processingTimeMs
      });
      
      console.log('[TranscriptionWorker] Segment saved:', {
        roomId: this.roomId,
        userId: this.userId,
        text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
        startTimeMs,
        endTimeMs
      });
      
      // Live transcript emission removed - segments are accumulated in MongoDB
      // and compiled into a downloadable .txt file after the call ends
      
    } catch (error) {
      console.error('[TranscriptionWorker] Failed to save segment:', {
        roomId: this.roomId,
        userId: this.userId,
        error: error.message
      });
    }
  }

  /**
   * Convert PCM buffer to WAV format (in memory)
   */
  pcmToWavBuffer(pcmBuffer, sampleRate, numChannels = 1, bitsPerSample = 16) {
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcmBuffer.length, 40);
    
    return Buffer.concat([header, pcmBuffer]);
  }

  /**
   * Flush remaining audio buffer
   */
  async flush() {
    if (this.audioBuffer.length > 0) {
      console.log('[TranscriptionWorker] Flushing remaining audio:', {
        roomId: this.roomId,
        userId: this.userId,
        chunks: this.audioBuffer.length
      });
      
      await this.transcribeBuffer();
    }
  }

  /**
   * Clean up session
   */
  destroy() {
    this.audioBuffer = [];
    this.bufferedDurationMs = 0;
    this.pendingChunks.clear();
    
    console.log('[TranscriptionWorker] Session destroyed:', {
      roomId: this.roomId,
      userId: this.userId
    });
  }
}

/**
 * Start a transcription session for a participant
 */
function startSession({ roomId, userId, userName, joinedAtMs, callStartedAt, io }) {
  if (!TRANSCRIPTION_ENABLED || !groqService.isAvailable()) {
    console.log('[TranscriptionWorker] Transcription disabled or Groq not configured');
    return null;
  }
  
  if (!activeSessions.has(roomId)) {
    activeSessions.set(roomId, new Map());
  }
  
  const room = activeSessions.get(roomId);
  const participantKey = `${userId}-${joinedAtMs}`;
  
  if (room.has(participantKey)) {
    console.warn('[TranscriptionWorker] Session already exists:', participantKey);
    return room.get(participantKey);
  }
  
  const session = new TranscriptionSession({
    roomId,
    userId,
    userName,
    joinedAtMs,
    callStartedAt,
    io
  });
  
  room.set(participantKey, session);
  return session;
}

/**
 * Add audio chunk to a participant's session
 */
async function addAudioChunk({ roomId, userId, joinedAtMs, seq, pcmBuffer, sampleRate, timestamp }) {
  const room = activeSessions.get(roomId);
  if (!room) return;
  
  const participantKey = `${userId}-${joinedAtMs}`;
  const session = room.get(participantKey);
  if (!session) return;
  
  await session.addChunk({ seq, pcmBuffer, sampleRate, timestamp });
}

/**
 * End a transcription session for a participant
 */
async function endSession({ roomId, userId, joinedAtMs }) {
  const room = activeSessions.get(roomId);
  if (!room) return;
  
  const participantKey = `${userId}-${joinedAtMs}`;
  const session = room.get(participantKey);
  if (!session) return;
  
  await session.processingPromise;
  await session.flush();
  session.destroy();
  room.delete(participantKey);
  
  // Clean up empty rooms
  if (room.size === 0) {
    activeSessions.delete(roomId);
  }
}

/**
 * End all sessions for a room
 */
async function endRoom(roomId) {
  const room = activeSessions.get(roomId);
  if (!room) return;
  
  const sessions = Array.from(room.values());
  await Promise.all(sessions.map(async (session) => {
    await session.processingPromise;
    await session.flush();
  }));
  
  sessions.forEach(session => session.destroy());
  activeSessions.delete(roomId);
  
  console.log('[TranscriptionWorker] Room ended:', roomId);
}

/**
 * Get active sessions count
 */
function getStats() {
  let totalSessions = 0;
  activeSessions.forEach(room => {
    totalSessions += room.size;
  });
  
  return {
    activeRooms: activeSessions.size,
    activeSessions: totalSessions,
    groqConfigured: groqService.isAvailable()
  };
}

module.exports = {
  startSession,
  addAudioChunk,
  endSession,
  endRoom,
  getStats
};
