const express = require("express");
const crypto = require("crypto");
const Message = require("../models/Message");
const Call = require("../models/Call");
const GroupCallMessage = require("../models/Groupcallmessage");
const { protect } = require("../middleware/Authmiddleware");
const { uploadCallAudioChunk, saveCallAudioChunk } = require("../middleware/upload");

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

// @route  GET /api/calls/group/:roomId/chat
// Older pages of one meeting's persistent chat. The most recent page
// already comes back over the socket when joining/rejoining the room
// (see "joinCallRoom" in Socketmanager.js) — this route is only for
// scrolling further back into a long meeting's history, same
// limit + `before` (ISO timestamp) cursor convention as
// GET /api/messages/:userId. Restricted to people who actually attended
// this call, same rule as GET /group/:roomId.
router.get("/group/:roomId/chat", protect, async (req, res) => {
  try {
    const call = await Call.findOne({ roomId: req.params.roomId }).select("participants");
    if (!call) return res.status(404).json({ message: "Call not found" });

    const wasParticipant = call.participants.some(
      (p) => String(p.user) === String(req.user._id)
    );
    if (!wasParticipant) {
      return res.status(403).json({ message: "You weren't part of this call" });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const before = req.query.before;

    const query = { roomId: req.params.roomId };
    if (before) {
      const beforeDate = new Date(before);
      if (!Number.isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
      }
    }

    const page = await GroupCallMessage.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("sender", "username avatar");
    const messages = page.reverse();
    const hasMore = page.length === limit;

    res.json({ messages, hasMore });
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

// @route  POST /api/calls/:roomId/audio-chunk
// Appends one rolling ~5s chunk of the CALLER'S OWN mic audio for this
// join session (see GroupCallContext.jsx's MediaRecorder). Calls here are
// mesh WebRTC, so this is the only way any audio ever reaches the server
// at all — it never flows through during the call itself. Chunks are
// appended as they arrive rather than buffered client-side into one
// upload, so a crash, closed tab, or host removal mid-call only risks
// losing the last few seconds, not the whole recording. `joinedAt` must
// be the server timestamp handed back in the "groupCallJoined" socket
// event (not a client clock reading) — it's what ties this upload to a
// specific Call.participants entry, checked below.
router.post(
  "/:roomId/audio-chunk",
  protect,
  uploadCallAudioChunk.single("chunk"),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const joinedAt = Number(req.body.joinedAt);
      const seq = Number(req.body.seq);

      if (!req.file || !Number.isFinite(joinedAt) || !Number.isFinite(seq)) {
        return res.status(400).json({ message: "Missing audio chunk, joinedAt, or seq" });
      }

      const call = await Call.findOne({ roomId }).select("participants");
      if (!call) return res.status(404).json({ message: "Call not found" });

      const isThisJoinSession = call.participants.some(
        (p) => String(p.user) === String(req.user._id) && p.joinedAt.getTime() === joinedAt
      );
      if (!isThisJoinSession) {
        return res.status(403).json({ message: "Not a participant of this call session" });
      }

      saveCallAudioChunk(roomId, req.user._id, joinedAt, seq, req.file.buffer);

      // Diagnostic log requested for the recording pipeline: pairs with
      // the frontend's "[audio-chunk:upload]" log so a bad recording can
      // be traced end-to-end (what the client sent vs. what the server
      // actually received) instead of guessing from the final transcript.
      console.log("[audio-chunk:received]", {
        recordingId: roomId,
        chunkIndex: seq,
        chunkSize: req.file.size,
        receivedAt: new Date().toISOString(),
      });

      res.sendStatus(204);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @route  GET /api/calls/:roomId/transcript/status
// Lightweight poll target for the call-detail view while a transcript is
// still being generated — see enqueueGroupCallTranscription in
// transcriptionService.js for what flips this from "processing" to
// "completed"/"failed".
router.get("/:roomId/transcript/status", protect, async (req, res) => {
  try {
    const call = await Call.findOne({ roomId: req.params.roomId }).select(
      "participants transcript"
    );
    if (!call) return res.status(404).json({ message: "Call not found" });

    const wasParticipant = call.participants.some(
      (p) => String(p.user) === String(req.user._id)
    );
    if (!wasParticipant) {
      return res.status(403).json({ message: "You weren't part of this call" });
    }

    res.json({
      status: call.transcript?.status || "not_started",
      missingParticipants: call.transcript?.missingParticipants || [],
      error: call.transcript?.status === "failed" ? call.transcript.error : undefined,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/calls/:roomId/transcript
// Streams the finished .txt transcript. Restricted to people who
// actually attended this call, same rule as the rest of the group-call
// log routes above — this file isn't served as a static asset, so there
// isn't a shortcut around this check.
router.get("/:roomId/transcript", protect, async (req, res) => {
  try {
    const call = await Call.findOne({ roomId: req.params.roomId }).select(
      "participants transcript"
    );
    if (!call) return res.status(404).json({ message: "Call not found" });

    const wasParticipant = call.participants.some(
      (p) => String(p.user) === String(req.user._id)
    );
    if (!wasParticipant) {
      return res.status(403).json({ message: "You weren't part of this call" });
    }

    if (call.transcript?.status !== "completed" || !call.transcript.txtPath) {
      return res
        .status(409)
        .json({ message: `Transcript is ${call.transcript?.status || "not_started"}.` });
    }

    res.download(call.transcript.txtPath, `call-transcript-${req.params.roomId}.txt`);
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