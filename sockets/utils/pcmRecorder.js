// Replaces MediaRecorder (audio/webm;codecs=opus) as the call-recording
// capture path.
//
// WHY: MediaRecorder's `audioBitsPerSecond` option is unreliable for
// audio-only recording in Chromium — it's commonly ignored, and the
// browser's built-in Opus encoder falls back to a low default bitrate
// (often ~32kbps) regardless of what's requested. That's a real,
// long-standing Chromium limitation, not a config mistake on our side:
// no amount of tuning the MediaRecorder options fixed it, because the
// option was never being honored in the first place. The audio is
// noticeably compressed before it ever leaves the browser, and nothing
// server-side can recover detail that was never captured.
//
// FIX: capture raw 16-bit PCM samples directly off the mic via the Web
// Audio API instead of going through MediaRecorder/Opus at all. There is
// no lossy encoding step on the client — the exact samples the
// microphone produced (after the browser's echoCancellation/
// autoGainControl, which run upstream of this and are unaffected) are
// what gets uploaded. The backend then does its own controlled,
// tunable processing (see Transcriptionservice.js's convertToWav) on
// that unmodified signal instead of re-decoding whatever the browser's
// Opus encoder threw away.
//
// Trade-off: PCM chunks are larger than Opus chunks (~960KB per 10s
// mono chunk at 48kHz/16-bit, vs ~150KB Opus at 128kbps) — acceptable
// for a background upload during a call, and still well under the
// backend's per-chunk size limit.

