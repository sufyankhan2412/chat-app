const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const Message = require("../models/Message");
const Contact = require("../models/Contact");
const Call = require("../models/Call");
const GroupCallMessage = require("../models/Groupcallmessage");
const CallChatReadState = require("../models/Callchatreadstate");
const { enqueueGroupCallTranscription } = require("../services/transcriptionService");

// How long to wait, after a group call's room empties, before kicking off
// transcription — gives any last audio chunk uploads still in flight over
// the network (e.g. from whoever just left) a chance to land first.
const TRANSCRIPTION_START_DELAY_MS = 15000;

// In-memory map of userId -> Set<socketId> for currently connected users
const onlineUsers = new Map();

// In-memory map of userId -> the userId they're currently calling / in a
// call with (covers both "ringing" and "connected" states). Used only to
// clean up gracefully if someone's socket drops mid-call.
const activeCalls = new Map();

// In-memory map of roomId -> Map<userId, socketId> for link-based group
// calls currently in progress. This is what makes "who else is in the
// room right now" a cheap lookup instead of a DB query on every join, and
// is exactly mirrored (join/leave) into the persisted Call document's
// `participants` array so the log survives after the room empties and
// this map entry is thrown away.
const groupCallRooms = new Map();

function getGroupCallRoomName(roomId) {
  return `group_call_${roomId}`;
}

// One page of a meeting's persistent chat, newest-first internally then
// flipped to ascending for rendering — same cursor convention as
// GET /api/messages/:userId (limit + `before` an ISO timestamp).
const GROUP_CALL_CHAT_PAGE_SIZE = 50;

async function fetchGroupCallChatPage(roomId, { before } = {}) {
  const query = { roomId };
  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.getTime())) {
      query.createdAt = { $lt: beforeDate };
    }
  }
  const page = await GroupCallMessage.find(query)
    .sort({ createdAt: -1 })
    .limit(GROUP_CALL_CHAT_PAGE_SIZE);
  const messages = page.reverse();
  const hasMore = page.length === GROUP_CALL_CHAT_PAGE_SIZE;
  return { messages, hasMore };
}

// In-memory map of room name (sorted pair, see getRoomName) -> metadata for
// the call currently ringing/ongoing between those two users. This is what
// lets us write a single WhatsApp-style call-log Message once the call
// concludes, no matter which side ends it or why: { callerId, calleeId,
// callType, answeredAt }. `answeredAt` stays null the whole time the call
// is only ringing, and is stamped the moment the callee answers.
const callLogMeta = new Map();

function clearActiveCall(userId) {
  const otherUserId = activeCalls.get(String(userId));
  activeCalls.delete(String(userId));
  if (otherUserId) {
    activeCalls.delete(String(otherUserId));
  }
  return otherUserId;
}

function getReceiverSocketIds(userId) {
  const userSockets = onlineUsers.get(String(userId));
  return userSockets ? Array.from(userSockets) : [];
}

function getReceiverSocketId(userId) {
  return getReceiverSocketIds(userId)[0] || null;
}

function getRoomName(userId, otherUserId) {
  return [String(userId), String(otherUserId)].sort().join("_");
}

function getUserRoomName(userId) {
  return `user_${String(userId)}`;
}

// Writes one call-log Message (type: "call") and pushes it to both
// participants live, exactly the way a normal chat message is delivered —
// `receiveMessage` to the callee's room, `messageSent` to the caller's, so
// it shows up instantly in an open chat window and updates the sidebar
// preview on both sides, plus becomes queryable later from GET /api/calls
// for the dedicated Call Logs page.
async function logCall(io, { callerId, calleeId, callType, status, startedAt }) {
  try {
    const duration =
      status === "completed" && startedAt
        ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        : 0;

    const message = await Message.create({
      sender: callerId,
      receiver: calleeId,
      type: "call",
      call: { callType, status, duration },
    });

    io.to(getUserRoomName(calleeId)).emit("receiveMessage", message);
    io.to(getUserRoomName(callerId)).emit("messageSent", message);
  } catch (err) {
    console.error("logCall error:", err.message);
  }
}

