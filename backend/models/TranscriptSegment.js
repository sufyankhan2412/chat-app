const mongoose = require("mongoose");

// Live transcript segments - created during the call in real-time
// as audio is processed by Groq Whisper. These are separate from
// Call.transcript (the final post-processed transcript from whisper.cpp)
// to allow live updates without modifying the historical processing.
const transcriptSegmentSchema = new mongoose.Schema(
  {
    // Which call/meeting this segment belongs to
    roomId: { type: String, required: true, index: true },
    callId: { type: String, required: true, index: true },
    
    // Which Call document this belongs to (can be populated)
    call: { type: mongoose.Schema.Types.ObjectId, ref: "Call", required: true, index: true },
    
    // Speaker identity
    participantId: { type: String, required: true }, // userId from auth
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    speakerName: { type: String, required: true }, // Cached for faster display
    
    // Timing relative to call start (milliseconds)
    startTimeMs: { type: Number, required: true },
    endTimeMs: { type: Number, required: true },
    
    // Transcribed text from Groq
    text: { type: String, required: true },
    
    // Groq metadata (optional)
    confidence: { type: Number, default: null }, // 0-1 if Groq provides it
    language: { type: String, default: null }, // Detected language
    
    // Processing metadata
    audioChunkSeq: { type: Number, default: null }, // Which chunk sequence this came from
    processingTimeMs: { type: Number, default: null }, // How long Groq took
    
    // Overlap detection (filled in after segment is created)
    overlapsWith: [{ type: String }], // Array of other participant names
  },
  { 
    timestamps: true // createdAt, updatedAt
  }
);

// Compound indexes for common queries
transcriptSegmentSchema.index({ roomId: 1, startTimeMs: 1 }); // Get segments by time order
transcriptSegmentSchema.index({ call: 1, participantId: 1 }); // Get one participant's segments
transcriptSegmentSchema.index({ roomId: 1, createdAt: 1 }); // Get live updates in order

module.exports = mongoose.model("TranscriptSegment", transcriptSegmentSchema);
