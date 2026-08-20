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

    // "text" is a normal chat message. The attachment types are image/
    // video/file/voice. "call" is a synthetic, WhatsApp-style call-log
    // entry: it's never typed by a user, only ever created server-side
    // (see socket/Socketmanager.js) once a call finishes ringing/ends, so
    // it can flow through the exact same message pipeline (sockets, REST
    // history, sidebar previews) that every other message already uses.
    type: {
      type: String,
      enum: ["text", "image", "video", "file", "voice", "call"],
      default: "text",
    },

    content: {
      type: String,
      trim: true,
      default: "",
      required: function () {
      
        return this.type === "text" && !this.deletedForEveryone;
      },
    },

    attachment: {
      url: { type: String },
      fileName: { type: String },
      fileSize: { type: Number }, // bytes
      mimeType: { type: String },
      duration: { type: Number }, // seconds — voice notes and videos only
    },

    // Populated only when type === "call". `sender` is always whoever
    // placed the call (the caller) and `receiver` the callee — same
    // convention as every other message type — so a call's direction for
    // any given viewer is just "am I the sender or the receiver".
    call: {
      callType: { type: String, enum: ["audio", "video"] },
      // "completed"  -> answered and later ended normally (duration > 0)
      // "missed"     -> never answered (no answer, or caller cancelled first)
      // "declined"   -> callee explicitly rejected it before answering
      status: { type: String, enum: ["completed", "missed", "declined"] },
      duration: { type: Number, default: 0 }, // seconds — "completed" only
    },

    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },

   
    starredBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: [],
      },
    ],

    
    expiresAt: {
      type: Date,
      default: null,
    },

    
    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: [],
      },
    ],


    deletedForEveryone: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },


    deleteForEveryonePendingAt: {
      type: Date,
      default: null,
    },

    deleteForEveryoneUndoExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

messageSchema.index({ sender: 1, receiver: 1, createdAt: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Message", messageSchema);