// ---------------------------------------------------------------------
// 1:1 call transcription. Previously only link-based/group calls (the
// `Call` model + joinCallRoom/leaveCallRoom below) ever got a `Call`
// document, an audio recording, or a transcript — a plain 1:1 audio/video
// call just wrote a single-line "call" Message and nothing else ever
// recorded any audio for it. But a direct call is really just a "room"
// with exactly two participants who both join the instant it connects, so
// it can reuse the EXACT SAME machinery group calls already use: a `Call`
// document with a roomId, two `participants` entries (both with the same
// joinedAt, since both sides start recording the moment the call is
// answered), each side's own MediaRecorder uploading chunks tagged with
// that roomId/joinedAt (see Callcontext.jsx), and the same
// transcriptionService.js merge job at the end. Nothing in the model,
// upload route, or transcription service needed to change for this —
// they were already written generically per-roomId.
//
// Called once a direct call actually connects (see "answerCall" below).
// Best-effort: if this fails, the call itself is already connected and
// keeps going — recording/transcription is an add-on, never a
// precondition for the call working.
async function startDirectCallRecording(io, meta) {
  try {
    const roomId = crypto.randomUUID();
    const joinedAt = new Date();
    const call = await Call.create({
      roomId,
      initiator: meta.callerId,
      callType: meta.callType,
      status: "ongoing",
      participants: [
        { user: meta.callerId, mode: meta.callType, joinedAt },
        { user: meta.calleeId, mode: meta.callType, joinedAt },
      ],
    });

    meta.roomId = call.roomId;
    meta.recordingJoinedAtMs = joinedAt.getTime();

    // Both sides get the same roomId/joinedAt so their uploaded chunks
    // land tagged identically to how a group-call join would tag them —
    // transcriptionService.js can't tell (and doesn't need to know) that
    // this "room" only ever had two people in it.
    const payload = { roomId: call.roomId, joinedAt: joinedAt.getTime() };
    io.to(getUserRoomName(meta.callerId)).emit("callSessionStarted", payload);
    io.to(getUserRoomName(meta.calleeId)).emit("callSessionStarted", payload);
  } catch (err) {
    console.error("startDirectCallRecording error:", err.message);
  }
}

// Seals a direct call's recording session (if one was started — see
// startDirectCallRecording) and schedules the same transcription job group
// calls use. Safe to call on any call end path (normal hangup, upgrade to
// group, or a dropped connection) since it's a no-op when `meta.roomId`
// was never set, i.e. the call never actually connected.
function finalizeDirectCallRecording(io, meta) {
  if (!meta?.roomId) return;
  const roomId = meta.roomId;
  const leftAt = new Date();
  const duration = Math.max(0, Math.round((leftAt.getTime() - meta.recordingJoinedAtMs) / 1000));

  // Single atomic update — both participants share the same joinedAt, so
  // `$[]` (every array element) is exactly the two of them, no arrayFilter
  // needed. No prior read/save race to worry about since nothing else ever
  // mutates a direct call's `participants` after startDirectCallRecording
  // created it.
  Call.updateOne(
    { roomId },
    {
      $set: {
        status: "ended",
        endedAt: leftAt,
        "participants.$[].leftAt": leftAt,
        "participants.$[].duration": duration,
      },
    }
  )
    .then(() => {
      setTimeout(
        () => enqueueGroupCallTranscription(roomId, io),
        TRANSCRIPTION_START_DELAY_MS
      );
    })
    .catch((err) => console.error(`finalizeDirectCallRecording(${roomId}) error:`, err.message));
}

