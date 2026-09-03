const fs = require("fs");
const path = require("path");
const multer = require("multer");

// backend/uploads/avatars — created automatically if it doesn't exist yet
const avatarsDir = path.join(__dirname, "..", "uploads", "avatars");
fs.mkdirSync(avatarsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    // req.user is set by the protect middleware, which must run before this
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user._id}-${Date.now()}${ext}`);
  },
});

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP or GIF images are allowed"));
  }
  cb(null, true);
};

const uploadAvatar = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------------------------------------------------------------------
// Chat attachments: images, videos, voice notes, and arbitrary files.
// Separate folder + separate multer instance from avatars because the
// allowed types, size limit, and naming scheme are all different.
// ---------------------------------------------------------------------
const attachmentsDir = path.join(__dirname, "..", "uploads", "attachments");
fs.mkdirSync(attachmentsDir, { recursive: true });

const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, attachmentsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // req.user is set by `protect`, which must run before this middleware.
    // A random suffix (not just Date.now()) avoids collisions if two files
    // land in the same millisecond, e.g. a multi-photo picker.
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${req.user._id}-${unique}${ext}`);
  },
});

// Maps a message "type" (from the request body) to the mimetypes it accepts.
// The upload route reads req.body.type to know which bucket to check against
// before multer even looks at the bytes, so users get a clear error instead
// of a generic "invalid file" from the fileFilter.
const ATTACHMENT_MIME_TYPES = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  video: ["video/mp4", "video/webm", "video/quicktime", "video/ogg"],
  voice: ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/mp3"],
  // "file" is the catch-all (documents, zips, etc) — no mimetype restriction,
  // just a size cap, same as WhatsApp's "Document" picker.
  file: null,
};

const attachmentFileFilter = (req, file, cb) => {
  const type = req.body.type;
  const allowed = ATTACHMENT_MIME_TYPES[type];

  if (type && type !== "file" && !allowed) {
    return cb(new Error("Unknown attachment type"));
  }
  if (allowed && !allowed.includes(file.mimetype)) {
    return cb(new Error(`File type ${file.mimetype} is not allowed for ${type} messages`));
  }
  cb(null, true);
};

const uploadAttachment = multer({
  storage: attachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — covers photos, voice notes, short videos, most docs
});

// ---------------------------------------------------------------------
// Group-call audio, one file per (roomId, userId, join session) — see
// backend/services/transcriptionService.js for how these get turned into
// a transcript. Calls in this app are mesh WebRTC (GroupCallContext.jsx),
// so audio never otherwise reaches this server; each participant's own
// browser captures raw PCM locally (see sockets/utils/pcmRecorder.js —
// deliberately NOT MediaRecorder/Opus, since the browser's own Opus
// encoder was silently discarding audio quality with no way to reliably
// configure around it) and uploads small rolling chunks here as the
// call happens, rather than one file at the end. Chunks are written as
// their own files as they arrive, so a crash, closed tab, or host
// removal mid-call only risks losing the last few seconds, not the
// whole recording.
// ---------------------------------------------------------------------
const callAudioDir = path.join(__dirname, "..", "uploads", "call-audio");
fs.mkdirSync(callAudioDir, { recursive: true });

// Raw PCM chunks are uploaded as a plain Blob (see api.js's
// uploadCallAudioChunk), which browsers report as
// "application/octet-stream" — there is no audio/* mimetype for headerless
// PCM, so this intentionally does NOT require an audio/* prefix the way
// avatar/attachment uploads do. This route is otherwise already scoped
// (authenticated, call-specific) so accepting octet-stream here isn't
// opening up a generic arbitrary-file-upload hole.
const callAudioFileFilter = (req, file, cb) => {
  if (file.mimetype !== "application/octet-stream") {
    return cb(new Error("Only raw PCM audio uploads are allowed for call recordings"));
  }
  cb(null, true);
};

