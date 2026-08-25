const mongoose = require("mongoose");

// One persistent chat, scoped to the MEETING (Call.roomId), not to any
// single participant's session. A message is written here once, on send,
// and lives for as long as the Call document itself — leaving and
// rejoining the same room never creates a new chat and never deletes or
// resets anything here. This is deliberately a separate model from
// Message (the 1:1/DM chat): a meeting's chat has no "receiver", can have
// any number of participants, and its read state is tracked separately
// per participant (see CallChatReadState) rather than a single global
// status field.
const groupCallMessageSchema = new mongoose.Schema(
  {
    // Call.roomId — a plain string, not an ObjectId ref, matching how the
    // rest of the group-call code (Socketmanager.js, Callroutes.js)
    // already keys everything off roomId rather than Call._id.
    roomId: { type: String, required: true, index: true },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
  },
  { timestamps: true }
);

// Powers both the initial history load on join and cursor-based
// pagination for scrolling further back — same shape as
// Message's { sender, receiver, createdAt } index for the same reason.
groupCallMessageSchema.index({ roomId: 1, createdAt: 1 });

module.exports = mongoose.model("GroupCallMessage", groupCallMessageSchema);