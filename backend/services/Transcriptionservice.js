const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const Call = require("../models/Call");
const { callAudioDir } = require("../middleware/upload");

const TRANSCRIPTS_DIR = path.join(__dirname, "..", "uploads", "transcripts");
fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Path to a whisper.cpp-style CLI binary that takes "-f <audio>" and
// writes "<outBase>.json" with -oj/-of. Override via env if it's not on
// PATH, or if you swap in a different engine (see transcribeFile's
// comment below for what shape it needs to return).
const WHISPER_CLI = process.env.WHISPER_CLI_PATH || "whisper-cli";

// Absolute path to the ggml model file whisper-cli should load. This
// MUST be set — whisper-cli's own default ("models/ggml-base.en.bin")
// is resolved relative to whatever directory the process is launched
// from, which for this backend is never whisper.cpp's own folder, so
// the built-in default reliably fails with "failed to open
// 'models/ggml-base.en.bin'" / "failed to initialize whisper context"
// no matter what audio is passed in. Passing an absolute path via -m
// removes that dependency on cwd entirely.
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH;
if (!WHISPER_MODEL_PATH) {
  console.warn(
    "[Transcriptionservice] WHISPER_MODEL_PATH is not set — every " +
      "transcription will fail with 'failed to initialize whisper " +
      "context'. Set it to the absolute path of a ggml-*.bin model file."
  );
}
// "base" (whether ggml-base.bin or ggml-base.en.bin) is whisper.cpp's
// smallest usable model and has a noticeably higher word-error-rate than
// "small" or "medium" — exactly the gap that shows up as garbled or
// missed words on real, imperfect group-call audio (cross-talk, laptop
// mics, people not centered on their mic). If transcripts are coming out
// wrong rather than just occasionally missing a word, the single biggest
// lever is usually swapping WHISPER_MODEL_PATH to a bigger model
// (ggml-small.bin is a good accuracy/speed tradeoff; ggml-medium.bin if
// the server has the CPU/RAM for it), not tuning the flags below.
//
// Also default to a fixed language rather than auto-detect: on a short,
// noisy, or overlapping-speech clip, whisper's language auto-detection
// (what runs when no "-l" is given) can guess wrong, and a wrong
// language guess produces fluent-looking text in the WRONG language
// rather than an error — silently wrecking that segment. Set
// WHISPER_LANGUAGE to "auto" in .env if calls are genuinely
// multilingual; otherwise pin it to whatever language is actually
// spoken.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "en";
// Beam search (vs. the CLI's default greedy decoding) trades a bit of
// speed for meaningfully better accuracy on the same model — worth it
// here since transcription already happens asynchronously after the
// call ends, so nothing user-facing is waiting on it.
const WHISPER_BEAM_SIZE = process.env.WHISPER_BEAM_SIZE || "5";

// Optional: path to a Silero VAD ggml model (see the .env comment near
// WHISPER_VAD_MODEL_PATH for how to get one). Without this, whisper.cpp
// decodes in fixed ~30s windows and — on short clips with a little
// speech surrounded by silence — can report a segment's timestamps as
// spanning the ENTIRE 30s window instead of just where the words were.
// That's not just cosmetic: two people's segments both getting
// full-window timestamps makes them trivially "overlap" in
// detectOverlaps below even if they actually spoke one after another.
// VAD fixes this at the source by telling whisper.cpp exactly where the
// speech actually is before it decodes anything.
const WHISPER_VAD_MODEL_PATH = process.env.WHISPER_VAD_MODEL_PATH || "";