function initSocket(io) {
  // Socket-level auth middleware: verifies the JWT sent from the client
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication error: no token"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error("Authentication error: invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.userId;
    const userKey = String(userId);

    if (!onlineUsers.has(userKey)) {
      onlineUsers.set(userKey, new Set());
    }
    onlineUsers.get(userKey).add(socket.id);

    socket.join(getUserRoomName(userId));

    socket.on("joinChat", ({ roomName }) => {
      if (roomName) {
        socket.join(roomName);
      }
    });

    socket.on("leaveChat", ({ roomName }) => {
      if (roomName) {
        socket.leave(roomName);
      }
    });

try {
  const stillOnline = onlineUsers.has(userKey);
  await User.findByIdAndUpdate(userId, {
    isOnline: stillOnline,
    ...(stillOnline ? {} : { lastSeen: new Date() }),
  });
} catch (err) {
  console.error("Error setting user online:", err.message);
}

    // Let everyone know this user just came online
    socket.broadcast.emit("userOnline", { userId });

    // Any messages this user had sitting as "sent" (receiver was offline)
    // become "delivered" now that they're online. Notify original senders.
    try {
      const pendingMessages = await Message.find({
        receiver: userId,
        status: "sent",
      });
      if (pendingMessages.length) {
        const ids = pendingMessages.map((m) => m._id);
        await Message.updateMany(
          { _id: { $in: ids } },
          { $set: { status: "delivered" } }
        );
        // notify each sender their message(s) got delivered
        const senderIds = [...new Set(pendingMessages.map((m) => String(m.sender)))];
        senderIds.forEach((sId) => {
          const sSocket = getReceiverSocketId(sId);
          if (sSocket) {
            const idsForThisSender = pendingMessages
              .filter((m) => String(m.sender) === sId)
              .map((m) => String(m._id));
            io.to(sSocket).emit("messagesDelivered", {
              messageIds: idsForThisSender,
            });
          }
        });
      }
    } catch (err) {
      console.error("Error updating pending messages:", err.message);
    }

    // ---- Send a message ----
    // `type` + `attachment` are new: for text messages (the default) only
    // `content` is used, exactly as before. For image/video/voice/file
    // messages, the client has already uploaded the file via
    // POST /api/messages/upload and passes back the returned `attachment`
    // object here; `content` becomes an optional caption.
    socket.on("sendMessage", async ({ receiverId, content, type = "text", attachment }) => {
      try {
        const isTextMessage = type === "text";

        if (isTextMessage && (!content || !content.trim())) return;
        if (!isTextMessage && !attachment?.url) return;

        // Block check, both directions: if either side has blocked the
        // other, the message is silently refused — mirrors WhatsApp, where
        // a blocked contact never learns their message didn't go through.
        const [me, receiverUser] = await Promise.all([
          User.findById(userId).select("blockedUsers"),
          User.findById(receiverId).select("blockedUsers"),
        ]);

        const iBlockedThem = (me?.blockedUsers || []).some(
          (id) => String(id) === String(receiverId)
        );
        const theyBlockedMe = (receiverUser?.blockedUsers || []).some(
          (id) => String(id) === String(userId)
        );

        if (iBlockedThem || theyBlockedMe) {
          socket.emit("errorMessage", {
            message: iBlockedThem
              ? "You've blocked this contact. Unblock them to send messages."
              : "This message could not be delivered.",
          });
          return;
        }

        const receiverSocketIds = getReceiverSocketIds(receiverId);
        const status = receiverSocketIds.length ? "delivered" : "sent";

        // If this chat has disappearing messages turned on, stamp an
        // expiry so MongoDB's TTL index cleans it up automatically.
        const contactSetting = await Contact.findOne({
          user: userId,
          contact: receiverId,
        }).select("disappearingDuration");
        const disappearingDuration = contactSetting?.disappearingDuration || 0;

        const message = await Message.create({
          sender: userId,
          receiver: receiverId,
          type,
          content: content ? content.trim() : "",
          ...(isTextMessage ? {} : { attachment }),
          status,
          ...(disappearingDuration
            ? { expiresAt: new Date(Date.now() + disappearingDuration) }
            : {}),
        });

        const receiverRoom = getUserRoomName(receiverId);
        io.to(receiverRoom).emit("receiveMessage", message);

        // echo back to sender (with real status + db id) so their UI updates
        socket.emit("messageSent", message);
      } catch (err) {
        console.error("sendMessage error:", err.message);
        socket.emit("errorMessage", { message: "Could not send message" });
      }
    });

    // ---- Mark messages as read (called when receiver opens/views the chat) ----
    socket.on("markAsRead", async ({ senderId }) => {
      try {
        const result = await Message.updateMany(
          { sender: senderId, receiver: userId, status: { $ne: "read" } },
          { $set: { status: "read" } }
        );

        const senderSocketIds = getReceiverSocketIds(senderId);
        senderSocketIds.forEach((senderSocketId) => {
          // tell the original sender: your messages were seen -> turn ticks blue
          io.to(senderSocketId).emit("messagesRead", { by: userId });
        });

        const senderRoom = getUserRoomName(senderId);
        io.to(senderRoom).emit("messagesRead", { by: userId });
      } catch (err) {
        console.error("markAsRead error:", err.message);
      }
    });

    // ---- Typing indicator ----
    socket.on("typing", ({ receiverId }) => {
      const receiverRoom = getUserRoomName(receiverId);
      io.to(receiverRoom).emit("typing", { from: userId });
    });

    socket.on("stopTyping", ({ receiverId }) => {
      const receiverRoom = getUserRoomName(receiverId);
      io.to(receiverRoom).emit("stopTyping", { from: userId });
    });

    // ---- WebRTC call signaling (1:1 audio/video calls) ----
    // The server never touches media — it only relays the SDP offer/answer
    // and ICE candidates between the two peers, plus tracks who's "in a
    // call with whom" so a dropped connection cleans up the other side.

    // Caller -> callee: "I'm calling you" + the WebRTC offer.
    // callType is "audio" | "video".
    socket.on("callUser", ({ receiverId, offer, callType }) => {
      if (!receiverId || !offer) return;

      const receiverSocketIds = getReceiverSocketIds(receiverId);
      if (!receiverSocketIds.length) {
        // Callee isn't connected at all — tell the caller right away
        // instead of leaving them "ringing" forever. Still worth a
        // "missed call" log entry, the same way WhatsApp records a call
        // even if the other side's phone never actually rang.
        socket.emit("callFailed", { reason: "offline" });
        logCall(io, {
          callerId: userKey,
          calleeId: String(receiverId),
          callType,
          status: "missed",
        });
        return;
      }

      activeCalls.set(userKey, String(receiverId));
      activeCalls.set(String(receiverId), userKey);

      callLogMeta.set(getRoomName(userId, receiverId), {
        callerId: userKey,
        calleeId: String(receiverId),
        callType,
        answeredAt: null,
      });

      io.to(getUserRoomName(receiverId)).emit("incomingCall", {
        from: userId,
        offer,
        callType,
      });
    });

    // Callee -> caller: "I accepted" + the WebRTC answer.
    socket.on("answerCall", ({ callerId, answer }) => {
      if (!callerId || !answer) return;
      const meta = callLogMeta.get(getRoomName(userId, callerId));
      if (meta) meta.answeredAt = Date.now();
      io.to(getUserRoomName(callerId)).emit("callAnswered", { answer });

      // The call is connected now — start recording both sides' audio for
      // transcription, exactly like a group call room does the moment
      // someone joins. See startDirectCallRecording's comment for why this
      // reuses the group-call pipeline unchanged.
      if (meta) startDirectCallRecording(io, meta);
    });

    // Either side, any time during setup or the call: forward ICE candidates.
    socket.on("iceCandidate", ({ targetId, candidate }) => {
      if (!targetId || !candidate) return;
      io.to(getUserRoomName(targetId)).emit("iceCandidate", {
        from: userId,
        candidate,
      });
    });

    // Callee declines before answering.
    socket.on("rejectCall", ({ callerId, reason }) => {
      clearActiveCall(userId);
      const roomName = getRoomName(userId, callerId);
      const meta = callLogMeta.get(roomName);
      callLogMeta.delete(roomName);
      if (meta && !meta.answeredAt) {
        logCall(io, {
          callerId: meta.callerId,
          calleeId: meta.calleeId,
          callType: meta.callType,
          // "busy" is an auto-decline (already on another call) — that
          // reads to the caller as a missed call, not a deliberate one.
          status: reason === "busy" ? "missed" : "declined",
        });
      }
      if (!callerId) return;
      io.to(getUserRoomName(callerId)).emit("callRejected", {
        reason: reason || "declined",
      });
    });

    // Caller hangs up before the callee answers.
    socket.on("cancelCall", ({ receiverId }) => {
      clearActiveCall(userId);
      const roomName = getRoomName(userId, receiverId);
      const meta = callLogMeta.get(roomName);
      callLogMeta.delete(roomName);
      if (meta && !meta.answeredAt) {
        logCall(io, {
          callerId: meta.callerId,
          calleeId: meta.calleeId,
          callType: meta.callType,
          status: "missed",
        });
      }
      if (!receiverId) return;
      io.to(getUserRoomName(receiverId)).emit("callCancelled", {});
    });

    // Either side ends an in-progress (already-answered) call.
    socket.on("endCall", ({ targetId }) => {
      clearActiveCall(userId);
      const roomName = getRoomName(userId, targetId);
      const meta = callLogMeta.get(roomName);
      callLogMeta.delete(roomName);
      if (meta) {
        logCall(io, {
          callerId: meta.callerId,
          calleeId: meta.calleeId,
          callType: meta.callType,
          status: meta.answeredAt ? "completed" : "missed",
          startedAt: meta.answeredAt,
        });
        finalizeDirectCallRecording(io, meta);
      }
      if (!targetId) return;
      io.to(getUserRoomName(targetId)).emit("callEnded", {});
    });

    // ---- Upgrade an ongoing 1:1 call into a link-based group call ----
    // This is the "Add people" button inside the live call screen — the
    // whole reason it needs to be reachable from *there* rather than only
    // from the Calls list is that the two people already talking are the
    // ones who decide, mid-call, to bring someone else in. Either side can
    // trigger it. The current call is logged exactly as if it had just
    // ended normally (real elapsed duration, status "completed"), and a
    // fresh Call room is created — both participants are handed the same
    // roomId and immediately become the first two members of that room,
    // with its link ready to hand to whoever they want to add.
    socket.on("upgradeCallToGroup", async ({ targetId, callType }) => {
      if (!targetId) return;
      const roomName = getRoomName(userId, targetId);
      const meta = callLogMeta.get(roomName);

      if (!meta || !meta.answeredAt) {
        socket.emit("groupCallError", {
          message: "You can only add people once the call is connected.",
        });
        return;
      }

      try {
        callLogMeta.delete(roomName);
        clearActiveCall(userId);

        await logCall(io, {
          callerId: meta.callerId,
          calleeId: meta.calleeId,
          callType: meta.callType,
          status: "completed",
          startedAt: meta.answeredAt,
        });
        // Seal and queue transcription for the 1:1 portion of the
        // conversation that happened before this upgrade — otherwise that
        // audio/Call document would be left "ongoing" forever, and that
        // part of the conversation would never get transcribed. The
        // brand-new group room created just below gets its own separate
        // recording session once people join it.
        finalizeDirectCallRecording(io, meta);

        const roomId = crypto.randomUUID();
        const call = await Call.create({
          roomId,
          initiator: userId,
          callType: callType || meta.callType,
          status: "ongoing",
          participants: [],
        });

        const frontendUrl = process.env.CLIENT_URL || "http://localhost:5173";
        const payload = {
          roomId: call.roomId,
          callType: call.callType,
          link: `${frontendUrl}/call/${call.roomId}`,
        };

        // Both sides get the same payload and independently join the new
        // room client-side (see GroupCallContext's "callUpgraded" listener)
        // — neither has to click the link themselves, only anyone new
        // being invited does.
        io.to(getUserRoomName(userId)).emit("callUpgraded", payload);
        io.to(getUserRoomName(targetId)).emit("callUpgraded", payload);
      } catch (err) {
        console.error("upgradeCallToGroup error:", err.message);
        socket.emit("groupCallError", { message: "Couldn't add people to this call." });
      }
    });

    // ---- Group / link-based calls (N-way, mesh WebRTC) ----
    // The link itself (roomId) is created over REST (POST /api/calls/link)
    // since that needs a DB write and a response before anyone joins.
    // Everything from here on — actually entering the room, exchanging
    // WebRTC signaling with every other participant, and leaving — happens
    // over sockets, same pattern as the 1:1 flow above. The server still
    // never touches media, only relays SDP/ICE, now to a list of peers
    // instead of just one.

    // Client -> server: "I'm joining this room" with the mode they picked
    // (audio-only or with camera) on the join screen.
    socket.on("joinCallRoom", async ({ roomId, mode = "video" }) => {
      if (!roomId) return;

      try {
        if (!groupCallRooms.has(roomId)) {
          groupCallRooms.set(roomId, new Map());
        }
        const room = groupCallRooms.get(roomId);

        // Existing peers, sent back to the joiner so *they* initiate the
        // offer to each one already in the room (new peer always offers to
        // existing peers — avoids both sides racing to create an offer).
        // This read + the room.set() right below it are the only two lines
        // that touch the in-memory room map, and there's no `await` between
        // them, so — since a single Node process handles all sockets on one
        // thread — no other "joinCallRoom" call can interleave here and see
        // a half-updated room. That's what keeps two near-simultaneous
        // joiners (see below) from missing each other's "peerJoined" event.
        const existingPeers = Array.from(room.entries()).map(([uid]) => uid);
        room.set(userKey, socket.id);
        socket.join(getGroupCallRoomName(roomId));
        socket.data.activeCallRoom = roomId;

        // Captured once, rather than re-read later, so the timestamp the
        // client uses to tag/name its audio recording (see the
        // "groupCallJoined" emit below) is EXACTLY the same value that
        // ends up on this participants entry — that's what lets
        // transcriptionService.js match an uploaded file back to the
        // right join session.
        const joinedAt = new Date();

        // IMPORTANT: this used to be `Call.findOne` + `call.participants.push()`
        // + `call.save()`. Two people joining the same room within
        // milliseconds of each other — exactly what happens right after a
        // 1:1 call is upgraded to a group call, since BOTH sides auto-join
        // the instant they receive "callUpgraded" — would each fetch their
        // own copy of the document, push to it in memory, and save it back.
        // Mongoose's optimistic-concurrency versioning (`__v`) means
        // whichever save() lands second fails with a VersionError (the
        // document had already changed underneath it since it was read),
        // so the second participant's join was silently dropped — the
        // "adding more people creates a bug" symptom. A single atomic
        // `$push` has no read-modify-write step, so there's nothing left
        // for concurrent joins to race on.
        const call = await Call.findOneAndUpdate(
          { roomId, status: { $ne: "ended" } },
          { $push: { participants: { user: userId, mode, joinedAt } } },
          { new: true }
        );
        if (!call) {
          // Roll back the in-memory membership we optimistically added
          // above — the room/link turned out to be invalid or already
          // ended, so this socket never actually joined.
          room.delete(userKey);
          socket.leave(getGroupCallRoomName(roomId));
          socket.data.activeCallRoom = null;
          socket.emit("groupCallError", { message: "This call link is invalid or has ended." });
          return;
        }

        // Meeting-level chat: the room's chat belongs to the roomId, not
        // to this join. Whether this is the first time joining or a
        // rejoin after leaving, the same persisted history and the same
        // per-participant read cursor come back here — never a fresh,
        // empty chat tied to this socket/session.
        const [chatPage, readState] = await Promise.all([
          fetchGroupCallChatPage(roomId),
          CallChatReadState.findOne({ roomId, user: userId }),
        ]);

        socket.emit("groupCallJoined", {
          roomId,
          callType: call.callType,
          peers: existingPeers,
          hostId: String(call.initiator),
          // Shared clock for call-transcription alignment (see
          // GroupCallContext.jsx's recording logic and
          // transcriptionService.js's merge step). Both are SERVER
          // timestamps deliberately, not left to each client's own
          // clock, so segments from different participants' devices
          // line up on one timeline regardless of clock drift between
          // them.
          callStartedAt: call.startedAt.getTime(),
          joinedAt: joinedAt.getTime(),
          chatHistory: { messages: chatPage.messages, hasMore: chatPage.hasMore },
          lastReadMessageId: readState?.lastReadMessageId
            ? String(readState.lastReadMessageId)
            : null,
        });

        socket.to(getGroupCallRoomName(roomId)).emit("peerJoined", {
          roomId,
          peerId: userId,
          mode,
        });
      } catch (err) {
        console.error("joinCallRoom error:", err.message);
        socket.emit("groupCallError", { message: "Couldn't join the call." });
      }
    });

    // Relay a WebRTC offer/answer/ICE candidate to one specific peer in the
    // room. `signalType` is "offer" | "answer" | "ice" — kept generic
    // (rather than three separate events) since the payload just passes
    // through untouched either way.
    socket.on("callSignal", ({ roomId, targetUserId, signalType, payload }) => {
      if (!roomId || !targetUserId || !signalType) return;
      const room = groupCallRooms.get(roomId);
      const targetSocketId = room?.get(String(targetUserId));
      if (!targetSocketId) return;

      io.to(targetSocketId).emit("callSignal", {
        roomId,
        fromUserId: userId,
        signalType,
        payload,
      });
    });

    // Persistent meeting-level chat — every message is written against
    // the meeting's roomId (GroupCallMessage), never held only in memory,
    // so it survives a participant leaving and later rejoining the same
    // meeting. The server assigns the real _id/createdAt and broadcasts
    // to the WHOLE room, sender included, so every tab ends up with the
    // one persisted copy rather than a client-only optimistic message
    // that could drift from what got saved.
    socket.on("groupCallChatMessage", async ({ roomId, message }) => {
      if (!roomId || typeof message !== "string" || !message.trim()) return;

      const room = groupCallRooms.get(roomId);
      // Only someone actually in this call room can send/receive its chat.
      if (!room || !room.has(userKey)) return;

      try {
        const saved = await GroupCallMessage.create({
          roomId,
          sender: userId,
          message: message.trim().slice(0, 1000),
        });

        const chatMessage = {
          _id: String(saved._id),
          roomId,
          fromUserId: userId,
          message: saved.message,
          sentAt: saved.createdAt,
        };

        io.to(getGroupCallRoomName(roomId)).emit("groupCallChatMessage", chatMessage);
      } catch (err) {
        console.error("groupCallChatMessage error:", err.message);
      }
    });

    // Per-participant read cursor for the meeting chat. Deliberately not
    // a flag on the message itself (see CallChatReadState) — each
    // participant's own "read up to here" position is independent, so
    // this only ever updates the (roomId, userId) document, upserting it
    // the first time this participant reads anything in this meeting.
    socket.on("markCallChatRead", async ({ roomId, lastReadMessageId }) => {
      if (!roomId || !lastReadMessageId) return;
      const room = groupCallRooms.get(roomId);
      if (!room || !room.has(userKey)) return;

      try {
        await CallChatReadState.findOneAndUpdate(
          { roomId, user: userId },
          { lastReadMessageId, lastReadAt: new Date() },
          { upsert: true }
        );
      } catch (err) {
        console.error("markCallChatRead error:", err.message);
      }
    });

    // Host-only: forcibly remove another participant from the room. Only
    // the person who created this call (Call.initiator) may do this — same
    // permission model as a Meet/WhatsApp call organizer removing someone.
    // We tell the removed participant's socket directly (so their own UI
    // tears down immediately) and also update the room/DB bookkeeping here
    // ourselves, rather than waiting on their client to call
    // "leaveCallRoom" back — that keeps everyone else's view correct even
    // if the removed person's tab is slow, backgrounded, or unresponsive.
    socket.on("removeParticipant", async ({ roomId, targetUserId }) => {
      if (!roomId || !targetUserId) return;
      if (String(targetUserId) === userKey) return;

      try {
        // Read-only lookup, just to check permissions — the actual
        // leftAt/duration and status changes below are done as targeted
        // atomic updates (never a full `call.save()`), so this being
        // slightly stale by the time they run isn't a problem, unlike the
        // old fetch-mutate-save pattern (see joinCallRoom's comment above
        // for why that could silently drop a concurrent update).
        const call = await Call.findOne({ roomId }).select("initiator participants");
        if (!call) return;
        if (String(call.initiator) !== userKey) {
          socket.emit("groupCallError", {
            message: "Only the person who started the call can remove someone.",
          });
          return;
        }

        const room = groupCallRooms.get(roomId);
        const targetKey = String(targetUserId);
        const targetSocketId = room?.get(targetKey);
        if (!targetSocketId) return;

        io.to(targetSocketId).emit("removedFromCall", { roomId });

        room.delete(targetKey);
        const targetEntry = [...call.participants]
          .reverse()
          .find((p) => String(p.user) === targetKey && !p.leftAt);

        const roomNowEmpty = room.size === 0;
        if (roomNowEmpty) groupCallRooms.delete(roomId);

        if (targetEntry) {
          const leftAt = new Date();
          const duration = Math.max(0, Math.round((leftAt - targetEntry.joinedAt) / 1000));
          // Atomic, targeted update on exactly this participant's
          // sub-document (matched by user + joinedAt, which is unique per
          // join session) — no read-modify-write race with anyone else's
          // concurrent join/leave on the same Call document.
          await Call.updateOne(
            {
              roomId,
              "participants.user": targetEntry.user,
              "participants.joinedAt": targetEntry.joinedAt,
            },
            {
              $set: {
                "participants.$.leftAt": leftAt,
                "participants.$.duration": duration,
                ...(roomNowEmpty ? { status: "ended", endedAt: leftAt } : {}),
              },
            }
          );
        } else if (roomNowEmpty) {
          await Call.updateOne(
            { roomId },
            { $set: { status: "ended", endedAt: new Date() } }
          );
        }

        if (roomNowEmpty) {
          setTimeout(
            () => enqueueGroupCallTranscription(roomId, io),
            TRANSCRIPTION_START_DELAY_MS
          );
        }

        io.to(getGroupCallRoomName(roomId)).emit("peerLeft", {
          roomId,
          peerId: targetKey,
        });

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          targetSocket.leave(getGroupCallRoomName(roomId));
          targetSocket.data.activeCallRoom = null;
        }
      } catch (err) {
        console.error("removeParticipant error:", err.message);
        socket.emit("groupCallError", { message: "Couldn't remove that participant." });
      }
    });

    async function leaveGroupCallRoom(roomId) {
      const room = groupCallRooms.get(roomId);
      if (!room || !room.has(userKey)) return;

      room.delete(userKey);
      socket.leave(getGroupCallRoomName(roomId));
      socket.data.activeCallRoom = null;

      try {
        const call = await Call.findOne({ roomId }).select("participants");
        if (call) {
          const entry = [...call.participants]
            .reverse()
            .find((p) => String(p.user) === userKey && !p.leftAt);

          // Last person out seals the log — no room to re-enter, no
          // lingering "ongoing" call left behind.
          const roomNowEmpty = room.size === 0;
          if (roomNowEmpty) groupCallRooms.delete(roomId);

          // Same atomic, targeted updates as removeParticipant above —
          // never a full `call.save()`, so a concurrent join/leave on this
          // same room (e.g. right after a 1:1-to-group upgrade, where
          // several "joinCallRoom"/"leaveCallRoom" calls can land within
          // milliseconds of each other) can't silently clobber this one.
          if (entry) {
            const leftAt = new Date();
            const duration = Math.max(0, Math.round((leftAt - entry.joinedAt) / 1000));
            await Call.updateOne(
              {
                roomId,
                "participants.user": entry.user,
                "participants.joinedAt": entry.joinedAt,
              },
              {
                $set: {
                  "participants.$.leftAt": leftAt,
                  "participants.$.duration": duration,
                  ...(roomNowEmpty ? { status: "ended", endedAt: leftAt } : {}),
                },
              }
            );
          } else if (roomNowEmpty) {
            await Call.updateOne(
              { roomId },
              { $set: { status: "ended", endedAt: new Date() } }
            );
          }

          if (roomNowEmpty) {
            setTimeout(
              () => enqueueGroupCallTranscription(roomId, io),
              TRANSCRIPTION_START_DELAY_MS
            );
          }
        }
      } catch (err) {
        console.error("leaveGroupCallRoom error:", err.message);
      }

      socket.to(getGroupCallRoomName(roomId)).emit("peerLeft", {
        roomId,
        peerId: userId,
      });
    }

    socket.on("leaveCallRoom", ({ roomId }) => {
      if (roomId) leaveGroupCallRoom(roomId);
    });

    // ---- Disconnect ----
    socket.on("disconnect", async () => {
      const userKey = String(userId);
      const userSockets = onlineUsers.get(userKey);
      if (userSockets) {
        userSockets.delete(socket.id);
if (userSockets.size === 0) {
  onlineUsers.delete(userKey);
  const lastSeen = new Date();
  try {
    const stillOnline = onlineUsers.has(userKey);
    await User.findByIdAndUpdate(userId, {
      isOnline: stillOnline,
      ...(stillOnline ? {} : { lastSeen }),
    });
  } catch (err) {
    console.error("Error setting user offline:", err.message);
  }
  socket.broadcast.emit("userOffline", { userId, lastSeen });

  // If this user dropped mid-call (closed the tab, lost connection,
  // etc.), let their call partner know instead of leaving them stuck
  // on a frozen video feed — and still log the call (completed if it
  // had been answered, missed otherwise) so it doesn't just vanish.
  const otherUserId = clearActiveCall(userKey);
  if (otherUserId) {
    const roomName = getRoomName(userKey, otherUserId);
    const meta = callLogMeta.get(roomName);
    callLogMeta.delete(roomName);
    if (meta) {
      logCall(io, {
        callerId: meta.callerId,
        calleeId: meta.calleeId,
        callType: meta.callType,
        status: meta.answeredAt ? "completed" : "missed",
        startedAt: meta.answeredAt,
      });
      finalizeDirectCallRecording(io, meta);
    }
    io.to(getUserRoomName(otherUserId)).emit("callEnded", {
      reason: "disconnected",
    });
  }

  // Same cleanup for a dropped group call — records leftAt/duration and
  // seals the log if that was the last person in the room.
  if (socket.data.activeCallRoom) {
    await leaveGroupCallRoom(socket.data.activeCallRoom);
  }
}
      }
    });
  });
}

module.exports = {
  initSocket,
  getReceiverSocketId,
  onlineUsers,
};