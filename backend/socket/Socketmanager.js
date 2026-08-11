const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Message = require("../models/Message");

// In-memory map of userId -> Set<socketId> for currently connected users
const onlineUsers = new Map();

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

        const message = await Message.create({
          sender: userId,
          receiver: receiverId,
          type,
          content: content ? content.trim() : "",
          ...(isTextMessage ? {} : { attachment }),
          status,
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