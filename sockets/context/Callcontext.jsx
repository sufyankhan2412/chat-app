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
import {
  CALL_AUDIO_CHUNK_MS,
  CALL_AUDIO_BITRATE,
  CALL_AUDIO_CONSTRAINTS,
  pickSupportedAudioMimeType,
} from "../utils/audioRecording";

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
// MediaRecorder instances each starting their own chunk-seq counter at 0
// then upload two different "seq N" blobs for every N — same filename,
// so only one survives on disk per seq, but WHICHEVER one wins can
// differ tick to tick, splicing together audio from two unrelated
// recorder sessions (different init/header segments) into one corrupt
// WebM. This set is keyed by roomId and lives for the process's whole
// lifetime, so it catches the duplicate no matter which layer causes it.
const activeRecordingSessions = new Set();

// CALL_AUDIO_CHUNK_MS, CALL_AUDIO_BITRATE, CALL_AUDIO_CONSTRAINTS, and
// pickSupportedAudioMimeType now live in ../utils/audioRecording.js,
// shared with GroupCallContext.jsx, so the two call flows' capture/
// encode settings can never drift apart — see that file for the full
// reasoning behind each setting.

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

  // My own mic-only MediaRecorder for this 1:1 call, for transcription —
  // same mechanism GroupCallContext.jsx uses for group calls, now reused
  // here so a plain 1:1 audio/video call gets transcribed too. The server
  // only tells us to start (via "callSessionStarted", once both sides are
  // actually connected — see Socketmanager.js's startDirectCallRecording)
  // after it has created a `Call` document with a roomId for this call,
  // exactly like a group-call room.
  const recorderRef = useRef(null);
  const chunkSeqRef = useRef(0);
  const callRoomIdRef = useRef(null);
  const callJoinedAtRef = useRef(null);

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
    // Stops the mic-only recorder for this call — whatever chunks already
    // uploaded (see startRecording's ondataavailable below) stay on the
    // server and still get transcribed; this only ends the session.
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (callRoomIdRef.current) {
      activeRecordingSessions.delete(callRoomIdRef.current);
    }
    recorderRef.current = null;
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
  // small rolling chunks as they're produced. Identical mechanism and
  // upload endpoint to GroupCallContext.jsx's group-call recording — the
  // backend's transcription pipeline is generic per-roomId and doesn't
  // distinguish a 1:1 call's "room" (exactly two participants) from a
  // group call's. `joinedAt` is the SERVER timestamp from
  // "callSessionStarted", not a local clock reading.
  const startRecording = useCallback((stream, roomId, joinedAt) => {
    if (!stream || !stream.getAudioTracks().length) return;
    // Idempotency guard — see the comment on activeRecordingSessions
    // above for why a ref alone isn't enough here.
    if (activeRecordingSessions.has(roomId)) {
      return;
    }
    activeRecordingSessions.add(roomId);
    try {
      const audioOnly = new MediaStream(stream.getAudioTracks());

      // Was previously hardcoded to "audio/webm;codecs=opus" with no
      // fallback — on a browser that doesn't support that exact string
      // (Safari/iOS), `new MediaRecorder(...)` throws synchronously and
      // this participant's audio is never recorded for the whole call.
      // See ../utils/audioRecording.js for the fallback list.
      const mimeType = pickSupportedAudioMimeType();
      if (!mimeType) {
        console.error(
          "startRecording: no supported audio MediaRecorder mimeType on this browser — this call's audio will not be transcribed."
        );
        activeRecordingSessions.delete(roomId);
        return;
      }

      const recorder = new MediaRecorder(audioOnly, {
        mimeType,
        audioBitsPerSecond: CALL_AUDIO_BITRATE,
      });
      chunkSeqRef.current = 0;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0 && callRoomIdRef.current) {
          const seq = chunkSeqRef.current++;
          uploadCallAudioChunk(callRoomIdRef.current, joinedAt, seq, event.data).catch((err) => {
            console.error("uploadCallAudioChunk error:", err);
          });
        }
      };
      // Release the guard once this recorder actually stops (call ended,
      // or an error), so a genuinely new call reusing this same tab can
      // record again.
      recorder.onstop = () => activeRecordingSessions.delete(roomId);
      recorder.start(CALL_AUDIO_CHUNK_MS); // 10s rolling chunks
      recorderRef.current = recorder;
    } catch (err) {
      // Recording for transcription is a best-effort add-on to the call
      // itself — an unsupported codec or similar should never break the
      // actual call the user is trying to have.
      activeRecordingSessions.delete(roomId);
      console.error("startRecording error:", err);
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
  const endCall = useCallback(() => {
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
  }, [socket, callState, remoteUser, resetCallState]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
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