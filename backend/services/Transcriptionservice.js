const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const Call = require("../models/Call");
const { callAudioDir } = require("../middleware/upload");

const TRANSCRIPTS_DIR = path.join(__dirname, "..", "uploads", "transcripts");
fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Path to a whisper.cpp-style CLI binary that takes "-f <audio>" and
// writes "<outBase>.json" with -oj/-of. Override via env if it's not on
// PATH, or if you swap in a different engine (see transcribeFile's
// comment below for what shape it needs to return).
const WHISPER_CLI = process.env.WHISPER_CLI_PATH || "whisper-cli";

// ---------------------------------------------------------------------
// Filenames look like "<userId>-<joinedAtMs>.webm" (written by
// appendCallAudioChunk in middleware/upload.js). We split on the LAST
// "-" rather than the first, since joinedAtMs is always purely numeric
// and userId (a Mongo ObjectId) never contains one — this is just a
// little more defensive than assuming ObjectIds are always hyphen-free.
// ---------------------------------------------------------------------
function parseAudioFilename(filename) {
  const base = filename.replace(/\.webm$/i, "");
  const idx = base.lastIndexOf("-");
  if (idx === -1) return null;
  const joinedAtMs = Number(base.slice(idx + 1));
  if (!Number.isFinite(joinedAtMs)) return null;
  return { userId: base.slice(0, idx), joinedAtMs };
}

