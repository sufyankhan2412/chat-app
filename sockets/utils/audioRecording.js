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

// ---------------------------------------------------------------------
// HISTORY / WHY THERE'S ONLY ONE getUserMedia() CALL PER JOIN SESSION:
//
// A previous version of this app opened a SECOND real getUserMedia()
// audio capture (on top of the one above that feeds the live WebRTC
// call) purely for recording, based on the belief that
// MediaStreamTrack.clone() shares its `enabled` flag with the track it
// was cloned from — i.e. that muting the call track would silently mute
// the "independent" recording too.
//
// That belief was wrong. Per the MediaStream spec, clone() returns a
// genuinely independent MediaStreamTrack instance with its OWN
// `enabled` flag, even though both instances read from the same
// physical microphone source. Setting `enabled = false` on the original
// (what toggleMute does, in Callcontext.jsx / GroupCallContext.jsx)
// never touches a clone's `enabled` state.
//
// Opening a second real capture session on the same input device is
// what actually caused a much worse, user-visible bug: two concurrent
// getUserMedia() sessions on one microphone fight over the browser/OS's
// shared echo-cancellation and auto-gain-control pipeline. The
// symptom was exactly what got reported — the LIVE call audio (Stream
// A, what every other participant hears) came through choppy, robotic,
// or "underwater"-sounding whenever the speaking participant was
// actively talking (both AGC/AEC loops reacting to the same input at
// once), and cleared up the moment that participant muted (back down
// to a single active processing loop). The same contention degraded
// the recording itself, which is what fed Whisper — so the live-call
// quality bug and the transcription-quality bug were the same root
// cause, not two separate ones.
//
// FIX: there is now exactly one getUserMedia() call per join session
// (CALL_AUDIO_CONSTRAINTS above). Recording clones that single
// resulting audio track and forces the clone's `enabled` to `true` for
// the life of the recording — see startRecording in Callcontext.jsx /
// GroupCallContext.jsx. That keeps recording running through mute
// without ever opening a second hardware capture.
// ---------------------------------------------------------------------