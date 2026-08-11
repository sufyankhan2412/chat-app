const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // "text" is a normal chat message. The rest are attachment messages —
    // content becomes an optional caption instead of the required body.
    type: {
      type: String,
      enum: ["text", "image", "video", "file", "voice"],
      default: "text",
    },

    content: {
      type: String,
      trim: true,
      default: "",
      required: function () {
        return this.type === "text";
      },
    },

    // Only present when type !== "text". Populated from the file that was
    // uploaded via POST /api/messages/upload before this message was sent.
    attachment: {
      url: { type: String },
      fileName: { type: String },
      fileSize: { type: Number }, // bytes
      mimeType: { type: String },
      duration: { type: Number }, // seconds — voice notes and videos only
    },

    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },

    // Who has starred this message, WhatsApp-style: starring is private to
    // each user, so the same message can be starred for one participant
    // and not the other.
    starredBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: [],
      },
    ],

    // Only set when the sender had "disappearing messages" turned on for
    // this chat at send time. A TTL index (below) makes MongoDB delete the
    // document itself once this time passes — no cron job needed.
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

messageSchema.index({ sender: 1, receiver: 1, createdAt: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Message", messageSchema);