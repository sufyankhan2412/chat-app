const express = require("express");
const Message = require("../models/Message");
const { protect } = require("../middleware/Authmiddleware");
const { uploadAttachment } = require("../middleware/upload");

const router = express.Router();

// How long after sending a message can still be "deleted for everyone",
// mirroring WhatsApp's own cutoff for the same action.
const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000; // 2 days 12 hours


const UNDO_DELETE_GRACE_MS = 10 * 1000; // 10 seconds

// ---------------------------------------------------------------------
// Delete-for-everyone finalize helpers
// ---------------------------------------------------------------------
async function finalizeDeleteForEveryone(io, messageId) {
  const message = await Message.findById(messageId);
  if (!message) return;
  if (message.deletedForEveryone) return; // already finalized
  if (!message.deleteForEveryonePendingAt) return; // was undone in the meantime

  message.deletedForEveryone = true;
  message.deletedAt = new Date();
  message.deleteForEveryonePendingAt = null;
  message.deleteForEveryoneUndoExpiresAt = null;
  message.content = "";
  message.attachment = undefined;
  await message.save();

  if (io) {
    io.to(`user_${message.sender}`).emit("messageDeleted", {
      messageId: message._id,
      forEveryone: true,
      withUserId: message.receiver,
    });
    io.to(`user_${message.receiver}`).emit("messageDeleted", {
      messageId: message._id,
      forEveryone: true,
      withUserId: message.sender,
    });
  }
}

function scheduleFinalizeDelete(io, messageId, delayMs) {
  setTimeout(() => {
    finalizeDeleteForEveryone(io, messageId).catch((err) =>
      console.error("finalizeDeleteForEveryone error:", err.message)
    );
  }, delayMs);
}

