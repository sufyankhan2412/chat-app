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
import { CALL_AUDIO_CHUNK_MS, CALL_AUDIO_CONSTRAINTS } from "../utils/audioRecording";
import { createPcmChunkRecorder } from "../utils/pcmRecorder";

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

// Public STUN servers are enough to discover most users' public IP/port so
// two peers can connect directly. Some networks (symmetric NATs, strict
// corporate firewalls) need a TURN (relay) server as well — add one here
// (e.g. Twilio, Metered, or your own coturn) for production use:
//   { urls: "turn:your-turn-server:3478", username: "...", credential: "..." }
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Set these in sockets/.env (see README) to add a TURN relay. Without one,
  // two devices on different networks (e.g. laptop on wifi + phone on
  // mobile data, or a wifi with client isolation) usually cannot connect
  // even though STUN lets them "see" each other.
  ...(import.meta.env.VITE_TURN_URL
    ? [
        {
          urls: import.meta.env.VITE_TURN_URL,
          username: import.meta.env.VITE_TURN_USERNAME,
          credential: import.meta.env.VITE_TURN_CREDENTIAL,
        },
      ]
    : []),
];

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
  const [callError, setCallError] = useState("");
  const [callStartedAt, setCallStartedAt] = useState(null);
  // Set once the other side (or I) successfully turn this 1:1 call into a
  // link-based group call — { roomId, callType, link }. CallModal watches
  // this to hand off into GroupCallContext automatically, for both people,
  // without either of them needing to click anything else.
  const [groupUpgrade, setGroupUpgrade] = useState(null);
  const [addingPeople, setAddingPeople] = useState(false);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingOfferRef = useRef(null); // { from, offer, callType } while ringing
  const pendingCandidatesRef = useRef([]); // ICE candidates that arrive before remote description is set

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
  // Dedicated recording stream (Stream B) — completely independent from
  // localStreamRef (Stream A, used for WebRTC). Obtained via a separate
  // getUserMedia() call in startRecording with browser audio processing
  // disabled, so the PCM recorder captures the raw microphone signal
  // rather than the AEC-processed signal that goes to the peer connection.
  // Never added to any RTCPeerConnection. See RECORDING_AUDIO_CONSTRAINTS
  // in audioRecording.js for the full rationale.
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
    recorder.flush(); // synchronously triggers onChunk -> uploadCallAudioChunk for anything buffered
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
  }, []);

  const resetCallState = useCallback(() => {
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
    pendingOfferRef.current = null;
    pendingCandidatesRef.current = [];

    setCallState(CALL_STATE.IDLE);
    setRemoteUser(null);
    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setIsCameraOff(false);
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

      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          // Let the natural endCall/cleanup flow handle it if we already
          // hung up; otherwise this covers the "network just died" case.
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [socket]
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
  // CRITICAL FIX for mute/unmute bug:
  // We MUST use a completely separate getUserMedia() call for recording
  // because track.clone() shares the same underlying media source. When
  // the original track is muted (track.enabled = false), the cloned
  // track stops receiving data too. To record continuously regardless
  // of mute state, we need an independent stream.
  //
  // To avoid browser throttling (the issue that made us try cloning),
  // we request this AFTER the call has already connected and the first
  // getUserMedia succeeded, and we request audio-only (no video).
  // Modern browsers handle two audio-only streams fine.
  const startRecording = useCallback(async (stream, roomId, joinedAt) => {
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
      // Get a completely separate audio stream for recording
      // This stream is independent of localStreamRef and will continue
      // capturing audio even when localStreamRef's tracks are muted
      const recordingStream = await navigator.mediaDevices.getUserMedia({
        audio: CALL_AUDIO_CONSTRAINTS,
        video: false // Audio only to avoid conflicts
      });
      
      recordingStreamRef.current = recordingStream;
      
      console.log("[RECORDING AUDIO] Using independent recording stream", {
        recordingStream: {
          id: recordingStream.id,
          tracks: recordingStream.getAudioTracks().length,
          audioTrack: {
            id: recordingStream.getAudioTracks()[0]?.id,
            label: recordingStream.getAudioTracks()[0]?.label,
            enabled: recordingStream.getAudioTracks()[0]?.enabled,
            muted: recordingStream.getAudioTracks()[0]?.muted,
            readyState: recordingStream.getAudioTracks()[0]?.readyState,
          },
          settings: recordingStream.getAudioTracks()[0]?.getSettings(),
        }
      });

      const audioOnly = new MediaStream(recordingStream.getAudioTracks());
      chunkSeqRef.current = 0;

      const recorder = createPcmChunkRecorder({
        stream: audioOnly,
        chunkMs: CALL_AUDIO_CHUNK_MS,
        onChunk: (pcmArrayBuffer, sampleRate) => {
          if (!callRoomIdRef.current) return;
          const seq = chunkSeqRef.current++;
          const uploadPromise = uploadCallAudioChunk(
            callRoomIdRef.current,
            joinedAt,
            seq,
            pcmArrayBuffer,
            sampleRate
          )
            .catch((err) => {
              console.error("uploadCallAudioChunk error:", err);
            })
            .finally(() => {
              pendingUploadsRef.current.delete(uploadPromise);
            });
          pendingUploadsRef.current.add(uploadPromise);
        },
      });

      recorder.start().then(() => {
        console.log("[RECORDING AUDIO] Recorder started successfully");
      }).catch((err) => {
        activeRecordingSessions.delete(roomId);
        // Stop the recording stream if the recorder fails to start
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
      console.error("startRecording: Failed to get independent recording stream", err);
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
      audio: CALL_AUDIO_CONSTRAINTS,
      video: type === "video",
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
  // Async now: waits for the recorder's final chunk (whatever was
  // captured since the last scheduled 10s flush) to actually finish
  // uploading BEFORE telling the server the call ended. The server
  // starts polling for "has this room's audio gone quiet" as soon as it
  // gets that signal — see stopRecordingAndFlush's comment for why
  // skipping this wait was producing transcripts from a track that was
  // still mid-upload, which Whisper fills in with invented (hallucinated)
  // text rather than failing cleanly.
  const endCall = useCallback(async () => {
    await stopRecordingAndFlush();
    if (socket) {
      if (callState === CALL_STATE.OUTGOING && remoteUser?._id) {
        socket.emit("cancelCall", { receiverId: remoteUser._id });
      } else if (remoteUser?._id) {
        socket.emit("endCall", { targetId: remoteUser._id });
      } else if (pendingOfferRef.current) {
        socket.emit("endCall", { targetId: pendingOfferRef.current.from });
      }
    }
    resetCallState();
  }, [socket, callState, remoteUser, resetCallState, stopRecordingAndFlush]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    
    // Mute/unmute the WebRTC call stream (what the remote user hears)
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    
    // NOTE: The recording stream (recordingStreamRef) is completely
    // independent - obtained via a separate getUserMedia() call in
    // startRecording(). Muting the call audio does NOT affect recording.
    // This is intentional: we want to record everything said during the
    // call, even when the user is muted (for accurate transcription).
    
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

    const onCallEnded = () => {
      resetCallState();
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
    const onCallUpgraded = ({ roomId, callType: upgradedType, link }) => {
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
      // startRecording is async (opens a second getUserMedia for Stream B)
      // but we intentionally don't await it here — the call is already
      // live and we don't want recording startup to block or error-propagate
      // into the socket event handler. Errors inside startRecording are
      // caught and logged by startRecording itself.
      startRecording(localStreamRef.current, roomId, joinedAt);
    };

    socket.on("incomingCall", onIncomingCall);
    socket.on("callAnswered", onCallAnswered);
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
  }, [socket, callState, resetCallState, addingPeople, startRecording]);

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
    callError,
    callStartedAt,
    currentUserId: user?._id,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    groupUpgrade,
    clearGroupUpgrade,
    requestAddPeople,
    addingPeople,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export { CALL_STATE };