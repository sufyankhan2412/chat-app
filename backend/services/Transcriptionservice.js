const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const Call = require("../models/Call");
const { callAudioDir } = require("../middleware/upload");

const TRANSCRIPTS_DIR = path.join(__dirname, "..", "uploads", "transcripts");
fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Wraps a raw 16-bit little-endian PCM buffer (what pcmRecorder.js
// captures and uploads — see upload.js's saveCallAudioChunk) in a
// standard 44-byte WAV header, so ffmpeg/whisper-cli can open it. Raw
// PCM chunks concatenate perfectly cleanly (no per-chunk headers/framing
// to worry about, unlike the old WebM/Opus chunks), so all this needs to
// do is describe the format of the bytes that follow — no encoding or
// decoding happens here.
function pcmToWavBuffer(pcmBuffer, sampleRate, numChannels = 1, bitsPerSample = 16) {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: 1 = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

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
// Filenames look like "<userId>-<joinedAtMs>-<seq>.pcm" (written by
// saveCallAudioChunk in middleware/upload.js) — one file PER uploaded
// chunk, not one growing file per join session. `seq` is the chunk's
// recorded order; it's what lets us glue chunks back together correctly
// even though they may have arrived at the server out of order (see
// upload.js for why that happens). We take the FIRST "-" to split off
// userId (a Mongo ObjectId, which never contains a "-") and the LAST
// "-" to split off seq, leaving joinedAtMs in the middle.
// ---------------------------------------------------------------------
function parseAudioChunkFilename(filename) {
  const base = filename.replace(/\.pcm$/i, "");
  const firstIdx = base.indexOf("-");
  const lastIdx = base.lastIndexOf("-");
  if (firstIdx === -1 || lastIdx === firstIdx) return null;
  const userId = base.slice(0, firstIdx);
  const joinedAtMs = Number(base.slice(firstIdx + 1, lastIdx));
  const seq = Number(base.slice(lastIdx + 1));
  if (!Number.isFinite(joinedAtMs) || !Number.isFinite(seq)) return null;
  return { userId, joinedAtMs, seq };
}

// Runs one session's raw combined WAV (see pcmToWavBuffer — 16-bit PCM
// at whatever rate the browser actually captured at) through the same
// resample + denoise + normalize chain as before, producing the final
// 16kHz mono WAV whisper-cli expects. Previously this function also had
// to DECODE a lossy WebM/Opus container the browser's MediaRecorder
// produced — that step is gone entirely now that capture is raw PCM
// (see pcmRecorder.js), so nothing here is throwing away detail that
// wasn't already lost; this is purely the deliberate, tunable filtering.
//
// IMPORTANT: outputs to a DIFFERENT path than the input. ffmpeg opens
// its output for writing before it's done reading the input; pointing
// both at the same file is undefined behavior (can truncate/corrupt the
// very file it's still reading), so this always appends ".filtered.wav"
// rather than assuming a ".webm" input extension to swap out.
function convertToWav(rawWavPath) {
  return new Promise((resolve, reject) => {
    const wavPath = rawWavPath.replace(/(\.wav)?$/i, ".filtered.wav");
    
    // ENHANCED audio processing pipeline for better Whisper transcription:
    //
    // The filter chain is designed to maximize speech clarity for ASR
    // (Automatic Speech Recognition) while suppressing background noise
    // and normalizing levels for consistent Whisper performance.
    //
    // Filter chain (order matters):
    //
    // 1. highpass=f=200
    //    Increased from 80Hz to 200Hz - more aggressive low-frequency
    //    filtering. Removes:
    //      - Deep rumble, desk vibration, footsteps
    //      - AC hum, electrical noise (50/60Hz harmonics)
    //      - Wind noise, breath pops
    //    Speech fundamentals start around 85Hz (male) / 165Hz (female),
    //    but most speech intelligibility comes from harmonics above 200Hz.
    //    This is safe for ASR even though it would sound "tinny" to humans.
    //
    // 2. afftdn=nf=-30:nt=w:om=o:tn=1
    //    FFT-based spectral noise reduction (Wiener filter mode).
    //    MORE AGGRESSIVE than the previous -20dB:
    //      - nf=-30: Noise floor estimate lowered to -30dB (was -20)
    //      - nt=w: Wiener filter (highest quality mode)
    //      - om=o: Output mode "output" (apply reduction)
    //      - tn=1: Track noise continuously (adapts to changing noise)
    //    This aggressively removes keyboard clatter, fan noise, room tone,
    //    and other stationary background sounds while preserving speech.
    //
    // 3. silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB:detection=peak
    //    Remove leading silence (first 200ms below -50dB peak).
    //    Prevents Whisper from hallucinating on the initial silence.
    //
    // 4. anlmdn=s=9:p=0.002:r=0.002:m=15
    //    Non-local means denoising (spatial denoising in frequency domain).
    //    This is a different algorithm than afftdn - it works by comparing
    //    similar spectral patches and averaging them to reduce random noise.
    //      - s=9: Strength (0-30, higher = more aggressive)
    //      - p=0.002: Patch similarity threshold (min 0.002)
    //      - r=0.002: Research area size (min 0.002, max 0.3)
    //      - m=15: Output mode (15 = cleaned output only)
    //    Catches noise that afftdn missed (non-stationary noise).
    //
    // 5. compand=attacks=0.1:decays=0.3:points=-60/-60|-30/-15|-20/-9|-10/-6|0/-3|20/0:soft-knee=6:gain=0
    //    Dynamic range compression optimized for speech intelligibility:
    //      - Brings up quiet speech (voices far from mic, soft speakers)
    //      - Controls loud peaks (shouting, mic bumps)
    //      - Soft knee: smooth transitions (sounds more natural)
    //      - Gain=0: no overall level change (loudnorm handles that next)
    //    Transfer curve explanation:
    //      - -60/-60: Below -60dB stays at -60dB (noise floor, don't amplify)
    //      - -30/-15: -30dB input → -15dB output (+15dB gain for quiet speech)
    //      - -20/-9:  -20dB input → -9dB output (+11dB gain)
    //      - -10/-6:  -10dB input → -6dB output (+4dB gain)
    //      - 0/-3:    0dB input → -3dB output (slight reduction)
    //      - 20/0:    20dB input → 0dB output (strong limiting on peaks)
    //
    // 6. loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true
    //    EBU R128 integrated loudness normalization (ITU-R BS.1770).
    //    This ensures ALL recordings reach Whisper at the SAME level
    //    (-16 LUFS integrated), regardless of how quiet the original was.
    //      - I=-16: Target integrated loudness (optimal for Whisper)
    //      - TP=-1.5: True peak limit (prevents clipping)
    //      - LRA=11: Loudness range target (allows dynamic speech)
    //      - dual_mono=true: Process as mono (no stereo artifacts)
    //
    // Why this chain works for Whisper:
    //   - Whisper expects speech around -20 to -6 dBFS mean
    //   - Noisy/quiet recordings confuse the model → hallucinations
    //   - This chain GUARANTEES clean, consistent levels
    //   - Each filter handles a different type of noise/distortion
    
    execFile(
      ffmpegPath,
      [
        "-y", // overwrite if it already exists (safe to re-run)
        "-i", rawWavPath,
        "-af",
        "highpass=f=200," +
        "afftdn=nf=-30:nt=w:om=o:tn=1," +
        "silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB:detection=peak," +
        "anlmdn=s=9:p=0.002:r=0.002:m=15," +
        "compand=attacks=0.1:decays=0.3:points=-60/-60|-30/-15|-20/-9|-10/-6|0/-3|20/0:soft-knee=6:gain=0," +
        "loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true",
        "-ar", "16000", // 16kHz — what whisper.cpp models expect
        "-ac", "1", // mono
        "-c:a", "pcm_s16le", // plain PCM, which miniaudio can always read
        wavPath,
      ],
      (err, stdout, stderr) => {
        if (err) {
          console.error(`[convertToWav] ffmpeg failed for ${rawWavPath}:`, err.message);
          console.error(`[convertToWav] ffmpeg stderr:`, stderr);
          return reject(err);
        }
        
        // Log loudnorm statistics if present in stderr
        const loudnormMatch = stderr.match(/Input Integrated:\s*(-?\d+\.?\d*)\s*LUFS.*Output Integrated:\s*(-?\d+\.?\d*)\s*LUFS/s);
        if (loudnormMatch) {
          console.log(`[convertToWav] Loudness normalization: ${loudnormMatch[1]} LUFS → ${loudnormMatch[2]} LUFS`);
        }
        
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
      ? fs.readdirSync(audioDir).filter((f) => f.endsWith(".pcm"))
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

      // Glue this session's chunks together, in RECORDED (seq) order,
      // into one continuous raw PCM buffer, then wrap it in a WAV
      // header using the sample rate THIS session actually captured at
      // (see upload.js's saveCallAudioChunk — not assumed to be a fixed
      // value, since not every OS/hardware combination honors the
      // 48kHz getUserMedia request). Raw PCM has no per-chunk framing to
      // worry about, unlike the old WebM/Opus chunks — concatenating the
      // bytes directly, in order, IS the correct combined audio.
      const combinedPath = path.join(audioDir, `${key}.combined.wav`);
      const pcmBuffer = Buffer.concat(
        chunks.map((c) => fs.readFileSync(path.join(audioDir, c.file)))
      );
      let sampleRate = 48000; // matches pcmRecorder.js's fixed capture rate; fallback if the sidecar below is somehow missing
      const ratePath = path.join(audioDir, `${key}.rate`);
      if (fs.existsSync(ratePath)) {
        const parsedRate = Number(fs.readFileSync(ratePath, "utf8").trim());
        if (Number.isFinite(parsedRate) && parsedRate > 0) sampleRate = parsedRate;
      }
      fs.writeFileSync(combinedPath, pcmToWavBuffer(pcmBuffer, sampleRate));

      // Sanity check: if `sampleRate` here doesn't match what the audio
      // was ACTUALLY captured at, the WAV plays back at the wrong speed
      // (slowed + pitched down if this value is too low relative to
      // reality) — which is exactly the kind of corruption that makes
      // Whisper produce short hallucinated fragments instead of a real
      // transcript. This can't fix a mismatch after the fact, but it
      // makes one immediately visible in the logs (implied duration
      // wildly off from the real, server-recorded call duration) instead
      // of only being discoverable by listening to the file, so a
      // regression here isn't silent next time.
      const impliedDurationSec = pcmBuffer.length / 2 / sampleRate; // 2 bytes/sample (16-bit)
      if (entry.duration && Math.abs(impliedDurationSec - entry.duration) > entry.duration * 0.15) {
        console.warn("[audio-session:duration-mismatch]", {
          recordingId: roomId,
          session: key,
          sampleRateUsed: sampleRate,
          impliedDurationSec: Number(impliedDurationSec.toFixed(2)),
          actualCallDurationSec: entry.duration,
          note:
            "Implied WAV duration from the raw PCM byte count doesn't match the real recorded call length — likely a sample-rate mismatch between capture and this combine step, which would make the audio play back distorted/at the wrong speed.",
        });
      }

      try {
        // ...then run it through the resample/denoise/normalize chain —
        // see convertToWav's comment above for why this is now pure
        // filtering rather than also having to decode a lossy codec.
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