// Safety net for server restarts: an in-memory setTimeout scheduled above
// is lost if the process restarts mid-grace-window. Sweeping for any
// pending deletes whose window has already lapsed and finalizing them
// keeps the eventual state correct even after a crash/restart, at the
// cost of the other participant seeing the delete a little late instead
// of exactly on time.
async function sweepStalePendingDeletes(io) {
  try {
    const stale = await Message.find({
      deleteForEveryonePendingAt: { $ne: null },
      deleteForEveryoneUndoExpiresAt: { $lt: new Date() },
    }).select("_id");
    await Promise.all(stale.map((m) => finalizeDeleteForEveryone(io, m._id)));
  } catch (err) {
    console.error("sweepStalePendingDeletes error:", err.message);
  }
}

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

    // Fire-and-forget: finalize any pending deletes left over from before
    // a server restart. Doesn't block this read.
    sweepStalePendingDeletes(req.app.get("io"));

    const query = {
      $or: [
        { sender: myId, receiver: otherUserId },
        { sender: otherUserId, receiver: myId },
      ],
      // Messages I've "deleted for me" stay in the DB (the other side
      // still sees them) but are filtered out of my own history here.
      deletedFor: { $ne: myId },
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
        deletedFor: { $ne: myId },
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
        deletedFor: { $ne: myId },
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

// @route  DELETE /api/messages/clear/:userId
// "Clear chat" — WhatsApp-style: this only clears the conversation on MY
// side. The other participant's copy of every message is left completely
// untouched, and nothing is broadcast to them — from their point of view
// nothing happened.
router.delete("/clear/:userId", protect, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const myId = req.user._id;

    await Message.updateMany(
      {
        $or: [
          { sender: myId, receiver: otherUserId },
          { sender: otherUserId, receiver: myId },
        ],
      },
      { $addToSet: { deletedFor: myId } }
    );

    // Sync any other open tabs/devices I'm logged into — this never goes
    // to the other participant, mirroring WhatsApp's "only I see this
    // chat as cleared" behaviour.
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${myId}`).emit("chatCleared", { withUserId: otherUserId });
    }

    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  DELETE /api/messages/message/:id
// Body: { forEveryone: boolean }
// "Delete for me" removes the message from only the requester's view
// (same mechanism as clearing a whole chat) and is final immediately.
//
// "Delete for everyone" is now a SOFT delete: it only marks the message
// as "pending deletion" and starts a short undo window
// (UNDO_DELETE_GRACE_MS). Only the sender's own other tabs/devices are
// told about the pending state (via "messageDeletePending") — the other
// participant isn't notified yet and keeps seeing the message completely
// normally. If the sender doesn't undo in time, a server-side timer
// finalizes the delete: content is wiped, deletedForEveryone flips to
// true, and only THEN is the other participant told, via the same
// "messageDeleted" event this route always emitted.
router.delete("/message/:id", protect, async (req, res) => {
  try {
    const myId = req.user._id;
    const forEveryone = Boolean(req.body?.forEveryone);

    const message = await Message.findOne({
      _id: req.params.id,
      $or: [{ sender: myId }, { receiver: myId }],
    });
    if (!message) return res.status(404).json({ message: "Message not found" });

    if (!forEveryone) {
      await Message.updateOne(
        { _id: message._id },
        { $addToSet: { deletedFor: myId } }
      );
      const io = req.app.get("io");
      if (io) {
        const withUserId =
          String(message.sender) === String(myId) ? message.receiver : message.sender;
        io.to(`user_${myId}`).emit("messageDeleted", {
          messageId: message._id,
          forEveryone: false,
          withUserId,
        });
      }
      return res.json({ deleted: true, forEveryone: false, messageId: message._id });
    }

    // "Delete for everyone" guardrails
    if (String(message.sender) !== String(myId)) {
      return res.status(403).json({ message: "You can only delete your own messages for everyone" });
    }
    if (message.deletedForEveryone) {
      return res.json({ deleted: true, forEveryone: true, messageId: message._id });
    }
    if (message.deleteForEveryonePendingAt) {
      // Already pending (e.g. triggered from another tab a moment ago) —
      // just hand back the existing deadline so this tab's UI can sync
      // its own countdown instead of starting a brand new one.
      return res.json({
        deleted: true,
        forEveryone: true,
        pending: true,
        messageId: message._id,
        undoExpiresAt: message.deleteForEveryoneUndoExpiresAt,
      });
    }
    const age = Date.now() - new Date(message.createdAt).getTime();
    if (age > DELETE_FOR_EVERYONE_WINDOW_MS) {
      return res.status(400).json({
        message: "This message is too old to delete for everyone",
      });
    }

    const undoExpiresAt = new Date(Date.now() + UNDO_DELETE_GRACE_MS);
    message.deleteForEveryonePendingAt = new Date();
    message.deleteForEveryoneUndoExpiresAt = undoExpiresAt;
    await message.save();

    const io = req.app.get("io");
    if (io) {
      // Only MY other tabs/devices learn this is pending — the receiver
      // stays in the dark until it's actually finalized.
      io.to(`user_${myId}`).emit("messageDeletePending", {
        messageId: message._id,
        undoExpiresAt,
      });
    }

    scheduleFinalizeDelete(io, message._id, UNDO_DELETE_GRACE_MS);

    res.json({
      deleted: true,
      forEveryone: true,
      pending: true,
      messageId: message._id,
      undoExpiresAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/messages/:id/undo-delete
// Cancels a still-pending "delete for everyone" before its grace window
// elapses. Only the original sender can undo, and only in time — the
// server's stored deadline is authoritative, never the client's own
// countdown, so a client clock drift can't extend the window.
router.post("/:id/undo-delete", protect, async (req, res) => {
  try {
    const myId = req.user._id;
    const message = await Message.findOne({ _id: req.params.id, sender: myId });
    if (!message) return res.status(404).json({ message: "Message not found" });

    if (message.deletedForEveryone) {
      return res.status(400).json({ message: "This message was already deleted for everyone" });
    }
    if (
      !message.deleteForEveryonePendingAt ||
      !message.deleteForEveryoneUndoExpiresAt ||
      Date.now() > message.deleteForEveryoneUndoExpiresAt.getTime()
    ) {
      return res.status(400).json({ message: "The undo window has expired" });
    }

    message.deleteForEveryonePendingAt = null;
    message.deleteForEveryoneUndoExpiresAt = null;
    await message.save();

    const io = req.app.get("io");
    if (io) {
      // The receiver never knew a delete was pending, so only my own
      // tabs/devices need telling it was cancelled.
      io.to(`user_${myId}`).emit("messageDeleteUndone", { messageId: message._id });
    }

    res.json({ undone: true, messageId: message._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;