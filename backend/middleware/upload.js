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

module.exports = { uploadAvatar, avatarsDir };