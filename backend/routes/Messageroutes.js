const express = require("express");
const Message = require("../models/Message");
const { protect } = require("../middleware/Authmiddleware");
const { uploadAttachment } = require("../middleware/upload");

const router = express.Router();

// Uploads a chat attachment (image/video/voice/file) and returns its URL +
// metadata. This does NOT create a Message document or notify anyone —
// it's a plain REST upload. The actual message gets created over the
// socket connection (see socket/Socketmanager.js -> "sendMessage"), the
// same way text messages already work, so delivery/online-status/receipts
// logic stays in one place. The frontend flow is: upload here first, then
// emit "sendMessage" with the URL this route returns.
//
// IMPORTANT: the client must append the "type" field to the FormData
// BEFORE the "file" field — multer/busboy parses multipart fields in
// stream order, and the fileFilter (which checks req.body.type) only
// sees fields that arrived before the file part.
router.post("/upload", protect, (req, res, next) => {
  uploadAttachment.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  const duration = req.body.duration ? Number(req.body.duration) : undefined;

  res.status(201).json({
    attachment: {
      url: `/uploads/attachments/${req.file.filename}`,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      ...(duration && !Number.isNaN(duration) ? { duration } : {}),
    },
  });
});

router.get("/:userId", protect, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const myId = req.user._id;

    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const before = req.query.before; // ISO date string cursor: only messages older than this

    const query = {
      $or: [
        { sender: myId, receiver: otherUserId },
        { sender: otherUserId, receiver: myId },
      ],
    };

    if (before) {
      const beforeDate = new Date(before);
      if (!Number.isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
      }
    }

    // Fetch newest-first so `.limit()` grabs the most recent page, then
    // flip back to ascending order for the client to render top-to-bottom.
    const page = await Message.find(query).sort({ createdAt: -1 }).limit(limit);
    const messages = page.reverse();
    const hasMore = page.length === limit;

    res.json({ messages, hasMore });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;