// Buffered in memory (chunks are ~10s of 16-bit mono PCM — roughly
// 300KB-1MB depending on the captured sample rate) rather than written
// straight to disk by multer, since we need control over the exact
// filename/path ourselves — see saveCallAudioChunk below.
const uploadCallAudioChunk = multer({
  storage: multer.memoryStorage(),
  fileFilter: callAudioFileFilter,
  limits: { fileSize: 4 * 1024 * 1024 }, // generous headroom for a 10s PCM chunk at 48kHz mono (~960KB)
});

// Saves one uploaded chunk as its own file:
// uploads/call-audio/<roomId>/<userId>-<joinedAtMs>-<seq>.pcm, creating
// the room's folder on the session's first chunk. `joinedAtMs` is the
// SERVER's timestamp for this specific join (handed to the client in the
// "groupCallJoined" socket event, not read off the client's own clock) —
// it's what lets transcriptionService.js match this file back to the
// exact Call.participants entry it belongs to, and what anchors this
// speaker's segments onto the shared call timeline. `seq` is the
// per-join-session, client-assigned ordinal of this chunk (0, 1, 2, ...).
// `sampleRate` is the sending browser's actual AudioContext capture rate
// (see pcmRecorder.js) — not assumed to be a fixed value, since not
// every OS/hardware combination honors the 48kHz getUserMedia request —
// persisted alongside the chunks so transcriptionService.js knows the
// correct rate to use when wrapping the combined raw PCM into a WAV file.
//
// IMPORTANT: we do NOT append chunks onto one shared file. Each chunk
// arrives over its own independent HTTP request, and multiple uploads
// for the same join session are in flight concurrently (the client
// doesn't wait for one to finish before sending the next) — so they can
// land at the server, and therefore get appended, in a different order
// than they were recorded in. Writing each chunk to its own file — named
// so it sorts/parses back into the right order — lets
// transcriptionService.js reassemble them in the CORRECT (recorded)
// order at transcription time, regardless of upload arrival order. This
// matters even more now that chunks are raw PCM rather than Opus: raw
// PCM has no per-block framing/sync markers at all, so out-of-order
// bytes wouldn't just corrupt a stream ffmpeg might partially recover —
// they'd silently splice into different points in time and be
// transcribed as if they were in the right place.
function saveCallAudioChunk(roomId, userId, joinedAtMs, seq, buffer, sampleRate) {
  const dir = path.join(callAudioDir, String(roomId));
  fs.mkdirSync(dir, { recursive: true });
  const seqPadded = String(seq).padStart(6, "0");
  const filePath = path.join(dir, `${userId}-${joinedAtMs}-${seqPadded}.pcm`);
  
  // Diagnostic: verify what we're actually writing to disk
  console.log(`[audio-chunk:save] roomId=${roomId}, seq=${seq}, buffer.length=${buffer.length}, sampleRate=${sampleRate}`);
  
  // writeFileSync (not append): each chunk is its own file, and this
  // also makes a client retry of the same chunk idempotent instead of
  // duplicating bytes.
  fs.writeFileSync(filePath, buffer);
  
  // Verify the file was written correctly
  const stat = require('fs').statSync(filePath);
  console.log(`[audio-chunk:saved] filePath=${path.basename(filePath)}, diskSize=${stat.size}`);
  if (stat.size !== buffer.length) {
    console.error(`[audio-chunk:size-mismatch!] Expected ${buffer.length} bytes, but file on disk is ${stat.size} bytes`);
  }

  // One small sidecar file per join session recording the sample rate —
  // overwritten on every chunk (cheap; a handful of bytes), so it's
  // present as soon as the first chunk arrives and self-corrects if a
  // client ever reported the wrong value on an early chunk.
  if (Number.isFinite(sampleRate) && sampleRate > 0) {
    const ratePath = path.join(dir, `${userId}-${joinedAtMs}.rate`);
    fs.writeFileSync(ratePath, String(Math.round(sampleRate)));
  }

  return filePath;
}

module.exports = {
  uploadAvatar,
  avatarsDir,
  uploadAttachment,
  attachmentsDir,
  uploadCallAudioChunk,
  saveCallAudioChunk,
  callAudioDir,
};