// Shared between Callcontext.jsx (1:1 calls) and GroupCallContext.jsx

export const CALL_AUDIO_CHUNK_MS = 10000;

export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  // Turned back OFF. These were briefly set to `true` on the theory that
  // it would make the recorded/transcribed audio cleaner. In practice
  // this constraint applies to the ONE getUserMedia() stream that is used
  // for BOTH the LIVE call (sent straight to the peer connection) and the
  // recording (a cloned track of that same stream — see startRecording in
  // Callcontext.jsx / GroupCallContext.jsx). Chromium's built-in noise
  // suppression is a spectral-subtraction/Wiener-style filter, and it is
  // a well-known source of "robotic"/pulsing/musical-noise artifacts —
  // most audible specifically in a quiet room, because there the
  // suppressor is processing near-silence and its own processing
  // artifacts become the dominant thing anyone hears, live, on the other
  // end of the call. autoGainControl has a similar failure mode
  // ("pumping" — audible level changes as it hunts for a target loudness)
  // that's most noticeable exactly when there's little real signal to
  // lock onto.
  //
  // Turning these off fixes the live-call quality regression at zero
  // cost to transcription: the backend's own dedicated, tunable
  // noise-reduction chain (see transcriptionService.js's convertToWav —
  // highpass, afftdn, silenceremove, anlmdn, compand, loudnorm, all
  // tuned specifically for Whisper) already handles cleaning up the
  // RECORDED copy after the fact. There's no reason to pay the "robotic
  // background noise" cost on the LIVE audio a second time for a benefit
  // the backend already provides downstream.
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < float32Array.length; index++) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.writeIndex = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") this.flush();
    };
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples?.length) return true;

    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.buffer.length - this.writeIndex);
      this.buffer.set(samples.subarray(offset, offset + count), this.writeIndex);
      this.writeIndex += count;
      offset += count;
      if (this.writeIndex === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(4096);
        this.writeIndex = 0;
      }
    }
    return true;
  }

  flush() {
    if (this.writeIndex > 0) {
      const partial = this.buffer.slice(0, this.writeIndex);
      this.port.postMessage(partial, [partial.buffer]);
      this.buffer = new Float32Array(4096);
      this.writeIndex = 0;
    }
    this.port.postMessage({ type: "flushed" });
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

const FIXED_SAMPLE_RATE = 48000;

export function createPcmChunkRecorder({ stream, chunkMs, onChunk }) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Web Audio API is unavailable in this browser");
  }

  const audioContext = new AudioContextCtor({
    sampleRate: FIXED_SAMPLE_RATE,
    latencyHint: "playback",
  });
  const sampleRate = audioContext.sampleRate;
  const sourceNode = audioContext.createMediaStreamSource(stream);
  let processorNode = null;
  let usesWorklet = false;
  let flushTimer = null;
  let suspendWatchdog = null;
  let stopped = false;
  let floatBuffers = [];
  let bufferedFrames = 0;
  let flushWaiters = [];

  function emitChunk() {
    if (!bufferedFrames) return;
    const merged = new Float32Array(bufferedFrames);
    let offset = 0;
    for (const buffer of floatBuffers) {
      merged.set(buffer, offset);
      offset += buffer.length;
    }
    floatBuffers = [];
    bufferedFrames = 0;
    onChunk(floatTo16BitPCM(merged), sampleRate);
  }

  function handleSamples(samples) {
    const copy = samples.slice();
    floatBuffers.push(copy);
    bufferedFrames += copy.length;
  }

  function handleWorkletMessage(event) {
    if (event.data?.type !== "flushed") return;
    const waiters = flushWaiters;
    flushWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  async function start() {
    if (!stream.getAudioTracks().length) {
      throw new Error("[pcmRecorder] Stream has no audio tracks");
    }
    if (audioContext.state === "suspended") await audioContext.resume();

    audioContext.onstatechange = () => {
      if (audioContext.state === "suspended" && !stopped) {
        audioContext.resume().catch(() => {});
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
      try {
        await audioContext.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      processorNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      usesWorklet = true;
      processorNode.port.onmessage = (event) => handleSamples(event.data);
      processorNode.port.addEventListener("message", handleWorkletMessage);
      sourceNode.connect(processorNode);
    } catch (error) {
      console.warn("createPcmChunkRecorder: AudioWorklet unavailable, using fallback", error);
      processorNode = audioContext.createScriptProcessor(16384, 1, 1);
      processorNode.onaudioprocess = (event) => {
        handleSamples(event.inputBuffer.getChannelData(0));
      };
      sourceNode.connect(processorNode);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processorNode.connect(silentGain);
      silentGain.connect(audioContext.destination);
    }

    flushTimer = setInterval(emitChunk, chunkMs);
  }

  function flush() {
    if (!usesWorklet || !processorNode?.port) {
      emitChunk();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      flushWaiters.push(() => {
        emitChunk();
        resolve();
      });
      processorNode.port.postMessage({ type: "flush" });
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (flushTimer) clearInterval(flushTimer);
    if (suspendWatchdog) clearInterval(suspendWatchdog);
    emitChunk();
    sourceNode.disconnect();
    processorNode?.port.removeEventListener("message", handleWorkletMessage);
    processorNode?.disconnect();
    audioContext.close().catch(() => {});
  }

  return { start, stop, flush };
}