// Converts a Float32Array (Web Audio's native sample format, range
// [-1, 1]) into a 16-bit PCM ArrayBuffer (range [-32768, 32767]) —
// the format the backend expects and can wrap directly into a WAV file.
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp before scaling — a sample outside [-1, 1] (can happen with
    // autoGainControl overshoot) would otherwise wrap around instead of
    // clipping, which sounds far worse than a clean clip.
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

// AudioWorkletProcessor source, loaded via a Blob URL so this stays a
// single self-contained module instead of needing a separate static
// file served from /public.
//
// Batches QUANTA_PER_MESSAGE (32) render quantums — each a fixed 128
// samples — into one buffer before posting to the main thread, instead
// of posting on every single quantum. At 48kHz that's the difference
// between ~375 cross-thread messages/sec and ~11/sec per participant.
// This matters most on a CPU-constrained device (e.g. a phone also
// encoding video for the same WebRTC call): a very high-frequency
// postMessage rate competing with everything else on the main thread is
// a well-known source of dropped audio callbacks, which is exactly what
// showed up as "captured less audio than the call actually lasted" —
// real samples never delivered, not a timing/labeling issue. Posting
// the buffer as a Transferable (the second argument) hands over the
// underlying memory instead of structured-cloning a copy of it, cutting
// the per-message cost further.
//
// INCREASED from 16 to 32 to reduce CPU load and prevent sample drops.
const QUANTA_PER_MESSAGE = 32; // 32 * 128 = 4096 samples (~85.3ms at 48kHz) per message
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${QUANTA_PER_MESSAGE} * 128);
    this.writeIndex = 0;
    this.processCallCount = 0;
    this.zeroInputCount = 0;
    this.nonZeroInputCount = 0;
  }
  process(inputs) {
    this.processCallCount++;
    const input = inputs[0];
    
    // Log every 100 process() calls to track if we're receiving input at all
    if (this.processCallCount % 100 === 0) {
      console.log(\`[AudioWorklet:process] calls=\${this.processCallCount}, zeroInputs=\${this.zeroInputCount}, nonZeroInputs=\${this.nonZeroInputCount}, hasInput=\${!!input}, hasChannel=\${!!(input && input[0])}, channelLength=\${input && input[0] ? input[0].length : 0}\`);
    }
    
    if (input && input[0] && input[0].length) {
      const samples = input[0];
      
      // Check if we're receiving actual audio or just zeros
      const hasNonZero = samples.some(s => s !== 0);
      if (hasNonZero) {
        this.nonZeroInputCount++;
      } else {
        this.zeroInputCount++;
      }
      
      // Render quantum size (128) can vary in rare cases (e.g. right at
      // stream start/end) — guard against overflowing this.buffer rather
      // than assuming it always divides evenly.
      const spaceLeft = this.buffer.length - this.writeIndex;
      const toCopy = Math.min(samples.length, spaceLeft);
      this.buffer.set(samples.subarray(0, toCopy), this.writeIndex);
      this.writeIndex += toCopy;

      if (this.writeIndex >= this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(${QUANTA_PER_MESSAGE} * 128);
        this.writeIndex = 0;
        // Any samples that didn't fit in the just-sent buffer go into
        // the fresh one, so nothing between quantums is ever dropped.
        const remainder = samples.length - toCopy;
        if (remainder > 0) {
          this.buffer.set(samples.subarray(toCopy), 0);
          this.writeIndex = remainder;
        }
      }
    } else {
      this.zeroInputCount++;
    }
    return true; // keep the processor alive for the life of the stream
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;
// Known, deliberately-accepted limitation of batching: whatever's in the
// worklet's partial buffer at the exact moment the stream stops (up to
// QUANTA_PER_MESSAGE*128 - 1 samples, under ~43ms at 48kHz) never gets
// posted, since posting only happens once the buffer fills. Negligible
// next to the multi-second capture gaps this batching is meant to fix.

// Captures raw PCM from `stream`'s audio track and calls
// `onChunk(arrayBuffer, sampleRate)` roughly every `chunkMs`, where
// `arrayBuffer` is 16-bit little-endian mono PCM covering that interval.
// `flush()` immediately emits whatever's been buffered since the last
// chunk (used on hangup, so the last fraction-of-a-chunk of audio isn't
// silently dropped when the recorder is stopped mid-interval).
//
// The AudioContext is created with an EXPLICIT sampleRate rather than
// letting the browser pick its own default. This matters: getUserMedia's
// `sampleRate` constraint (see CALL_AUDIO_CONSTRAINTS) is only a
// requested hint that hardware/OS isn't required to honor exactly, but
// AudioContext's constructor sampleRate option is a hard guarantee per
// spec — the browser resamples internally to match it exactly, no matter
// what the mic's native rate is. Previously this left room for the
// context's actual rate to end up not perfectly matching what was
// assumed elsewhere in the pipeline; pinning both to the same fixed
// constant removes that entire class of bug rather than trusting two
// independent "best effort" values to agree. Symptom when they didn't:
// audio played back noticeably slowed down and pitched low — the WAV
// header ends up declaring a different rate than the data was actually
// produced at, which is also exactly the kind of corruption that makes
// Whisper produce short hallucinated fragments instead of a real
// transcript, since the actual speech is stretched into something
// unrecognizable.
const FIXED_SAMPLE_RATE = 48000;

export function createPcmChunkRecorder({ stream, chunkMs, onChunk }) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  // Set latencyHint to 'playback' to prioritize throughput over low latency
  // This reduces CPU pressure and helps prevent sample drops
  const audioContext = new AudioContextCtor({ 
    sampleRate: FIXED_SAMPLE_RATE,
    latencyHint: 'playback'
  });
  // Read back rather than assuming FIXED_SAMPLE_RATE stuck — spec says it
  // must, but reporting reality instead of the request costs nothing and
  // means a future browser quirk shows up in the uploaded chunk's own
  // metadata instead of silently mismatching again.
  const sampleRate = audioContext.sampleRate;

  let floatBuffers = [];
  let bufferedFrames = 0;
  let sourceNode = null;
  let processorNode = null; // AudioWorkletNode or fallback ScriptProcessorNode
  let flushTimer = null;
  let suspendWatchdog = null;
  let stopped = false;

  // Diagnostics for tracking down dropped audio: total samples actually
  // captured vs. how many SHOULD exist for the wall-clock time that's
  // elapsed. These numbers diverging (see logDiagnostics below) means
  // real audio is being lost during capture — not a header/labeling
  // issue (that was ruled out separately; sampleRate here is now pinned
  // — see FIXED_SAMPLE_RATE above), but actual samples the browser never
  // delivered to us, which is exactly what makes speech sound clipped/
  // garbled/"far away" and breaks transcription.
  let recordingStartedAtMs = null;
  let totalSamplesCaptured = 0;

  function logDiagnostics(label) {
    if (!recordingStartedAtMs) return;
    const elapsedSec = (Date.now() - recordingStartedAtMs) / 1000;
    const expectedSamples = Math.round(elapsedSec * sampleRate);
    const deficitPct =
      expectedSamples > 0
        ? (((expectedSamples - totalSamplesCaptured) / expectedSamples) * 100).toFixed(1)
        : "0.0";
    console.debug(`[pcmRecorder:${label}]`, {
      elapsedSec: elapsedSec.toFixed(2),
      expectedSamples,
      totalSamplesCaptured,
      deficitPct: `${deficitPct}%`,
      audioContextState: audioContext.state,
    });
  }

  function emitChunk() {
    if (!bufferedFrames) return;
    const merged = new Float32Array(bufferedFrames);
    let offset = 0;
    for (const buf of floatBuffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    floatBuffers = [];
    bufferedFrames = 0;
    onChunk(floatTo16BitPCM(merged), sampleRate);
    logDiagnostics("chunk-emitted");
  }

  // Throttles the per-batch diagnostic log below to roughly once a
  // second instead of once per worklet message (~11-12x/sec — see
  // QUANTA_PER_MESSAGE above). Also fixes a real CPU-pressure bug this
  // diagnostic used to cause: it previously computed peak/rms with
  // `Math.max(...Array.from(float32Array).map(Math.abs))`, which
  // allocates two throwaway arrays AND spreads ~4096 numbers as
  // individual function arguments — on the MAIN thread, 10+ times a
  // second, for the entire length of every call. That's exactly the
  // kind of main-thread work the AudioWorklet batching above exists to
  // avoid competing with (see QUANTA_PER_MESSAGE's comment on dropped
  // audio callbacks) — on a CPU-constrained device already encoding
  // video for the same call, it could itself contribute to the dropped-
  // callback / choppy-audio symptom this file exists to fix, not just
  // observe it.
  let lastDiagnosticLogMs = 0;

  function handleSamples(float32Array) {
    // Peak/RMS in a single pass, no intermediate array allocations and no
    // argument-spreading — O(n) with a fixed, tiny amount of extra work
    // per sample regardless of batch size.
    let peak = 0;
    let sumSquares = 0;
    let hasNonZero = false;
    for (let i = 0; i < float32Array.length; i++) {
      const s = float32Array[i];
      if (s !== 0) hasNonZero = true;
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / float32Array.length);

    const now = Date.now();
    if (now - lastDiagnosticLogMs >= 1000) {
      lastDiagnosticLogMs = now;
      console.debug(
        `[pcmRecorder:sample] length=${float32Array.length}, hasNonZero=${hasNonZero}, peak=${peak.toFixed(4)}, rms=${rms.toFixed(4)}`
      );
    }

    floatBuffers.push(float32Array);
    bufferedFrames += float32Array.length;
    totalSamplesCaptured += float32Array.length;
  }

  async function start() {
    recordingStartedAtMs = Date.now();
    
    // Diagnostic: verify stream is valid and has active audio tracks
    const audioTracks = stream.getAudioTracks();
    console.log('[pcmRecorder:start] Stream info:', {
      trackCount: audioTracks.length,
      tracks: audioTracks.map(t => ({
        id: t.id,
        label: t.label,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        settings: t.getSettings(),
      })),
      contextState: audioContext.state,
      contextSampleRate: audioContext.sampleRate,
    });
    
    if (!audioTracks.length) {
      throw new Error('[pcmRecorder] Stream has no audio tracks');
    }
    if (audioTracks[0].readyState !== 'live') {
      console.warn('[pcmRecorder] Audio track readyState is not "live":', audioTracks[0].readyState);
    }
    if (!audioTracks[0].enabled) {
      console.warn('[pcmRecorder] Audio track is disabled');
    }
    if (audioTracks[0].muted) {
      console.warn('[pcmRecorder] Audio track is muted');
    }
    
    sourceNode = audioContext.createMediaStreamSource(stream);
    
    // Additional diagnostic: verify the source node is actually connected to live audio
    console.log('[pcmRecorder:start] MediaStreamSource created:', {
      channelCount: sourceNode.channelCount,
      channelCountMode: sourceNode.channelCountMode,
      channelInterpretation: sourceNode.channelInterpretation,
      mediaStream: {
        id: stream.id,
        active: stream.active,
      },
    });

    // Chrome (and other browsers) can suspend an AudioContext's
    // processing under some conditions — power saving, autoplay policy
    // heuristics, or the tab losing focus/visibility — which silently
    // stops process()/onaudioprocess from firing at all for however long
    // it's suspended, with NO error and no event unless you're watching
    // for it. Any speech spoken during a suspended stretch is simply
    // never captured, which looks exactly like "chunks of audio are
    // missing" without anything ever throwing. onstatechange plus a
    // watchdog interval (belt-and-suspenders, since resume() can itself
    // occasionally not fire the expected event) actively resumes and
    // logs every time this happens, so it shows up in the console
    // instead of silently eating part of the call.
    audioContext.onstatechange = () => {
      if (audioContext.state === "suspended" && !stopped) {
        console.warn(
          "[pcmRecorder] AudioContext suspended mid-recording — resuming. Any audio spoken while suspended was not captured."
        );
        audioContext.resume().catch((err) => console.error("[pcmRecorder] resume() failed:", err));
      }
    };
    suspendWatchdog = setInterval(() => {
      if (audioContext.state === "suspended" && !stopped) {
        audioContext.resume().catch(() => {});
      }
    }, 1000);

    try {
      if (!audioContext.audioWorklet) throw new Error("AudioWorklet unsupported");
      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" })
      );
      await audioContext.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);
      processorNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      processorNode.port.onmessage = (event) => {
        console.debug(`[pcmRecorder:worklet] Received batch, samples=${event.data.length}`);
        handleSamples(event.data);
      };
      sourceNode.connect(processorNode);
      console.log('[pcmRecorder] AudioWorkletNode connected successfully');
      // AudioWorkletNode has no default output that needs connecting to
      // the destination for capture-only use — leaving it unconnected to
      // audioContext.destination is intentional, so we don't loop the
      // user's own mic back out to their speakers.
    } catch (err) {
      // Fallback for browsers without AudioWorklet support. Deprecated,
      // but universally available, and only used when the modern path
      // genuinely isn't there.
      console.warn("createPcmChunkRecorder: AudioWorklet unavailable, falling back to ScriptProcessorNode", err);
      // Increased buffer size from 4096 to 16384 to reduce callback frequency
      // and prevent sample drops on CPU-constrained devices
      const bufferSize = 16384;
      processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
      processorNode.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0).slice();
        console.debug(`[pcmRecorder:scriptProcessor] Received samples=${samples.length}`);
        handleSamples(samples);
      };
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination); // required by spec for ScriptProcessorNode to fire at all, but silent since we never write to the output buffer
      console.log('[pcmRecorder] ScriptProcessorNode connected successfully');
    }

    flushTimer = setInterval(emitChunk, chunkMs);
  }

  // Emits whatever's currently buffered right now, without waiting for
  // the next scheduled interval. Callers awaiting the upload triggered
  // by onChunk (see startRecording in Call/GroupCallContext.jsx) can use
  // this to guarantee the final few seconds of audio are uploaded before
  // the call actually ends, instead of losing them to the interval timer
  // never firing again after stop().
  function flush() {
    emitChunk();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (flushTimer) clearInterval(flushTimer);
    if (suspendWatchdog) clearInterval(suspendWatchdog);
    logDiagnostics("stopped"); // final tally for this recording session
    flush();
    try {
      sourceNode?.disconnect();
      processorNode?.disconnect();
    } catch {
      // Already disconnected/torn down — nothing to do.
    }
    audioContext.close().catch(() => {});
  }

  return { start, stop, flush };
}