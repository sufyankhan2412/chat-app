// Shared between Callcontext.jsx (1:1 calls) and GroupCallContext.jsx
// (group calls) — both run their own independent MediaRecorder against
// the same backend upload/combine/transcribe pipeline, so their
// capture/encode settings must never drift apart. Previously these were
// duplicated in each file (and had already drifted: Callcontext.jsx had
// a hardcoded, non-feature-detected mimeType while GroupCallContext.jsx
// had a real fallback list) — centralizing them here removes that risk
// entirely instead of relying on comments to keep two copies in sync.

// 10s rolling chunks: fewer/larger uploads and fewer WebM cluster
// boundaries to reassemble, while still keeping a crash/closed-tab from
// losing more than the last ~10s (see startRecording in both contexts).
export const CALL_AUDIO_CHUNK_MS = 10000;

// Opus's default bitrate for a plain audio-only MediaRecorder can land
// as low as ~24-32kbps in some browsers — fine for playback, but it
// throws away detail whisper relies on, especially for quieter/farther-
// from-mic speakers. 128kbps mono is comfortably more than enough for
// speech and still keeps a 10s chunk small.
export const CALL_AUDIO_BITRATE = 128000;

// getUserMedia audio constraints for call recording.
//
// noiseSuppression is deliberately OFF. It sounds like the right thing
// to turn on, but it's a black-box DSP step that runs at CAPTURE time —
// before the audio is ever recorded — and it's tuned to sound
// acceptable to a human listener on a live call, not to preserve the
// detail a downstream process (Whisper, or our own server-side ffmpeg
// denoise chain in Transcriptionservice.js) needs. In practice it often
// makes voice sound thinner, muffled, or robotic, and because it runs
// before recording, nothing server-side can undo that damage once it's
// baked into the file. We get real, tunable noise reduction later in
// the pipeline (afftdn in convertToWav) instead, on the raw signal.
//
// echoCancellation stays on — without it, calls with speakers (not
// headphones) get real acoustic echo baked into the recording, which
// no server-side filter can cleanly remove after the fact.
// autoGainControl stays on — it's a simple, well-behaved level control
// (not a lossy spectral filter like noiseSuppression) and helps keep
// quiet/far-from-mic speakers from being inaudible.
//
// sampleRate/sampleSize/channelCount are pinned explicitly rather than
// left to browser defaults, so recording quality doesn't silently vary
// by device/browser: 48kHz/16-bit is the standard high-quality capture
// rate, and mono avoids stereo-mic artifacts we'd just downmix away in
// convertToWav anyway.
export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};

// Feature-detect the best container this browser can actually produce.
// Safari/iOS don't support "audio/webm;codecs=opus" at all — without
// this check, `new MediaRecorder(...)` throws synchronously, and if
// that's not caught (or is caught but silently swallowed), that
// participant's mic is never recorded for the entire call. ffmpeg
// auto-detects the real container from the bytes regardless of the
// ".webm" filename extension the backend always uses, so any of these
// are safe to send through the existing upload/transcribe pipeline
// unchanged.
const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4", // Safari's usual pick
  "audio/ogg;codecs=opus",
];

export function pickSupportedAudioMimeType() {
  return CANDIDATE_MIME_TYPES.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || null;
}