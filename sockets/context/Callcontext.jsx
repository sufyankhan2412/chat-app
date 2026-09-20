import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSocket } from "./Socketcontext";
import { useAuth } from "./Authcontext";
import { getUserProfile, uploadCallAudioChunk } from "../api";
import { CALL_AUDIO_CHUNK_MS, getCallAudioConstraints } from "../utils/audioRecording";
import { createPcmChunkRecorder } from "../utils/pcmRecorder";
import { ICE_SERVERS } from "../utils/iceServers";
import { applyAudioOutput, isAudioOutputSupported } from "../utils/audioOutput";

const CallContext = createContext(null);

export const useCall = () => useContext(CallContext);

// Module-scope (NOT a ref/state inside the component) set of roomIds
// currently being recorded. A per-component ref survives re-renders of
// ONE component instance, but not a full unmount+remount of that
// instance — and "callSessionStarted"'s effect below re-subscribes on
// every callState change (callState transitions several times right as
// a call connects), which combined with React 18 StrictMode's dev-mode
// double effect invocation can produce more than one live subscription
// long enough for startRecording to run twice for the same call. Two
// recorder instances each starting their own chunk-seq counter at 0
// then upload two different "seq N" chunks for every N — same filename,
// so only one survives on disk per seq, but WHICHEVER one wins can
// differ tick to tick, splicing together audio from two unrelated
// recorder sessions into one corrupt file. This set is keyed by roomId
// and lives for the process's whole lifetime, so it catches the
// duplicate no matter which layer causes it.
const activeRecordingSessions = new Set();

// CALL_AUDIO_CHUNK_MS and CALL_AUDIO_CONSTRAINTS live in
// ../utils/audioRecording.js, shared with GroupCallContext.jsx, so the
// two call flows' capture settings can never drift apart.

// ---------------------------------------------------------------------
// Chunk-upload retry with backoff.
//
// WHY THIS EXISTS: a single chunk's upload can fail for reasons that
// have nothing to do with our own audio pipeline — a dev tunnel briefly
// dropping the connection (confirmed via console: a CORS preflight
// failing because the underlying connection was gone, followed by a 408
// Request Timeout), a mobile network handoff, a momentary Wi-Fi drop,
// etc. Previously a failed upload was just logged and the chunk was
// gone forever — for a participant on a flaky connection, this meant
// most of their audio never reached the server at all, even though
// recording itself (see pcmRecorder.js's own diagnostics) was capturing
// it just fine. That's exactly what showed up as "the audio that came
// back to the server is shorter than the real call, for one participant
// specifically" — confirmed directly: session
// 6a8d3708...e400 (Abdul Samad) only had chunk 0 land on the server
// (expectedChunks:1, receivedChunks:1) out of a 44-second call, while
// the browser console showed chunks 1/2/3 failing outright with a CORS/
// timeout error on that same upload endpoint.
//
// This retries a failed chunk upload a few times with increasing delay
// before giving up. Costs nothing when the network is healthy (first
// attempt always succeeds, no extra latency), and recovers exactly the
// transient-failure case above. It does NOT fix a genuinely dead
// connection for the whole rest of the call — that's what the
// backend's missingChunks/duplicateChunks logging and the transcript's
// "no usable audio was captured for: X" note are for — but it stops a
// single blip from taking a whole chunk down with it.
const CHUNK_UPLOAD_MAX_RETRIES = 3;
const CHUNK_UPLOAD_RETRY_DELAY_MS = 1000;