// Stock phrases whisper.cpp reliably hallucinates on pure silence/noise
// (very common in the quiet stretches every real call has) rather than
// actual speech. These would otherwise show up in the transcript as if
// someone said them. This list is intentionally narrow — only near-exact
// boilerplate whisper is known to emit on silence, not a general
// profanity/quality filter — so real short utterances ("okay", "yeah")
// are never dropped.
const HALLUCINATION_PATTERNS = [
  /^\s*\[\s*(blank[_ ]audio|silence|no speech|inaudible)\s*\]\s*$/i,
  /^\s*\(\s*(silence|no speech|inaudible)\s*\)\s*$/i,
  /^\s*(thanks for watching!?|thank you for watching!?|subscribe.*channel)\s*\.?\s*$/i,
  /^\s*you\s*$/i,
];
function isLikelyHallucination(text) {
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------
// Filenames look like "<userId>-<joinedAtMs>-<seq>.webm" (written by
// saveCallAudioChunk in middleware/upload.js) — one file PER uploaded
// chunk, not one growing file per join session. `seq` is the chunk's
// recorded order; it's what lets us glue chunks back together correctly
// even though they may have arrived at the server out of order (see
// upload.js for why that happens). We take the FIRST "-" to split off
// userId (a Mongo ObjectId, which never contains a "-") and the LAST
// "-" to split off seq, leaving joinedAtMs in the middle.
// ---------------------------------------------------------------------
function parseAudioChunkFilename(filename) {
  const base = filename.replace(/\.webm$/i, "");
  const firstIdx = base.indexOf("-");
  const lastIdx = base.lastIndexOf("-");
  if (firstIdx === -1 || lastIdx === firstIdx) return null;
  const userId = base.slice(0, firstIdx);
  const joinedAtMs = Number(base.slice(firstIdx + 1, lastIdx));
  const seq = Number(base.slice(lastIdx + 1));
  if (!Number.isFinite(joinedAtMs) || !Number.isFinite(seq)) return null;
  return { userId, joinedAtMs, seq };
}

// Runs one audio file through the transcription engine and returns
// [{ start, end, text }] with start/end in seconds, relative to the
// start of THIS file (i.e. relative to when this one join session's
// recording began — the caller is responsible for offsetting these onto
// the shared call timeline). Swap this function out to use a different
// engine (e.g. a small faster-whisper Python subprocess) as long as it
// keeps returning that same shape.
// whisper-cli reads audio through miniaudio, which can decode WAV, MP3,
// FLAC, and OGG Vorbis — but NOT the WebM/Opus container that the
// browser's MediaRecorder produces (confirmed by whisper-cli itself:
// "read_audio_data: trying to decode with miniaudio" / "failed to read
// audio data"). So every .webm this app produces needs to be converted
// to a plain 16kHz mono WAV file before whisper-cli can read it at all —
// this has nothing to do with chunk ordering or the model path; without
// this conversion, transcription was never going to succeed on ANY
// recording, regardless of how clean the audio itself is.
function convertToWav(webmPath) {
  return new Promise((resolve, reject) => {
    const wavPath = webmPath.replace(/\.webm$/i, ".wav");
    execFile(
      ffmpegPath,
      [
        "-y", // overwrite if it already exists (safe to re-run)
        "-i", webmPath,
        // In a group call, people sit at very different distances from
        // their mic, so raw levels between speakers can differ by a lot
        // even after the browser's own AGC — the quieter ones are
        // exactly where a small Whisper model starts missing words.
        //
        // IMPORTANT: dynaudnorm on its own is NOT noise reduction — it's
        // a loudness normalizer. It boosts every frame (including silent/
        // quiet ones) up toward a target level, so a quiet stretch that
        // contains only hiss/hum/room noise gets boosted right along with
        // it. With a large gain factor that's audible pumping of the
        // noise floor during pauses — the "removing noise actually makes
        // it worse" symptom. The chain below fixes that by actually
        // reducing noise BEFORE normalizing, and by gating near-silence
        // afterward so nothing is left to pump:
        //   1. highpass=f=80   - cuts sub-80Hz rumble/AC hum without
        //                        eating low-pitched (e.g. male) voice
        //                        fundamentals the way f=100 could.
        //   2. afftdn=nf=-25   - FFT-based noise reduction: estimates the
        //                        noise floor and subtracts it, i.e. actual
        //                        denoising, which was previously missing
        //                        entirely from this chain.
        //   3. dynaudnorm=...  - normalizes level across speakers, but
        //                        with a smaller gain factor (g=7) and
        //                        longer analysis window (f=200) than
        //                        before, so it evens out volume without
        //                        aggressively pumping quiet frames.
        //   4. agate=...       - mutes near-silent frames outright after
        //                        normalization, so any residual noise in
        //                        pauses doesn't get transcribed as
        //                        hallucinated words and isn't audible in
        //                        the final WAV.
        // If mic noise is still rough after this, swap afftdn for
        // arnndn=m=<path-to-rnnoise-model.rnnn> (RNNoise) — meaningfully
        // better than afftdn for voice/mic noise, but needs a model file.
        "-af",
        "highpass=f=80,afftdn=nf=-25,dynaudnorm=f=200:g=7:p=0.7:m=10,agate=threshold=0.02:ratio=4",
        "-ar", "16000", // 16kHz — what whisper.cpp models expect
        "-ac", "1", // mono
        "-c:a", "pcm_s16le", // plain PCM, which miniaudio can always read
        wavPath,
      ],
      (err) => {
        if (err) return reject(err);
        resolve(wavPath);
      }
    );
  });
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
    if (!WHISPER_MODEL_PATH) {
      return reject(new Error("WHISPER_MODEL_PATH is not set"));
    }
    const outBase = filePath.replace(/\.(webm|wav)$/i, "");
    const args = [
      "-f", filePath,
      "-m", WHISPER_MODEL_PATH,
      "-oj", "-of", outBase, "-nt",
      "-bs", WHISPER_BEAM_SIZE, // beam search — see comment near WHISPER_BEAM_SIZE above
    ];
    if (WHISPER_LANGUAGE !== "auto") args.push("-l", WHISPER_LANGUAGE);
    if (WHISPER_VAD_MODEL_PATH) args.push("--vad", "-vm", WHISPER_VAD_MODEL_PATH);
    execFile(
      WHISPER_CLI,
      args,
      (err) => {
        if (err) return reject(err);
        try {
          const raw = JSON.parse(fs.readFileSync(`${outBase}.json`, "utf8"));
          const segments = (raw.transcription || [])
            .map((seg) => ({
              start: (seg.offsets?.from ?? 0) / 1000,
              end: (seg.offsets?.to ?? 0) / 1000,
              text: (seg.text || "").trim(),
            }))
            .filter((seg) => seg.text.length > 0 && !isLikelyHallucination(seg.text));
          resolve(segments);
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

// Flags, on each segment, which OTHER speakers' segments it overlaps in
// time. `segments` must already be sorted by `start`. This is the same
// check regardless of whether there are 2 speakers or 10 — it only ever
// compares time ranges, never audio — so nothing here changes between
// 1:1 calls and group calls.
//
// One important caveat: whisper.cpp decodes in fixed ~30s windows, and
// on short clips with a little speech surrounded by silence it can
// report a segment's timestamps as spanning the WHOLE window rather
// than just where the words were. Two such segments trivially "overlap"
// even if the people actually spoke one after another. Using
// WHISPER_VAD_MODEL_PATH (see Transcriptionservice.js/.env) fixes this
// at the source; this length check is a fallback for when VAD isn't
// configured — segments implausibly long relative to their own text
// are excluded from overlap detection rather than trusted at face value.
const MAX_PLAUSIBLE_SECONDS_PER_WORD = 3; // generous — real speech is ~0.3-0.5s/word
function isTimestampSuspect(seg) {
  const wordCount = seg.text.split(/\s+/).filter(Boolean).length || 1;
  return (seg.end - seg.start) > wordCount * MAX_PLAUSIBLE_SECONDS_PER_WORD;
}
function detectOverlaps(segments) {
  for (let i = 0; i < segments.length; i++) {
    if (isTimestampSuspect(segments[i])) continue;
    for (let j = i + 1; j < segments.length && segments[j].start < segments[i].end; j++) {
      if (segments[j].speaker === segments[i].speaker) continue;
      if (isTimestampSuspect(segments[j])) continue;
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
      ? fs.readdirSync(audioDir).filter((f) => f.endsWith(".webm") && !f.includes(".combined."))
      : [];

    // Group this room's chunk files by join session (userId + joinedAtMs)
    // so every chunk from one MediaRecorder session gets glued back into
    // ONE file, in the order it was actually recorded — never in
    // whatever order the uploads happened to land at the server in.
    const sessions = new Map(); // `${userId}-${joinedAtMs}` -> [{ seq, file }]
    files.forEach((file) => {
      const parsed = parseAudioChunkFilename(file);
      if (!parsed) return;
      const key = `${parsed.userId}-${parsed.joinedAtMs}`;
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push({ seq: parsed.seq, file, ...parsed });
    });

    const coveredJoins = new Set(); // `${userId}-${joinedAtMs}` that had at least one chunk

    const jobs = [...sessions.entries()].map(async ([key, rawChunks]) => {
      rawChunks.sort((a, b) => a.seq - b.seq);
      const { userId, joinedAtMs } = rawChunks[0];

      // Integrity check before combining: dedupe any seq that landed more
      // than once (a client retry re-uploading the same chunk after a
      // dropped response — saveCallAudioChunk overwrites the file itself,
      // but if it somehow produced two distinct files for one seq we
      // still only want to glue in the first), and note any gaps in the
      // sequence so a truncated/incomplete session shows up in the logs
      // instead of silently jumping over missing audio.
      const seenSeqs = new Set();
      const duplicateChunks = [];
      const chunks = rawChunks.filter((c) => {
        if (seenSeqs.has(c.seq)) {
          duplicateChunks.push(c.seq);
          return false;
        }
        seenSeqs.add(c.seq);
        return true;
      });

      const expectedChunks = chunks.length ? chunks[chunks.length - 1].seq + 1 : 0;
      const receivedChunks = chunks.length;
      const missingChunks = [];
      for (let i = 0; i < expectedChunks; i++) {
        if (!seenSeqs.has(i)) missingChunks.push(i);
      }
      const chunkOrder = chunks.map((c) => c.seq);

      console.log("[audio-session:finalize]", {
        recordingId: roomId,
        session: key,
        expectedChunks,
        receivedChunks,
        missingChunks,
        duplicateChunks,
        chunkOrder,
      });

      const entry = call.participants.find(
        (p) => String(p.user?._id || p.user) === userId && p.joinedAt.getTime() === joinedAtMs
      );
      if (!entry) return []; // stray/unmatched session — ignore rather than guess

      coveredJoins.add(key);
      const speakerName = entry.user?.username || "Unknown";
      const offsetSec = (joinedAtMs - call.startedAt.getTime()) / 1000;

      // Glue this session's chunks together, in RECORDED (seq) order, into
      // one valid WebM file...
      const combinedPath = path.join(audioDir, `${key}.combined.webm`);
      const buffers = chunks.map((c) => fs.readFileSync(path.join(audioDir, c.file)));
      fs.writeFileSync(combinedPath, Buffer.concat(buffers));

      try {
        // ...then convert it to WAV, since whisper-cli can't read
        // WebM/Opus directly (see convertToWav's comment above).
        const wavPath = await convertToWav(combinedPath);
        const rawSegments = await transcribeFile(wavPath);
        return rawSegments.map((s) => ({
          speaker: speakerName,
          start: offsetSec + s.start,
          end: offsetSec + s.end,
          text: s.text,
        }));
      } catch (err) {
        console.error(`Transcription failed for join session ${key}:`, err.stack || err.message || err);
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