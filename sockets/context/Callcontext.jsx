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
import { getUserProfile } from "../api";

const CallContext = createContext(null);

export const useCall = () => useContext(CallContext);

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

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingOfferRef = useRef(null); // { from, offer, callType } while ringing
  const pendingCandidatesRef = useRef([]); // ICE candidates that arrive before remote description is set

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
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
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

    socket.on("incomingCall", onIncomingCall);
    socket.on("callAnswered", onCallAnswered);
    socket.on("iceCandidate", onIceCandidate);
    socket.on("callRejected", onCallRejected);
    socket.on("callCancelled", onCallCancelled);
    socket.on("callEnded", onCallEnded);
    socket.on("callFailed", onCallFailed);

    return () => {
      socket.off("incomingCall", onIncomingCall);
      socket.off("callAnswered", onCallAnswered);
      socket.off("iceCandidate", onIceCandidate);
      socket.off("callRejected", onCallRejected);
      socket.off("callCancelled", onCallCancelled);
      socket.off("callEnded", onCallEnded);
      socket.off("callFailed", onCallFailed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, callState, resetCallState]);

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
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export { CALL_STATE };