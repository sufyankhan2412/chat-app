// Shared between Callcontext.jsx (1:1 calls) and GroupCallContext.jsx

export const CALL_AUDIO_CHUNK_MS = 10000;

export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  // This one microphone stream is used for both the LIVE call and the
  // cloned transcription track. Keep browser voice processing enabled
  // for the live path: it suppresses microphone hiss and room noise and
  // prevents the voice level from pumping into repeated popping sounds.
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};