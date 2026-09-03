// Shared between Callcontext.jsx (1:1 calls) and GroupCallContext.jsx
// (group calls) — both run their own independent recording session
// against the same backend upload/combine/transcribe pipeline (see
// pcmRecorder.js), so their capture settings must never drift apart.

// 10s rolling chunks: fewer/larger uploads while still keeping a crash/
// closed-tab from losing more than the last ~10s (see startRecording in
// both contexts).
export const CALL_AUDIO_CHUNK_MS = 10000;

// getUserMedia audio constraints for the WebRTC CALL stream (Stream A).
//
// This stream is used ONLY for the live WebRTC peer connection — it is
// never passed to the recording pipeline. echoCancellation and
// autoGainControl stay on so that participants on speakers hear each
// other cleanly and at a reasonable level. noiseSuppression stays off
// because it's a black-box spectral filter tuned for perceptual
// pleasantness at the cost of detail; that trade-off is acceptable for
// the live voice channel but undesirable for the recording path (see
// RECORDING_AUDIO_CONSTRAINTS below).
//
// sampleRate/sampleSize/channelCount are requested explicitly rather
// than left to browser defaults, so capture quality doesn't silently
// vary by device/browser. The actual AudioContext sampleRate used for
// PCM capture (see pcmRecorder.js) can still differ from this if the
// OS/hardware doesn't support 48kHz — pcmRecorder.js reports the real
// rate it captured at with every chunk, so that's handled correctly
// either way rather than assumed.
export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};

// DEPRECATED: The two-stream architecture (separate getUserMedia for
// recording) caused compatibility issues across different browsers and
// devices. Some browsers throttle or mute the second stream, leading to
// corrupted/silent recordings. The solution is to USE THE WEBRTC STREAM
// (Stream A) for recording but clone the audio track so the Web Audio
// API has its own independent reference that won't be affected by the
// peer connection's processing.
//
// This constant is kept for backwards compatibility but is no longer
// used. Recording now uses the cloned WebRTC stream.
export const RECORDING_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};