const mongoose = require("mongoose");

// A participant's own read cursor into one meeting's chat. Deliberately a
// separate document per (roomId, user) rather than an `isRead` flag on
// GroupCallMessage — a single message is simultaneously read by some
// participants and unread by others, so read state can only ever belong
// to the (meeting, participant) pair, never to the message itself.
const callChatReadStateSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The newest GroupCallMessage this participant has seen. Everything
    // in the chat after this point is, by definition, unread for them.
    lastReadMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GroupCallMessage",
      default: null,
    },
    lastReadAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// One read-state document per participant per meeting — upserted every
// time they view the chat (see "markCallChatRead" in Socketmanager.js).
callChatReadStateSchema.index({ roomId: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("CallChatReadState", callChatReadStateSchema);