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

module.exports = { uploadAvatar, avatarsDir, uploadAttachment, attachmentsDir };