// Runs one audio file through the transcription engine and returns
// [{ start, end, text }] with start/end in seconds, relative to the
// start of THIS file (i.e. relative to when this one join session's
// recording began — the caller is responsible for offsetting these onto
// the shared call timeline). Swap this function out to use a different
// engine (e.g. a small faster-whisper Python subprocess) as long as it
// keeps returning that same shape.
function transcribeFile(filePath) {
  return new Promise((resolve, reject) => {
    const outBase = filePath.replace(/\.webm$/i, "");
    execFile(WHISPER_CLI, ["-f", filePath, "-oj", "-of", outBase, "-nt"], (err) => {
      if (err) return reject(err);
      try {
        const raw = JSON.parse(fs.readFileSync(`${outBase}.json`, "utf8"));
        const segments = (raw.transcription || [])
          .map((seg) => ({
            start: (seg.offsets?.from ?? 0) / 1000,
            end: (seg.offsets?.to ?? 0) / 1000,
            text: (seg.text || "").trim(),
          }))
          .filter((seg) => seg.text.length > 0);
        resolve(segments);
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

// Flags, on each segment, which OTHER speakers' segments it overlaps in
// time. `segments` must already be sorted by `start`. This is the same
// check regardless of whether there are 2 speakers or 10 — it only ever
// compares time ranges, never audio — so nothing here changes between
// 1:1 calls and group calls.
function detectOverlaps(segments) {
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length && segments[j].start < segments[i].end; j++) {
      if (segments[j].speaker === segments[i].speaker) continue;
      segments[i].overlapsWith = segments[i].overlapsWith || [];
      segments[j].overlapsWith = segments[j].overlapsWith || [];
      segments[i].overlapsWith.push(segments[j].speaker);
      segments[j].overlapsWith.push(segments[i].speaker);
    }
  }
  return segments;
}

function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${ss}`
    : `${m}:${ss}`;
}

function renderTranscriptText({ roomId, participantNames, startedAt, endedAt, segments, missing }) {
  const lines = [];
  const divider = "=".repeat(32);

  lines.push("Call Transcript");
  lines.push(divider);
  lines.push(`Room: ${roomId}`);
  lines.push(`Date: ${startedAt.toLocaleString()}`);
  lines.push(`Duration: ${formatTimestamp((endedAt - startedAt) / 1000)}`);
  lines.push("");
  lines.push("Participants:");
  participantNames.forEach((name) => lines.push(`- ${name}`));
  lines.push(divider);
  lines.push("");

  if (!segments.length) {
    lines.push("(No speech was transcribed for this call.)");
  }

  const announcedOverlaps = new Set();
  segments.forEach((seg, i) => {
    lines.push(`[${formatTimestamp(seg.start)}] ${seg.speaker}:`);
    lines.push(seg.text);
    lines.push("");

    if (seg.overlapsWith?.length && !announcedOverlaps.has(i)) {
      announcedOverlaps.add(i);
      const others = [...new Set(seg.overlapsWith)].join(", ");
      lines.push(`[${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}]`);
      lines.push(`\u26A0 Overlapping speech detected (with ${others})`);
      lines.push("");
    }
  });

  if (missing.length) {
    lines.push(divider);
    lines.push(`Note: no usable audio was captured for: ${missing.join(", ")}`);
  }

  lines.push(divider);
  lines.push("End of Transcript");
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Main entry point — called once a group call's room empties (see
// Socketmanager.js's leaveGroupCallRoom / removeParticipant), a short
// delay after `call.status` flips to "ended" so any last chunk uploads
// still in flight over the network have a chance to land first.
//
// For each uploaded audio file: figure out which participant + which
// join session it belongs to (from the filename), transcribe it on its
// own, then shift its segments onto the shared call timeline using that
// join's own recorded offset from call.startedAt. Because every file is
// already isolated to one person's own microphone, "who said this" is
// answered by the filename, never by guessing from the audio itself —
// two people talking at once just becomes two segments whose time
// ranges overlap, caught by detectOverlaps above. None of this changes
// whether the call had 2 participants or 10.
// ---------------------------------------------------------------------
async function enqueueGroupCallTranscription(roomId, io) {
  const call = await Call.findOne({ roomId }).populate("participants.user", "username");
  if (!call) return;

  call.transcript.status = "processing";
  await call.save();

  try {
    const audioDir = path.join(callAudioDir, roomId);
    const files = fs.existsSync(audioDir)
      ? fs.readdirSync(audioDir).filter((f) => f.endsWith(".webm"))
      : [];

    const coveredJoins = new Set(); // `${userId}-${joinedAtMs}` that had at least one file

    const jobs = files.map(async (file) => {
      const parsed = parseAudioFilename(file);
      if (!parsed) return [];

      const entry = call.participants.find(
        (p) =>
          String(p.user?._id || p.user) === parsed.userId &&
          p.joinedAt.getTime() === parsed.joinedAtMs
      );
      if (!entry) return []; // stray/unmatched file — ignore rather than guess

      coveredJoins.add(`${parsed.userId}-${parsed.joinedAtMs}`);
      const speakerName = entry.user?.username || "Unknown";
      const offsetSec = (parsed.joinedAtMs - call.startedAt.getTime()) / 1000;

      try {
        const rawSegments = await transcribeFile(path.join(audioDir, file));
        return rawSegments.map((s) => ({
          speaker: speakerName,
          start: offsetSec + s.start,
          end: offsetSec + s.end,
          text: s.text,
        }));
      } catch (err) {
        console.error(`Transcription failed for ${file}:`, err.message);
        return [];
      }
    });

    const allSegments = (await Promise.all(jobs)).flat().sort((a, b) => a.start - b.start);
    detectOverlaps(allSegments);

    const missing = [
      ...new Set(
        call.participants
          .filter((p) => !coveredJoins.has(`${String(p.user?._id || p.user)}-${p.joinedAt.getTime()}`))
          .map((p) => p.user?.username || "Unknown")
      ),
    ];

    const participantNames = [...new Set(call.participants.map((p) => p.user?.username || "Unknown"))];

    const txt = renderTranscriptText({
      roomId,
      participantNames,
      startedAt: call.startedAt,
      endedAt: call.endedAt || new Date(),
      segments: allSegments,
      missing,
    });

    const txtPath = path.join(TRANSCRIPTS_DIR, `${roomId}.txt`);
    const jsonPath = path.join(TRANSCRIPTS_DIR, `${roomId}.json`);
    fs.writeFileSync(txtPath, txt, "utf8");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ roomId, participants: participantNames, segments: allSegments, missing }, null, 2)
    );

    call.transcript.status = "completed";
    call.transcript.txtPath = txtPath;
    call.transcript.jsonPath = jsonPath;
    call.transcript.missingParticipants = missing;
    call.transcript.error = null;
    call.transcript.completedAt = new Date();
    await call.save();

    // Notify anyone who was on the call, wherever they are now (Calls
    // tab, a re-opened call-detail modal, etc.) rather than only the
    // (now-empty) call room — everyone's already left it by this point.
    if (io) {
      const userIds = new Set(call.participants.map((p) => String(p.user?._id || p.user)));
      userIds.forEach((uid) => io.to(`user_${uid}`).emit("transcriptReady", { roomId }));
    }
  } catch (err) {
    console.error(`enqueueGroupCallTranscription(${roomId}) error:`, err.message);
    call.transcript.status = "failed";
    call.transcript.error = err.message;
    await call.save();
  }
}

module.exports = { enqueueGroupCallTranscription };