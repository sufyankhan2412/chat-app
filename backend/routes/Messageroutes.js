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

// Matches http(s):// and bare "www." links inside a text message, the same
// way WhatsApp detects links to populate its "Links" tab.
const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

// @route  GET /api/messages/:userId/media
// All image/video/file attachments shared with this contact (either
// direction), newest first, plus any links found inside text messages —
// powers the tabbed "Media, links and docs" screen.
router.get("/:userId/media", protect, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const myId = req.user._id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);

    const [media, textMessages] = await Promise.all([
      Message.find({
        type: { $in: ["image", "video", "file"] },
        $or: [
          { sender: myId, receiver: otherUserId },
          { sender: otherUserId, receiver: myId },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(limit),
      // Only text messages can contain links, and only ones that actually
      // match a URL are worth pulling across the wire.
      Message.find({
        type: "text",
        content: URL_REGEX,
        $or: [
          { sender: myId, receiver: otherUserId },
          { sender: otherUserId, receiver: myId },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(limit),
    ]);

    // Turn each matching text message into one or more synthetic "link"
    // media entries (a message can contain more than one URL).
    const links = [];
    for (const msg of textMessages) {
      const found = msg.content.match(URL_REGEX) || [];
      found.forEach((url, i) => {
        links.push({
          _id: `${msg._id}-${i}`,
          type: "link",
          sender: msg.sender,
          receiver: msg.receiver,
          createdAt: msg.createdAt,
          link: {
            url: url.startsWith("http") ? url : `https://${url}`,
            text: msg.content,
          },
        });
      });
    }
    links.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ media, links: links.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/messages/:userId/starred
// Messages I've starred within this specific conversation, newest first.
// Starring is private per-user, so this only ever looks at my own stars.
router.get("/:userId/starred", protect, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const myId = req.user._id;

    const starred = await Message.find({
      starredBy: myId,
      $or: [
        { sender: myId, receiver: otherUserId },
        { sender: otherUserId, receiver: myId },
      ],
    }).sort({ createdAt: -1 });

    res.json({ messages: starred });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/messages/:id/star
router.post("/:id/star", protect, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      $or: [{ sender: req.user._id }, { receiver: req.user._id }],
    });
    if (!message) return res.status(404).json({ message: "Message not found" });

    await Message.updateOne(
      { _id: message._id },
      { $addToSet: { starredBy: req.user._id } }
    );

    res.json({ starred: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/messages/:id/unstar
router.post("/:id/unstar", protect, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      $or: [{ sender: req.user._id }, { receiver: req.user._id }],
    });
    if (!message) return res.status(404).json({ message: "Message not found" });

    await Message.updateOne(
      { _id: message._id },
      { $pull: { starredBy: req.user._id } }
    );

    res.json({ starred: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;