const express = require("express");
const Message = require("../models/Message");
const { protect } = require("../middleware/Authmiddleware");

const router = express.Router();

// @route  GET /api/calls
// Every call-log entry (type: "call") I'm a part of, either as caller or
// callee, newest first — powers the dedicated Calls page. The frontend
// groups consecutive calls with the same contact into one row (with a
// "(n)" count badge), the same way WhatsApp's own Calls tab does, so this
// route just hands back the flat, populated history.
router.get("/", protect, async (req, res) => {
  try {
    const myId = req.user._id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const calls = await Message.find({
      type: "call",
      deletedFor: { $ne: myId },
      $or: [{ sender: myId }, { receiver: myId }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("sender", "username avatar isOnline")
      .populate("receiver", "username avatar isOnline");

    res.json({ calls });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/calls/:userId
// Just the call history with one specific contact — e.g. for a "call
// history" section inside a contact's profile.
router.get("/:userId", protect, async (req, res) => {
  try {
    const myId = req.user._id;
    const otherUserId = req.params.userId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);

    const calls = await Message.find({
      type: "call",
      deletedFor: { $ne: myId },
      $or: [
        { sender: myId, receiver: otherUserId },
        { sender: otherUserId, receiver: myId },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({ calls });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;