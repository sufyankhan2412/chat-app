const express = require("express");
const crypto = require("crypto");
const Message = require("../models/Message");
const Call = require("../models/Call");
const { protect } = require("../middleware/Authmiddleware");

const router = express.Router();

// @route  GET /api/calls
// Every call-log entry I'm a part of — both 1:1 calls (type: "call"
// Messages) and link-based calls (Call documents I attended) — merged into
// one flat, newest-first history, the same way WhatsApp's single Calls tab
// mixes direct and group calls together. Each entry is tagged with
// `entryType` so the frontend can render the two shapes differently.
router.get("/", protect, async (req, res) => {
  try {
    const myId = req.user._id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const [directCalls, groupCalls] = await Promise.all([
      Message.find({
        type: "call",
        deletedFor: { $ne: myId },
        $or: [{ sender: myId }, { receiver: myId }],
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("sender", "username avatar isOnline")
        .populate("receiver", "username avatar isOnline"),

      // Only calls I actually joined show up in MY log — someone who just
      // generated a link but never joined their own room doesn't get a
      // phantom entry, same as the room never "counting" them as an
      // attendee for anyone else's log either.
      Call.find({
        "participants.user": myId,
        deletedFor: { $ne: myId },
        status: "ended",
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("initiator", "username avatar isOnline")
        .populate("participants.user", "username avatar isOnline"),
    ]);

    const calls = directCalls.map((c) => ({ entryType: "direct", ...c.toObject() }));
    const groups = groupCalls.map((c) => ({ entryType: "group", ...c.toObject() }));

    const merged = [...calls, ...groups].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json({ calls: merged.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/calls/link
// Generates a new joinable call room and returns its link. This is the
// "Google Meet new meeting" button — it does NOT create any group, contact
// relationship, or chat entity. It's just a fresh roomId with a Call
// document (status "ongoing", no participants yet) behind it, ready for
// people to join via socket once they open the link.
router.post("/link", protect, async (req, res) => {
  try {
    const { callType = "video" } = req.body;
    if (!["audio", "video"].includes(callType)) {
      return res.status(400).json({ message: "callType must be 'audio' or 'video'" });
    }

    const roomId = crypto.randomUUID();
    const call = await Call.create({
      roomId,
      initiator: req.user._id,
      callType,
      status: "ongoing",
      participants: [],
    });

    const frontendUrl = process.env.CLIENT_URL || "http://localhost:5173";
    res.status(201).json({
      roomId: call.roomId,
      callType: call.callType,
      link: `${frontendUrl}/call/${call.roomId}`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/calls/room/:roomId
// Lets the join page show "X is calling — Audio/Video" before the user
// commits to joining. Also how a joiner finds out the link is dead (call
// already ended, or never existed).
router.get("/room/:roomId", protect, async (req, res) => {
  try {
    const call = await Call.findOne({ roomId: req.params.roomId })
      .populate("initiator", "username avatar")
      .select("roomId initiator callType status startedAt endedAt");

    if (!call) {
      return res.status(404).json({ message: "This call link is invalid." });
    }
    if (call.status === "ended") {
      return res.status(410).json({ message: "This call has already ended." });
    }

    res.json({
      roomId: call.roomId,
      initiator: call.initiator,
      callType: call.callType,
      status: call.status,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/calls/group/:roomId
// Full log detail for one group call — every participant, their mode, and
// how long each of them stayed. Visible to any user who was actually a
// participant (mirrors a 1:1 call, where both sides can see the same
// entry); anyone else gets 403, since call logs aren't public.
router.get("/group/:roomId", protect, async (req, res) => {
  try {
    const call = await Call.findOne({ roomId: req.params.roomId })
      .populate("initiator", "username avatar")
      .populate("participants.user", "username avatar");

    if (!call) return res.status(404).json({ message: "Call not found" });

    const wasParticipant = call.participants.some(
      (p) => String(p.user?._id || p.user) === String(req.user._id)
    );
    if (!wasParticipant) {
      return res.status(403).json({ message: "You weren't part of this call" });
    }

    res.json({ call });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  DELETE /api/calls/group/:roomId
// "Delete for me" on a group-call log entry — same convention as
// Message.deletedFor. Doesn't touch anyone else's copy.
router.delete("/group/:roomId", protect, async (req, res) => {
  try {
    await Call.updateOne(
      { roomId: req.params.roomId },
      { $addToSet: { deletedFor: req.user._id } }
    );
    res.json({ success: true });
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