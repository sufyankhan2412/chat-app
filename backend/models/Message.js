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
  },
  { timestamps: true }
);

messageSchema.index({ sender: 1, receiver: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);