// How long to stay in "Reconnecting…" state after the peer connection
// drops to "disconnected" before giving up and ending the call for both
// sides. 30s mirrors the kind of grace window apps like WhatsApp give a
// call before dropping it — long enough to ride out a real network blip
// (Wi-Fi/mobile handoff, a brief dead zone, the OS suspending the tab for
// a few seconds) without either side having to manually redial.
const RECONNECT_GRACE_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadChunkWithRetry(...args) {
  let lastErr;
  for (let attempt = 0; attempt <= CHUNK_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      return await uploadCallAudioChunk(...args);
    } catch (err) {
      lastErr = err;
      if (attempt < CHUNK_UPLOAD_MAX_RETRIES) {
        console.warn(
          `[uploadCallAudioChunk] attempt ${attempt + 1} failed, retrying in ${
            CHUNK_UPLOAD_RETRY_DELAY_MS * (attempt + 1)
          }ms:`,
          err.message
        );
        await sleep(CHUNK_UPLOAD_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

// idle -> outgoing (I called) | incoming (they called me)
// outgoing -> ongoing (answered) | idle (rejected/cancelled/failed)
// incoming -> ongoing (I answered) | idle (I declined/they cancelled)
// ongoing -> idle (either side hangs up)
const CALL_STATE = {
  IDLE: "idle",
  OUTGOING: "outgoing",
  INCOMING: "incoming",
  ONGOING: "ongoing",
};

function describeMediaError(err) {
  if (err?.name === "InsecureContextError") return err.message;
  if (err?.name === "NotAllowedError") return "Camera/microphone permission denied.";
  if (err?.name === "NotFoundError") return "No camera or microphone was found on this device.";
  return "Couldn't start the call.";
}

export function CallProvider({ children }) {
  const socket = useSocket();
  const { user } = useAuth();

  const [callState, setCallState] = useState(CALL_STATE.IDLE);
  const [callType, setCallType] = useState("audio"); // "audio" | "video"
  const [remoteUser, setRemoteUser] = useState(null); // { _id, username, avatar }
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  // Speaker control (GPT-5.6-Luna instructions) - default FALSE = earpiece mode
  const [speakerEnabled, setSpeakerEnabled] = useState(false);
  const [callError, setCallError] = useState("");
  const [callStartedAt, setCallStartedAt] = useState(null);
  // True while the peer connection is in WebRTC's "disconnected" state —
  // i.e. media was flowing and then stopped, most commonly because one
  // side's network briefly dropped (Wi-Fi handoff, a few seconds of no
  // signal, a switch between Wi-Fi and mobile data, etc). This is NOT the
  // same as the call actually ending: like WhatsApp, we keep the call
  // "up" (peer connection stays open, UI stays on the call screen) and
  // just show a "Reconnecting…" state, giving the network a chance to
  // come back on its own before giving up. See createPeerConnection's
  // onconnectionstatechange below for the state machine.
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Set once the other side (or I) successfully turn this 1:1 call into a
  // link-based group call — { roomId, callType, link }. CallModal watches
  // this to hand off into GroupCallContext automatically, for both people,
  // without either of them needing to click anything else.
  const [groupUpgrade, setGroupUpgrade] = useState(null);
  const [addingPeople, setAddingPeople] = useState(false);

  const pcRef = useRef(null);
  // Timer used while isReconnecting is true — see createPeerConnection's
  // onconnectionstatechange. Cleared the instant the connection recovers
  // OR the call ends any other way, so a stale timer from a PREVIOUS call
  // can never fire and tear down a brand-new one.
  const reconnectTimerRef = useRef(null);
  // Always points at the LATEST endCall closure. Needed because
  // createPeerConnection (which needs to be able to trigger a hangup from
  // inside the connectionstatechange handler) is created before endCall
  // is defined further down, and endCall's own dependencies (callState,
  // remoteUser) change over the life of a call — a stale closure captured
  // once at pc-creation time would keep emitting to whatever remoteUser
  // was set when the PEER CONNECTION was created, not the current one.
  const endCallRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingOfferRef = useRef(null); // { from, offer, callType } while ringing
  const pendingCandidatesRef = useRef([]); // ICE candidates that arrive before remote description is set
  const remoteAudioRef = useRef(null); // Ref to remote audio/video element for speaker control

  // My own mic-only recorder for this 1:1 call, for transcription — same
  // mechanism GroupCallContext.jsx uses for group calls, now reused here
  // so a plain 1:1 audio/video call gets transcribed too. The server
  // only tells us to start (via "callSessionStarted", once both sides are
  // actually connected — see Socketmanager.js's startDirectCallRecording)
  // after it has created a `Call` document with a roomId for this call,
  // exactly like a group-call room.
  const recorderRef = useRef(null); // { start, stop, flush } from createPcmChunkRecorder
  const chunkSeqRef = useRef(0);
  const callRoomIdRef = useRef(null);
  const callJoinedAtRef = useRef(null);
  // Every in-flight uploadCallAudioChunk() promise, so hangup can wait
  // for ALL of them (not just the very last one it triggers) to actually
  // land on the server before telling the server the call is over — see
  // stopRecordingAndFlush below for why this matters.
  const pendingUploadsRef = useRef(new Set());
  const uploadChainRef = useRef(Promise.resolve());
  // Recording stream — wraps a CLONE of localStreamRef's (Stream A's)
  // audio track, not a second real capture. See startRecording below and
  // the history note in audioRecording.js for why: two concurrent
  // getUserMedia() sessions on the same microphone is what caused the
  // live-call audio-quality bug. Never added to any RTCPeerConnection.
  const recordingStreamRef = useRef(null);

  // Stops recording and waits for every chunk — including one final
  // flush of whatever's been captured since the last scheduled chunk —
  // to finish uploading, before resolving.
  //
  // WHY THIS MATTERS: previously, stop() fired the last chunk's upload
  // and moved on without waiting for it. The server decides a call's
  // audio is transcribable once its "leaveGroupCallRoom"/hangup socket
  // event arrives; it doesn't separately know whether the browser is
  // still mid-upload of the tail end of the recording. Add polling
  // latency or a slow connection and the transcription job can start,
  // find a shorter file than the real call, and Whisper — which is
  // prone to inventing text when it's fed a track that cuts off
  // mid-sentence rather than at actual silence — hallucinates trailing
  // words that were never said. Awaiting every pending upload here
  // before the caller proceeds to end the call closes that race for the
  // one case we fully control: an explicit, clean hangup. (A crashed tab
  // or killed connection can't be fixed this way — that's what the
  // backend's settle-polling + missingChunks logging is for.)
  const stopRecordingAndFlush = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const roomId = callRoomIdRef.current;
    const joinedAt = callJoinedAtRef.current;
    await recorder.flush(); // includes the AudioWorklet's partial final buffer
    recorder.stop();
    recorderRef.current = null;
    if (pendingUploadsRef.current.size) {
      await Promise.allSettled([...pendingUploadsRef.current]);
    }
    // Stop the dedicated recording stream (Stream B) only — never touches
    // localStreamRef (Stream A / WebRTC call stream). Stopping recording
    // must NOT mute or end the live call.
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach((t) => t.stop());
      recordingStreamRef.current = null;
      console.log("[RECORDING AUDIO] recordingStream stopped");
    }
    // Tell the server every chunk we recorded has actually landed, so its
    // transcription job can stop guessing from a quiet gap on disk (which
    // is ambiguous — a normal ~10s wait between scheduled chunks looks
    // identical to "recording actually stopped") and instead wait for
    // real confirmation from both sides of the call. See
    // Socketmanager.js's waitForAudioUploadsToSettle.
    if (roomId && socket && Number.isFinite(joinedAt)) {
      socket.emit("recordingFlushed", {
        roomId,
        joinedAt,
      });
    }
  }, [socket]);

  const resetCallState = useCallback(() => {
    // Whatever's ending the call (clean hangup, ICE failure, the OTHER
    // side hanging up, etc.) makes any pending "give up on reconnecting"
    // timer moot — clear it so it can never fire against a call that's
    // already over.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setIsReconnecting(false);
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    // Best-effort synchronous stop for cleanup paths that can't await
    // (e.g. a React effect's cleanup function). Explicit hangups should
    // call stopRecordingAndFlush() themselves BEFORE calling
    // resetCallState — see endCall below — so this is a backstop, not
    // the primary mechanism, for the reason explained on
    // stopRecordingAndFlush above.
    if (recorderRef.current) {
      recorderRef.current.stop();
    }
    if (callRoomIdRef.current) {
      activeRecordingSessions.delete(callRoomIdRef.current);
    }
    recorderRef.current = null;
    // Backstop: stop the dedicated recording stream (Stream B) if it
    // wasn't already stopped by stopRecordingAndFlush. Kept strictly
    // separate from localStreamRef cleanup above — stopping one must
    // never affect the other.
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach((t) => t.stop());
      recordingStreamRef.current = null;
      console.log("[RECORDING AUDIO] recordingStream stopped (resetCallState backstop)");
    }
    callRoomIdRef.current = null;
    callJoinedAtRef.current = null;
    chunkSeqRef.current = 0;
    uploadChainRef.current = Promise.resolve();
    pendingOfferRef.current = null;
    pendingCandidatesRef.current = [];

    setCallState(CALL_STATE.IDLE);
    setRemoteUser(null);
    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setIsCameraOff(false);
    setSpeakerEnabled(false); // Reset speaker to earpiece mode
    setCallStartedAt(null);
  }, []);

  const createPeerConnection = useCallback(
    (targetId) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit("iceCandidate", {
            targetId,
            candidate: event.candidate,
          });
        }
      };

      pc.ontrack = (event) => {
        setRemoteStream(event.streams[0]);
      };

      // WhatsApp-style reconnect handling.
      //
      // "disconnected" means media stopped flowing but the ICE agent
      // hasn't given up — this is the common, usually-transient case: a
      // few seconds of no signal, a Wi-Fi/mobile-data handoff, the phone
      // being locked, etc. Per the WebRTC spec it can self-recover back
      // to "connected" with NO action needed on our part. So instead of
      // ending the call here, we just surface a "Reconnecting…" state in
      // the UI (see isReconnecting) and start a grace-period timer. If
      // the connection comes back before the timer fires, the call
      // carries on exactly as it was — same peer connection, same
      // recording session, nothing was torn down. Only if the network
      // genuinely never comes back within that window do we give up.
      //
      // "failed" means the ICE agent has already exhausted every
      // candidate pair and given up — per spec this is terminal and will
      // not self-recover on its own (classic cause: two peers on
      // different networks, e.g. one on mobile data/CGNAT, with no TURN
      // relay configured — see ICE_SERVERS above), so there's no reason
      // to wait out a grace period for it.
      //
      // IMPORTANT (bug fix): both cases below now end the call by calling
      // endCall() (via endCallRef, see its comment above) rather than
      // just resetting THIS side's local state. Resetting only locally
      // used to leave the call fully "ongoing" on the other participant's
      // screen forever — a frozen video/silent audio with no way to know
      // the call was actually over on their end. endCall() emits the
      // proper "endCall"/"cancelCall" socket event, so the other side's
      // "callEnded" listener fires too and the call ends on BOTH sides,
      // the same way an explicit hangup does.
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;

        if (state === "connected") {
          // Recovered (either connecting for the first time, or coming
          // back from "disconnected") — clear any pending give-up timer.
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setIsReconnecting(false);
          return;
        }

        if (state === "disconnected") {
          setIsReconnecting(true);
          // Best-effort nudge: ask the ICE agent to gather a fresh set of
          // candidates in case the old path is truly gone (e.g. we
          // switched networks) rather than just briefly interrupted.
          // Safe no-op if the browser doesn't support it or the
          // connection recovers on its own before this matters.
          void (async () => {
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              socket?.emit("renegotiateOffer", { targetId, offer });
            } catch (err) {
              console.warn("[Call] ICE restart renegotiation failed:", err);
            }
          })();
          if (!reconnectTimerRef.current) {
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              console.warn(
                `[Call] connection stayed disconnected for ${RECONNECT_GRACE_MS}ms — giving up and ending the call for both sides.`
              );
              setCallError("Call ended — the connection couldn't be recovered.");
              endCallRef.current?.();
            }, RECONNECT_GRACE_MS);
          }
          return;
        }

        if (state === "failed") {
          console.error(
            "[Call] RTCPeerConnection connectionState=failed — ICE could not find a usable path. " +
              "This is the classic symptom of two peers on different networks (e.g. one on mobile " +
              "data/CGNAT) with no TURN server configured. Set VITE_TURN_URL/VITE_TURN_USERNAME/" +
              "VITE_TURN_CREDENTIAL."
          );
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setIsReconnecting(false);
          setCallError(
            "Call connection failed. If you're on different networks (e.g. one on mobile data), this app needs a TURN server configured to connect reliably."
          );
          endCallRef.current?.();
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [socket, resetCallState, stopRecordingAndFlush]
  );

  // Records MY OWN mic audio (never the remote party's — that never
  // reaches this browser as a separate track) for this call, uploading
  // small rolling chunks of raw PCM as they're produced. Identical
  // mechanism and upload endpoint to GroupCallContext.jsx's group-call
  // recording — the backend's transcription pipeline is generic per-
  // roomId and doesn't distinguish a 1:1 call's "room" (exactly two
  // participants) from a group call's. `joinedAt` is the SERVER
  // timestamp from "callSessionStarted", not a local clock reading.
  //
  // SINGLE-CAPTURE ARCHITECTURE (see the history note in
  // audioRecording.js for the full story): this used to open a SECOND
  // real getUserMedia() audio stream just for recording, which is what
  // caused the live-call audio-quality bug — two concurrent captures on
  // the same microphone fighting over the browser/OS's shared
  // echo-cancellation + auto-gain-control pipeline, heard by the other
  // party as choppy/robotic audio while the speaker was actually
  // talking. Fixed by keeping exactly ONE getUserMedia() call per call
  // (the `stream` argument, i.e. Stream A — the same stream already on
  // the peer connection) and cloning its audio track for recording
  // instead. A cloned MediaStreamTrack is a genuinely independent
  // instance with its own `enabled` flag — forcing the clone's `enabled`
  // to `true` and leaving it there means recording keeps running even
  // while toggleMute sets `enabled = false` on the original, WITHOUT
  // ever opening a second hardware capture.
  const startRecording = useCallback((stream, roomId, joinedAt) => {
    const recordingRoomId = roomId;
    // Guard: need an active call stream to confirm the call is live, and
    // a valid roomId to key the idempotency guard.
    if (!stream || !stream.getAudioTracks().length) return;
    // Idempotency guard — see the comment on activeRecordingSessions
    // above for why a ref alone isn't enough here.
    if (activeRecordingSessions.has(roomId)) {
      return;
    }
    activeRecordingSessions.add(roomId);
    try {
      // Clone the SAME audio track that's already on the peer
      // connection — no second getUserMedia() call, no second hardware
      // capture session. Force the clone permanently enabled so muting
      // the original (what toggleMute does) can never silence recording.
      const originalTrack = stream.getAudioTracks()[0];
      const recordingTrack = originalTrack.clone();
      recordingTrack.enabled = true;
      const recordingStream = new MediaStream([recordingTrack]);
      recordingStreamRef.current = recordingStream;

      console.log("[RECORDING AUDIO] Using cloned audio track (single capture)", {
        originalTrackId: originalTrack.id,
        clonedTrackId: recordingTrack.id,
        enabled: recordingTrack.enabled,
        muted: recordingTrack.muted,
        readyState: recordingTrack.readyState,
        settings: recordingTrack.getSettings?.(),
      });

      chunkSeqRef.current = 0;

      const recorder = createPcmChunkRecorder({
        stream: recordingStream,
        chunkMs: CALL_AUDIO_CHUNK_MS,
        onChunk: (pcmArrayBuffer, sampleRate) => {
          if (!recordingRoomId) return;
          const seq = chunkSeqRef.current++;
          const uploadPromise = uploadChainRef.current
            .then(() =>
              uploadChunkWithRetry(
                recordingRoomId,
                joinedAt,
                seq,
                pcmArrayBuffer,
                sampleRate
              )
            )
            .catch((err) => {
              console.error(
                `uploadCallAudioChunk error (seq=${seq}, all retries exhausted):`,
                err
              );
            })
            .finally(() => {
              pendingUploadsRef.current.delete(uploadPromise);
            });
          uploadChainRef.current = uploadPromise.catch(() => {});
          pendingUploadsRef.current.add(uploadPromise);
        },
      });

      recorder.start().then(() => {
        console.log("[RECORDING AUDIO] Recorder started successfully");
      }).catch((err) => {
        activeRecordingSessions.delete(roomId);
        // Stop the cloned track if the recorder fails to start — this
        // only releases the clone, never the original hardware capture
        // that's still feeding the live call.
        if (recordingStreamRef.current) {
          recordingStreamRef.current.getTracks().forEach((t) => t.stop());
          recordingStreamRef.current = null;
        }
        console.error("startRecording error:", err);
      });
      recorderRef.current = recorder;
    } catch (err) {
      // Recording for transcription is a best-effort add-on to the call
      // itself — a capture error here should never break the actual
      // call the user is trying to have.
      activeRecordingSessions.delete(roomId);
      console.error("startRecording: Failed to clone the call's audio track", err);
    }
  }, []);

  const getLocalMedia = useCallback(async (type) => {
    // On phones (and most modern browsers), camera/mic access is only
    // exposed on a "secure context" — https://, or http://localhost.
    // Opening the app via a LAN IP like http://192.168.x.x:5173 on a
    // phone is NOT secure, so `navigator.mediaDevices` is simply
    // undefined there and calls fail before any signaling happens.
    // Surface that clearly instead of letting the next line throw a
    // confusing "Cannot read properties of undefined".
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error(
        "Camera/mic access is blocked on this connection. Open the app over HTTPS (or a dev tunnel) on this device — plain http://<ip> only works on the machine it's running on."
      );
      err.name = "InsecureContextError";
      throw err;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: getCallAudioConstraints(),
      video:
        type === "video"
          ? {
              width: { ideal: 640, max: 1280 },
              height: { ideal: 480, max: 720 },
              frameRate: { ideal: 24, max: 30 },
            }
          : false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    console.log("[CALL AUDIO] callStream created", {
      tracks: stream.getAudioTracks().length,
      settings: stream.getAudioTracks()[0]?.getSettings(),
    });
    return stream;
  }, []);

  // ---- Outgoing call ----
  const startCall = useCallback(
    async (contact, type = "audio") => {
      if (!socket || !contact?._id || callState !== CALL_STATE.IDLE) return;

      setCallError("");
      setCallType(type);
      setRemoteUser(contact);
      setCallState(CALL_STATE.OUTGOING);

      try {
        const stream = await getLocalMedia(type);
        const pc = createPeerConnection(contact._id);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("callUser", {
          receiverId: contact._id,
          offer,
          callType: type,
        });
      } catch (err) {
        console.error("startCall error:", err);
        setCallError(describeMediaError(err));
        resetCallState();
      }
    },
    [socket, callState, getLocalMedia, createPeerConnection, resetCallState]
  );

  // ---- Incoming call: accept ----
  const acceptCall = useCallback(async () => {
    const pending = pendingOfferRef.current;
    if (!socket || !pending) return;

    try {
      const stream = await getLocalMedia(pending.callType);
      const pc = createPeerConnection(pending.from);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(pending.offer));

      // Flush any ICE candidates that arrived while we were still ringing.
      for (const candidate of pendingCandidatesRef.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("addIceCandidate (queued) error:", err);
        }
      }
      pendingCandidatesRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("answerCall", { callerId: pending.from, answer });

      setCallState(CALL_STATE.ONGOING);
      setCallStartedAt(Date.now());
    } catch (err) {
      console.error("acceptCall error:", err);
      setCallError(describeMediaError(err));
      socket.emit("rejectCall", { callerId: pending.from, reason: "error" });
      resetCallState();
    }
  }, [socket, getLocalMedia, createPeerConnection, resetCallState]);

  // ---- Incoming call: decline ----
  const rejectCall = useCallback(() => {
    const pending = pendingOfferRef.current;
    if (socket && pending) {
      socket.emit("rejectCall", { callerId: pending.from, reason: "declined" });
    }
    resetCallState();
  }, [socket, resetCallState]);

  // ---- Hang up / cancel (works for any state) ----
  // Async now: sends the hangup signal immediately so the remote UI ends
  // without waiting for transcription uploads, then waits for the recorder's final chunk (whatever was
  // captured since the last scheduled 10s flush) to actually finish
  // uploading BEFORE telling the server the call ended. The server
  // starts polling for "has this room's audio gone quiet" as soon as it
  // gets that signal — see stopRecordingAndFlush's comment for why
  // skipping this wait was producing transcripts from a track that was
  // still mid-upload, which Whisper fills in with invented (hallucinated)
  // text rather than failing cleanly.
  const endCall = useCallback(async () => {
    if (socket) {
      if (callState === CALL_STATE.OUTGOING && remoteUser?._id) {
        socket.emit("cancelCall", { receiverId: remoteUser._id });
      } else if (remoteUser?._id) {
        socket.emit("endCall", { targetId: remoteUser._id });
      } else if (pendingOfferRef.current) {
        socket.emit("endCall", { targetId: pendingOfferRef.current.from });
      }
    }
    // Start recorder cleanup before reset (so its final chunk is preserved),
    // but do not wait for it before ending this browser's UI and media.
    const cleanup = stopRecordingAndFlush();
    resetCallState();
    await cleanup;
  }, [socket, callState, remoteUser, resetCallState, stopRecordingAndFlush]);

  // Keep endCallRef pointed at the latest endCall closure — see the ref's
  // declaration above for why createPeerConnection needs to reach endCall
  // indirectly like this instead of depending on it directly.
  useEffect(() => {
    endCallRef.current = endCall;
  }, [endCall]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;

    // Mute/unmute the WebRTC call stream (what the remote user hears)
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });

    // NOTE: The recording stream (recordingStreamRef) wraps a CLONE of
    // this same track, created in startRecording. A clone's `enabled`
    // flag is independent per spec, so toggling it here on the original
    // never touches the clone — recording keeps running, at full quality,
    // even while muted. This is intentional: we want to record everything
    // said during the call, even when the user is muted (for accurate
    // transcription).

    setIsMuted(nextMuted);
  }, [isMuted]);

  const toggleCamera = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextOff = !isCameraOff;
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = !nextOff;
    });
    setIsCameraOff(nextOff);
  }, [isCameraOff]);

  // Toggle speaker on/off (GPT-5.6-Luna instructions)
  const toggleSpeaker = useCallback(async () => {
    const nextSpeakerEnabled = !speakerEnabled;
    setSpeakerEnabled(nextSpeakerEnabled);

    const remoteElements = document.querySelectorAll(
      "audio[data-call-media], video.call-remote-video[data-call-media]"
    );
    await Promise.all(
      Array.from(remoteElements).map((element) =>
        applyAudioOutput(element, nextSpeakerEnabled)
      )
    );
  }, [speakerEnabled]);

  // Apply speaker setting when remote stream changes
  useEffect(() => {
    if (remoteStream) {
      const remoteElements = document.querySelectorAll(
        "audio[data-call-media], video.call-remote-video[data-call-media]"
      );
      remoteElements.forEach((element) => applyAudioOutput(element, speakerEnabled));
    }
  }, [remoteStream, speakerEnabled]);

  // ---- "Add people" — turn this ongoing 1:1 call into a group call ----
  // Lives in the call interface itself (CallModal renders the button),
  // which is exactly where it needs to be: the two people already
  // talking are the ones deciding to bring someone else in. Server does
  // all the real work (logs this call as completed, creates the new
  // room) and pushes "callUpgraded" back to both of us.
  const requestAddPeople = useCallback(() => {
    if (!socket || callState !== CALL_STATE.ONGOING || !remoteUser?._id) return;
    setAddingPeople(true);
    socket.emit("upgradeCallToGroup", { targetId: remoteUser._id, callType });
  }, [socket, callState, remoteUser, callType]);

  const clearGroupUpgrade = useCallback(() => setGroupUpgrade(null), []);

  // ---- Socket listeners ----
  useEffect(() => {
    if (!socket) return;

    const onIncomingCall = async ({ from, offer, callType: type }) => {
      // Busy: already in/starting a call — auto-decline so the caller
      // doesn't just ring forever.
      if (callState !== CALL_STATE.IDLE) {
        socket.emit("rejectCall", { callerId: from, reason: "busy" });
        return;
      }

      pendingOfferRef.current = { from, offer, callType: type };
      setCallType(type);
      setCallState(CALL_STATE.INCOMING);
      setCallError("");

      try {
        const { data } = await getUserProfile(from);
        setRemoteUser(data.user);
      } catch {
        setRemoteUser({ _id: from, username: "Unknown", avatar: "" });
      }
    };

    const onCallAnswered = async ({ answer }) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        setCallState(CALL_STATE.ONGOING);
        setCallStartedAt(Date.now());
      } catch (err) {
        console.error("setRemoteDescription (answer) error:", err);
      }
    };

    const onRenegotiateOffer = async ({ from, offer }) => {
      const pc = pcRef.current;
      if (!pc || !offer) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("renegotiateAnswer", { targetId: from, answer });
      } catch (err) {
        console.error("renegotiate offer error:", err);
      }
    };

    const onRenegotiateAnswer = async ({ answer }) => {
      const pc = pcRef.current;
      if (!pc || !answer) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error("renegotiate answer error:", err);
      }
    };

    const onIceCandidate = async ({ candidate }) => {
      const pc = pcRef.current;
      if (!candidate) return;
      if (!pc || !pc.remoteDescription) {
        // We haven't accepted yet (still ringing) — queue it.
        pendingCandidatesRef.current.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("addIceCandidate error:", err);
      }
    };

    const onCallRejected = ({ reason }) => {
      setCallError(reason === "busy" ? "They're on another call." : "Call declined.");
      resetCallState();
    };

    const onCallCancelled = () => {
      resetCallState();
    };

    // IMPORTANT: awaits stopRecordingAndFlush() before resetting, same as
    // endCall() does for the side that actually hangs up. Without this,
    // the side that DIDN'T hang up only ever gets a fire-and-forget
    // recorder.stop() (see resetCallState's backstop), racing its last
    // buffered chunk's upload against the server's transcription job
    // instead of guaranteeing it lands first — that race is exactly what
    // was cutting the tail end off recordings/transcripts.
    const onCallEnded = async () => {
      const cleanup = stopRecordingAndFlush();
      resetCallState();
      await cleanup;
    };

    const onCallFailed = ({ reason }) => {
      setCallError(reason === "offline" ? "They're offline right now." : "Call failed.");
      resetCallState();
    };

    // The call I'm on (or the ringing offer I'm mid-setup on) just got
    // turned into a group call — by me clicking "Add people", or by the
    // other side doing it. Either way I hand off into the group room the
    // same way: stop the 1:1 media/connection, let CallModal pick up
    // `groupUpgrade` and join via GroupCallContext.
    const onCallUpgraded = async ({ roomId, callType: upgradedType, link }) => {
      // Same reasoning as onCallEnded above: the server seals and
      // transcribes the 1:1 portion of this call the instant the upgrade
      // happens (see Socketmanager.js's upgradeCallToGroup), so this
      // side's own trailing audio needs to be flushed and confirmed
      // BEFORE we tear down, not just fire-and-forgotten.
      await stopRecordingAndFlush();
      resetCallState();
      setAddingPeople(false);
      setGroupUpgrade({ roomId, callType: upgradedType, link });
    };

    const onGroupCallError = ({ message }) => {
      if (addingPeople) {
        setAddingPeople(false);
        setCallError(message || "Couldn't add people to this call.");
      }
    };

    // The server has created a `Call` document for this now-connected
    // call and wants both sides to start recording their own mic for
    // transcription (see Socketmanager.js's startDirectCallRecording).
    // Fires once per call, right after "callAnswered"/acceptCall, so
    // localStreamRef is already populated by then on both sides.
    const onCallSessionStarted = ({ roomId, joinedAt }) => {
      callRoomIdRef.current = roomId;
      callJoinedAtRef.current = joinedAt;
      // startRecording clones the existing call track synchronously, but
      // we still don't inline it into this handler's own error path — a
      // recording-start failure must never be treated as a call failure.
      // Errors inside startRecording are caught and logged by
      // startRecording itself.
      startRecording(localStreamRef.current, roomId, joinedAt);
    };

    socket.on("incomingCall", onIncomingCall);
    socket.on("callAnswered", onCallAnswered);
    socket.on("renegotiateOffer", onRenegotiateOffer);
    socket.on("renegotiateAnswer", onRenegotiateAnswer);
    socket.on("iceCandidate", onIceCandidate);
    socket.on("callRejected", onCallRejected);
    socket.on("callCancelled", onCallCancelled);
    socket.on("callEnded", onCallEnded);
    socket.on("callFailed", onCallFailed);
    socket.on("callUpgraded", onCallUpgraded);
    socket.on("groupCallError", onGroupCallError);
    socket.on("callSessionStarted", onCallSessionStarted);

    return () => {
      socket.off("incomingCall", onIncomingCall);
      socket.off("callAnswered", onCallAnswered);
      socket.off("renegotiateOffer", onRenegotiateOffer);
      socket.off("renegotiateAnswer", onRenegotiateAnswer);
      socket.off("iceCandidate", onIceCandidate);
      socket.off("callRejected", onCallRejected);
      socket.off("callCancelled", onCallCancelled);
      socket.off("callEnded", onCallEnded);
      socket.off("callFailed", onCallFailed);
      socket.off("callUpgraded", onCallUpgraded);
      socket.off("groupCallError", onGroupCallError);
      socket.off("callSessionStarted", onCallSessionStarted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, callState, resetCallState, addingPeople, startRecording, stopRecordingAndFlush]);

  // Auto-clear a transient error banner after a few seconds.
  useEffect(() => {
    if (!callError) return;
    const t = setTimeout(() => setCallError(""), 4000);
    return () => clearTimeout(t);
  }, [callError]);

  // Clean up media/peer connection if the component unmounts mid-call
  // (e.g. logout).
  useEffect(() => {
    return () => resetCallState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = {
    callState,
    callType,
    remoteUser,
    localStream,
    remoteStream,
    isMuted,
    isCameraOff,
    speakerEnabled, // Add speaker state
    callError,
    callStartedAt,
    isReconnecting,
    currentUserId: user?._id,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    toggleSpeaker, // Add speaker toggle
    groupUpgrade,
    clearGroupUpgrade,
    requestAddPeople,
    addingPeople,
    remoteAudioRef, // Expose ref for UI to attach to audio/video element
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export { CALL_STATE };