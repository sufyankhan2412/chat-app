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
import { createCallLink } from "../api";

const GroupCallContext = createContext(null);

export const useGroupCall = () => useContext(GroupCallContext);

// Same ICE server setup as the 1:1 call flow (Callcontext.jsx) — see that
// file's comment for why a TURN relay matters in production.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
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

function describeMediaError(err) {
  if (err?.name === "InsecureContextError") return err.message;
  if (err?.name === "NotAllowedError") return "Camera/microphone permission denied.";
  if (err?.name === "NotFoundError") return "No camera or microphone was found on this device.";
  return "Couldn't join the call.";
}

export function GroupCallProvider({ children }) {
  const socket = useSocket();
  const { user } = useAuth();

  // "idle" -> not in a room. "in-call" -> joined and connected/connecting.
  const [callStatus, setCallStatus] = useState("idle");
  const [roomId, setRoomId] = useState(null);
  const [mode, setMode] = useState("video"); // my own mode: "audio" | "video"
  const [localStream, setLocalStream] = useState(null);
  // Map<userId, { stream: MediaStream|null, mode: "audio"|"video" }>
  const [peers, setPeers] = useState(new Map());
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [callError, setCallError] = useState("");
  const [callStartedAt, setCallStartedAt] = useState(null);
  // Whoever created this call link — only they can remove other
  // participants (mirrors Meet/WhatsApp's "organizer" permissions).
  const [hostId, setHostId] = useState(null);

  // In-call chat — lives purely in memory for the duration of the call
  // (mirrors Google Meet's in-call messages). Never sent to the backend
  // for persistence, never written to any database, and wiped the moment
  // the call ends (see resetAll below) — a page refresh or leaving the
  // call loses it just like Meet's does.
  const [chatMessages, setChatMessages] = useState([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);

  const localStreamRef = useRef(null);
  const roomIdRef = useRef(null);
  const modeRef = useRef("video");
  // Map<userId, RTCPeerConnection>
  const pcsRef = useRef(new Map());

  const cleanupPeer = useCallback((peerId) => {
    const pc = pcsRef.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pcsRef.current.delete(peerId);
    }
    setPeers((prev) => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    pcsRef.current.forEach((pc) => {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    });
    pcsRef.current = new Map();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    roomIdRef.current = null;
    setCallStatus("idle");
    setRoomId(null);
    setLocalStream(null);
    setPeers(new Map());
    setIsMuted(false);
    setIsCameraOff(false);
    setCallStartedAt(null);
    setHostId(null);
    // Chat is call-scoped only — drop it the instant the call ends so
    // nothing lingers past the "as long as the call is open" lifetime.
    setChatMessages([]);
    setUnreadChatCount(0);
  }, []);

  const getLocalMedia = useCallback(async (wantVideo) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error(
        "Camera/mic access is blocked on this connection. Open the app over HTTPS (or a dev tunnel) on this device."
      );
      err.name = "InsecureContextError";
      throw err;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: wantVideo,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  // Creates (or returns the existing) peer connection for one remote
  // participant, wires up ICE relay + incoming track handling. `initiator`
  // controls nothing about media, only whether *this* side is the one
  // expected to createOffer() right after — see joinCallRoom's
  // "existingPeers" comment on the server for why it's always the new
  // joiner who offers to everyone already present.
  const getOrCreatePeerConnection = useCallback(
    (peerId) => {
      if (pcsRef.current.has(peerId)) return pcsRef.current.get(peerId);

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = (event) => {
        if (event.candidate && socket && roomIdRef.current) {
          socket.emit("callSignal", {
            roomId: roomIdRef.current,
            targetUserId: peerId,
            signalType: "ice",
            payload: event.candidate,
          });
        }
      };

      pc.ontrack = (event) => {
        setPeers((prev) => {
          const next = new Map(prev);
          const existing = next.get(peerId) || { mode: "video" };
          next.set(peerId, { ...existing, stream: event.streams[0] });
          return next;
        });
      };

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      pcsRef.current.set(peerId, pc);
      return pc;
    },
    [socket]
  );

  // ---- Generate a shareable link WITHOUT joining yet (used by the "New
  // call" button in the Calls interface — mirrors Meet's "create a
  // meeting for later" option, but here it's also just... the same link
  // you'd use to join right now). ----
  const generateCallLink = useCallback(async (callType = "video") => {
    const { data } = await createCallLink(callType);
    return data; // { roomId, callType, link }
  }, []);

  // ---- Join a room (from the lobby/join screen) ----
  const joinCall = useCallback(
    async (targetRoomId, joinMode = "video") => {
      if (!socket || callStatus !== "idle") return;
      setCallError("");
      try {
        await getLocalMedia(joinMode === "video");
        roomIdRef.current = targetRoomId;
        modeRef.current = joinMode;
        setRoomId(targetRoomId);
        setMode(joinMode);
        setCallStatus("in-call");
        setCallStartedAt(Date.now());
        socket.emit("joinCallRoom", { roomId: targetRoomId, mode: joinMode });
      } catch (err) {
        console.error("joinCall error:", err);
        setCallError(describeMediaError(err));
        resetAll();
      }
    },
    [socket, callStatus, getLocalMedia, resetAll]
  );

  const leaveCall = useCallback(() => {
    if (socket && roomIdRef.current) {
      socket.emit("leaveCallRoom", { roomId: roomIdRef.current });
    }
    resetAll();
  }, [socket, resetAll]);

  // Host-only: force another participant out of the call. Gated again on
  // the client (isHost) purely for UI purposes — the server independently
  // checks that I'm actually Call.initiator before honoring this.
  const removeParticipant = useCallback(
    (peerId) => {
      if (!socket || !roomIdRef.current) return;
      socket.emit("removeParticipant", { roomId: roomIdRef.current, targetUserId: peerId });
    },
    [socket]
  );

  // Send an in-call chat message — relayed live via socket only, never
  // persisted. Appends it to our own list optimistically since the server
  // deliberately doesn't echo it back to the sender.
  const sendChatMessage = useCallback(
    (text) => {
      const trimmed = (text || "").trim();
      if (!trimmed || !socket || !roomIdRef.current || !user?._id) return;

      socket.emit("groupCallChatMessage", { roomId: roomIdRef.current, message: trimmed });

      setChatMessages((prev) => [
        ...prev,
        { fromUserId: user._id, message: trimmed, sentAt: Date.now(), isSelf: true },
      ]);
    },
    [socket, user]
  );

  // Called by the chat panel when it's open/visible so the unread badge
  // doesn't keep counting messages the user is already looking at.
  const markChatRead = useCallback(() => {
    setUnreadChatCount(0);
  }, []);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const next = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = !next));
    setIsMuted(next);
  }, [isMuted]);

  const toggleCamera = useCallback(() => {
    if (!localStreamRef.current) return;
    const next = !isCameraOff;
    localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = !next));
    setIsCameraOff(next);
  }, [isCameraOff]);

  // ---- Socket listeners: room join/leave + WebRTC signaling relay ----
  useEffect(() => {
    if (!socket) return;

    const onGroupCallJoined = async ({ peers: existingPeers, hostId: joinedHostId }) => {
      setHostId(joinedHostId || null);
      // I just joined — I offer to everyone who was already in the room.
      for (const peerId of existingPeers) {
        try {
          const pc = getOrCreatePeerConnection(peerId);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("callSignal", {
            roomId: roomIdRef.current,
            targetUserId: peerId,
            signalType: "offer",
            payload: offer,
          });
        } catch (err) {
          console.error("offer to existing peer error:", err);
        }
      }
    };

    const onPeerJoined = ({ peerId, mode: peerMode }) => {
      // Just track that they exist with a placeholder — their offer will
      // arrive shortly and drive the actual connection setup.
      setPeers((prev) => {
        if (prev.has(peerId)) return prev;
        const next = new Map(prev);
        next.set(peerId, { stream: null, mode: peerMode });
        return next;
      });
    };

    const onCallSignal = async ({ fromUserId, signalType, payload }) => {
      const pc = getOrCreatePeerConnection(fromUserId);
      try {
        if (signalType === "offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("callSignal", {
            roomId: roomIdRef.current,
            targetUserId: fromUserId,
            signalType: "answer",
            payload: answer,
          });
        } else if (signalType === "answer") {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
        } else if (signalType === "ice") {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(payload));
          }
          // Candidates that arrive before the remote description (rare with
          // this offer/answer ordering, but possible under jitter) are
          // simply dropped — WebRTC will still connect via later
          // candidates in practice; a full queue mirrors Callcontext.jsx
          // if this ever needs hardening further.
        }
      } catch (err) {
        console.error(`callSignal (${signalType}) error:`, err);
      }
    };

    const onPeerLeft = ({ peerId }) => {
      cleanupPeer(peerId);
    };

    // Incoming in-call chat message — kept only in React state, never
    // written anywhere persistent. Bumps the unread badge; the chat panel
    // clears it via markChatRead while it's open.
    const onGroupCallChatMessage = ({ fromUserId, message, sentAt }) => {
      setChatMessages((prev) => [...prev, { fromUserId, message, sentAt, isSelf: false }]);
      setUnreadChatCount((prev) => prev + 1);
    };

    const onGroupCallError = ({ message }) => {
      setCallError(message || "Call error.");
      resetAll();
    };

    // The host removed me — the server has already torn down its side of
    // the room, so just tear down our own media/peers and surface why,
    // rather than sitting on a call the host no longer wants us in.
    const onRemovedFromCall = () => {
      setCallError("The host removed you from this call.");
      resetAll();
    };

    socket.on("groupCallJoined", onGroupCallJoined);
    socket.on("peerJoined", onPeerJoined);
    socket.on("callSignal", onCallSignal);
    socket.on("peerLeft", onPeerLeft);
    socket.on("groupCallChatMessage", onGroupCallChatMessage);
    socket.on("groupCallError", onGroupCallError);
    socket.on("removedFromCall", onRemovedFromCall);

    return () => {
      socket.off("groupCallJoined", onGroupCallJoined);
      socket.off("peerJoined", onPeerJoined);
      socket.off("callSignal", onCallSignal);
      socket.off("peerLeft", onPeerLeft);
      socket.off("groupCallChatMessage", onGroupCallChatMessage);
      socket.off("groupCallError", onGroupCallError);
      socket.off("removedFromCall", onRemovedFromCall);
    };
  }, [socket, getOrCreatePeerConnection, cleanupPeer, resetAll]);

  // Auto-clear transient error banner.
  useEffect(() => {
    if (!callError) return;
    const t = setTimeout(() => setCallError(""), 5000);
    return () => clearTimeout(t);
  }, [callError]);

  // Leave cleanly if the component unmounts mid-call (logout, etc).
  useEffect(() => {
    return () => {
      if (socket && roomIdRef.current) {
        socket.emit("leaveCallRoom", { roomId: roomIdRef.current });
      }
      resetAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = {
    callStatus,
    roomId,
    mode,
    localStream,
    peers,
    isMuted,
    isCameraOff,
    callError,
    callStartedAt,
    hostId,
    isHost: Boolean(user?._id && hostId && String(user._id) === String(hostId)),
    generateCallLink,
    joinCall,
    leaveCall,
    toggleMute,
    toggleCamera,
    removeParticipant,
    chatMessages,
    unreadChatCount,
    sendChatMessage,
    markChatRead,
  };

  return <GroupCallContext.Provider value={value}>{children}</GroupCallContext.Provider>;
}