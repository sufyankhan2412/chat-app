const mongoose = require("mongoose");

// One entry per person who actually joined the room. `mode` is that
// person's own choice (audio-only or with camera) — independent of what
// anyone else in the room picked, exactly like Meet lets each participant
// join however they want. `duration` is stamped in seconds the moment they
// leave (or the room is torn down), so it never needs to be recomputed
// later — every attendee's own log entry is just this array, already
// resolved.
const participantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    mode: { type: String, enum: ["audio", "video"], required: true },
    joinedAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
    duration: { type: Number, default: 0 }, // seconds
  },
  { _id: false }
);

// A Call document IS the call-link session. It's created the instant
// someone generates a link (status "ongoing", no participants yet) and is
// sealed once the room empties (status "ended"). Nothing about it is a
// standing "group" — there's no membership list, no name, no way to
// re-enter it once ended, and a brand new roomId/link is required for the
// next call. It exists purely so every attendee has something to query
// back into their own call log, WhatsApp-group-call-style.
const callSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    initiator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // The type the *link* was generated for (shown in the join screen /
    // log title). Individual joiners can still pick their own mode.
    callType: { type: String, enum: ["audio", "video"], required: true },
    status: { type: String, enum: ["ongoing", "ended"], default: "ongoing" },
    participants: [participantSchema],
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    // Soft "delete from my log" — same convention as Message.deletedFor,
    // per-user only, never touches anyone else's copy of the log.
    deletedFor: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] },
    ],

    // Filled in by backend/services/transcriptionService.js once every
    // participant's own locally-recorded audio (see GroupCallContext.jsx —
    // calls are mesh WebRTC, so the server never otherwise sees any media)
    // has been uploaded and run through transcription. "not_started" until
    // the room empties, then "processing" for the (short) merge job, then
    // "completed"/"failed". txtPath/jsonPath point at files under
    // backend/uploads/transcripts/, not at anything web-servable directly —
    // they're only ever read back through the authenticated
    // GET /api/calls/:roomId/transcript route.
    transcript: {
      status: {
        type: String,
        enum: ["not_started", "processing", "completed", "failed"],
        default: "not_started",
      },
      txtPath: { type: String, default: null },
      jsonPath: { type: String, default: null },
      // Usernames of anyone who joined but never produced any usable
      // audio (denied mic permission, crashed before the first chunk
      // uploaded, etc.) — surfaced to the viewer rather than silently
      // dropping them from the transcript.
      missingParticipants: [{ type: String }],
      error: { type: String, default: null },
      completedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

callSchema.index({ "participants.user": 1, createdAt: -1 });

module.exports = mongoose.model("Call", callSchema);