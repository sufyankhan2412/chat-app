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
// browser records its own mic locally and uploads small rolling chunks
// here as the call happens, rather than one file at the end. Chunks are
// appended onto the same on-disk file as they arrive, so a crash, closed
// tab, or host removal mid-call only risks losing the last few seconds,
// not the whole recording.
// ---------------------------------------------------------------------
const callAudioDir = path.join(__dirname, "..", "uploads", "call-audio");
fs.mkdirSync(callAudioDir, { recursive: true });

const callAudioFileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("audio/")) {
    return cb(new Error("Only audio uploads are allowed for call recordings"));
  }
  cb(null, true);
};

// Buffered in memory (chunks are ~5s of Opus audio, a few hundred KB at
// most) rather than written straight to disk by multer, since we need to
// APPEND each chunk onto the same per-join file ourselves — see
// appendCallAudioChunk below.
const uploadCallAudioChunk = multer({
  storage: multer.memoryStorage(),
  fileFilter: callAudioFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB is generous for a 5s Opus chunk
});

// Appends one uploaded chunk's bytes onto
// uploads/call-audio/<roomId>/<userId>-<joinedAtMs>.webm, creating the
// room's folder and the file itself on the session's first chunk.
// `joinedAtMs` is the SERVER's timestamp for this specific join (handed
// to the client in the "groupCallJoined" socket event, not read off the
// client's own clock) — it's what lets transcriptionService.js match this
// file back to the exact Call.participants entry it belongs to, and what
// anchors this speaker's segments onto the shared call timeline.
//
// Successive MediaRecorder chunks from one continuous recording session
// concatenate into a valid WebM file (they're all part of the same
// encoded stream, just delivered incrementally) — no re-muxing needed
// before handing the result to a transcription engine.
function appendCallAudioChunk(roomId, userId, joinedAtMs, buffer) {
  const dir = path.join(callAudioDir, String(roomId));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${userId}-${joinedAtMs}.webm`);
  fs.appendFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  uploadAvatar,
  avatarsDir,
  uploadAttachment,
  attachmentsDir,
  uploadCallAudioChunk,
  appendCallAudioChunk,
  callAudioDir,
};