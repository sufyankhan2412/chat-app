// Captures the local WebRTC microphone track and emits only speech.

export const CALL_AUDIO_CHUNK_MS = 8000;

export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};

const TARGET_SAMPLE_RATE = 16000;
const VAD_FRAME_MS = 20;
const VAD_SPEECH_RMS = 0.012;
const VAD_END_SILENCE_MS = 500;
const VAD_PREROLL_MS = 200;

function floatTo16BitPCM(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  });
  return buffer;
}

function resampleTo16k(samples, sourceRate) {
  if (sourceRate === TARGET_SAMPLE_RATE) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * TARGET_SAMPLE_RATE / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.writeIndex = 0;
    this.port.onmessage = (event) => { if (event.data?.type === "flush") this.flush(); };
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
    if (this.writeIndex) {
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

export function createPcmChunkRecorder({ stream, chunkMs = CALL_AUDIO_CHUNK_MS, onChunk }) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Web Audio API is unavailable in this browser");

  const audioContext = new AudioContextCtor({ sampleRate: 48000, latencyHint: "interactive" });
  const sourceNode = audioContext.createMediaStreamSource(stream);
  let processorNode;
  let stopped = false;
  let usesWorklet = false;
  let flushWaiters = [];
  let pendingInput = [];
  let speechFrames = [];
  let preRollFrames = [];
  let speechStartedAt = null;
  let lastSpeechAt = null;
  let captureStartedAt = 0;
  let capturedFrames = 0;

  function emitSpeech(endAt) {
    if (!speechFrames.length || speechStartedAt == null) return;
    const length = speechFrames.reduce((sum, frame) => sum + frame.length, 0);
    const merged = new Float32Array(length);
    let offset = 0;
    speechFrames.forEach((frame) => { merged.set(frame, offset); offset += frame.length; });
    const startTimeMs = Math.max(0, speechStartedAt - captureStartedAt);
    const endTimeMs = Math.max(startTimeMs, endAt - captureStartedAt);
    onChunk(floatTo16BitPCM(resampleTo16k(merged, audioContext.sampleRate)), TARGET_SAMPLE_RATE, { startTimeMs, endTimeMs });
    speechFrames = [];
    preRollFrames = [];
    speechStartedAt = null;
    lastSpeechAt = null;
  }

  function processSamples(input) {
    if (!input?.length || stopped) return;
    pendingInput.push(input.slice());
    const frameLength = Math.max(1, Math.round(audioContext.sampleRate * VAD_FRAME_MS / 1000));
    let pendingLength = pendingInput.reduce((sum, part) => sum + part.length, 0);
    while (pendingLength >= frameLength) {
      const frame = new Float32Array(frameLength);
      let copied = 0;
      while (copied < frameLength && pendingInput.length) {
        const part = pendingInput[0];
        const take = Math.min(frameLength - copied, part.length);
        frame.set(part.subarray(0, take), copied);
        copied += take;
        if (take === part.length) pendingInput.shift();
        else pendingInput[0] = part.slice(take);
      }
      pendingLength -= frameLength;
      const frameStart = captureStartedAt + (capturedFrames / audioContext.sampleRate) * 1000;
      capturedFrames += frameLength;
      const frameEnd = captureStartedAt + (capturedFrames / audioContext.sampleRate) * 1000;
      let energy = 0;
      for (const value of frame) energy += value * value;
      const speaking = Math.sqrt(energy / frame.length) >= VAD_SPEECH_RMS;

      if (!speechStartedAt) {
        preRollFrames.push(frame);
        const maxPreRoll = Math.ceil(VAD_PREROLL_MS / VAD_FRAME_MS);
        if (preRollFrames.length > maxPreRoll) preRollFrames.shift();
      }
      if (speaking && !speechStartedAt) {
        speechStartedAt = Math.max(frameStart - VAD_PREROLL_MS, captureStartedAt);
        speechFrames = [...preRollFrames];
      }
      if (speechStartedAt) speechFrames.push(frame);
      if (speaking) lastSpeechAt = frameEnd;
      if (speechStartedAt && (frameEnd - speechStartedAt >= chunkMs || (lastSpeechAt && frameEnd - lastSpeechAt >= VAD_END_SILENCE_MS))) {
        emitSpeech(lastSpeechAt || frameEnd);
      }
    }
  }

  function handleMessage(event) {
    if (event.data?.type === "flushed") {
      if (pendingInput.length) {
        const remaining = pendingInput.reduce((all, part) => [...all, ...part], []);
        pendingInput = [];
        processSamples(new Float32Array(remaining));
      }
      if (speechStartedAt) emitSpeech(lastSpeechAt || performance.now());
      const waiters = flushWaiters;
      flushWaiters = [];
      waiters.forEach((resolve) => resolve());
      return;
    }
    const input = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
    processSamples(input);
  }

  async function start() {
    if (!stream.getAudioTracks().length) throw new Error("[pcmRecorder] Stream has no audio tracks");
    if (audioContext.state === "suspended") await audioContext.resume();
    captureStartedAt = performance.now();
    try {
      if (!audioContext.audioWorklet) throw new Error("AudioWorklet unsupported");
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try { await audioContext.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      processorNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      usesWorklet = true;
      processorNode.port.onmessage = handleMessage;
      sourceNode.connect(processorNode);
    } catch (error) {
      console.warn("createPcmChunkRecorder: AudioWorklet unavailable, using fallback", error);
      processorNode = audioContext.createScriptProcessor(16384, 1, 1);
      processorNode.onaudioprocess = (event) => processSamples(event.inputBuffer.getChannelData(0));
      sourceNode.connect(processorNode);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processorNode.connect(silentGain);
      silentGain.connect(audioContext.destination);
    }
  }

  function flush() {
    if (!usesWorklet || !processorNode?.port) {
      if (speechStartedAt) emitSpeech(performance.now());
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      flushWaiters.push(resolve);
      processorNode.port.postMessage({ type: "flush" });
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (speechStartedAt) emitSpeech(performance.now());
    sourceNode.disconnect();
    if (processorNode?.port) processorNode.port.onmessage = null;
    processorNode?.disconnect();
    audioContext.close().catch(() => {});
  }

  return { start, stop, flush };
}
