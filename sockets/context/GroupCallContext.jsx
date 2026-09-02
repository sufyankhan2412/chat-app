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
import { createCallLink, getGroupCallChatHistory, uploadCallAudioChunk } from "../api";
import {
  CALL_AUDIO_CHUNK_MS,
  CALL_AUDIO_BITRATE,
  CALL_AUDIO_CONSTRAINTS,
  pickSupportedAudioMimeType,
} from "../utils/audioRecording";

const GroupCallContext = createContext(null);

export const useGroupCall = () => useContext(GroupCallContext);

// See the identical comment on activeRecordingSessions in
// Callcontext.jsx — same reasoning, same fix, keyed by roomId, shared
// across every join session in this tab's lifetime.
const activeRecordingSessions = new Set();

// CALL_AUDIO_CHUNK_MS, CALL_AUDIO_BITRATE, CALL_AUDIO_CONSTRAINTS, and
// pickSupportedAudioMimeType now live in ../utils/audioRecording.js,
// shared with Callcontext.jsx, so the two call flows' capture/encode
// settings can never drift apart — see that file for the full reasoning
// behind each setting.

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

  // Meeting-level chat — persisted server-side against the room's
  // roomId (see backend/models/GroupCallMessage.js), not scoped to this
  // socket session. Leaving and rejoining the same room loads the same
  // history back rather than starting a new, empty chat; only the
  // in-memory view here (this array) is rebuilt fresh on each join.
  const [chatMessages, setChatMessages] = useState([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  // Whether there's an older page of chat history available to load
  // (cursor pagination — see loadOlderChatMessages below).
  const [hasMoreChatHistory, setHasMoreChatHistory] = useState(false);
  const [loadingOlderChat, setLoadingOlderChat] = useState(false);
  // The first message (by _id) that was unread when this join happened —
  // drawn once from the server's lastReadMessageId so the chat panel can
  // render a "New messages" divider at the right spot. Stays fixed for
  // the rest of this call session even as those messages get marked read.
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState(null);

  const localStreamRef = useRef(null);
  const roomIdRef = useRef(null);
  const modeRef = useRef("video");
  // Map<userId, RTCPeerConnection>
  const pcsRef = useRef(new Map());
  // My own mic-only MediaRecorder for this join session — see
  // startRecording below. Calls are mesh WebRTC, so this is the only way
  // any audio ever reaches the server for transcription purposes; it's
  // entirely separate from the peer connections above, which just carry
  // live audio/video directly to the other participants' browsers.
  const recorderRef = useRef(null);
  // This join session's next chunk ordinal — tagged onto every uploaded
  // chunk so the server can reassemble them in the order they were
  // recorded, not the order the uploads happen to arrive in. See
  // startRecording and upload.js's saveCallAudioChunk.
  const chunkSeqRef = useRef(0);
  // This join's own SERVER timestamp (from "groupCallJoined"), used to
  // tag every uploaded chunk so the backend can match it back to the
  // right Call.participants entry and place it on the shared timeline.
  const joinedAtRef = useRef(null);
  // Mirrors the server's per-participant read cursor so markChatRead can
  // skip redundant "markCallChatRead" emits once we're already caught up.
  const lastReadMessageIdRef = useRef(null);
  const loadingOlderChatRef = useRef(false);

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
    // Stops the mic-only recorder for this join session — whatever chunks
    // already uploaded (see startRecording's ondataavailable) stay on the
    // server; this only ends the session, it doesn't discard anything.
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (roomIdRef.current) {
      activeRecordingSessions.delete(roomIdRef.current);
    }
    recorderRef.current = null;
    joinedAtRef.current = null;
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
    // Only the in-memory VIEW of the chat is cleared here — the messages
    // themselves stay persisted server-side against the roomId and come
    // back on the next join/rejoin (see onGroupCallJoined below).
    setChatMessages([]);
    setUnreadChatCount(0);
    setHasMoreChatHistory(false);
    setFirstUnreadMessageId(null);
    lastReadMessageIdRef.current = null;
    loadingOlderChatRef.current = false;
    setLoadingOlderChat(false);
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
      audio: CALL_AUDIO_CONSTRAINTS,
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

  // Records MY OWN mic audio (never anyone else's — that never reaches
  // this browser as a separate track to begin with) for this join
  // session, uploading small rolling chunks as they're produced rather
  // than buffering the whole call in memory and sending it at the end.
  // That matters specifically for the paths that don't go through a
  // clean leaveCall() — a host removal or a crashed/closed tab — where
  // incremental upload means only the last few seconds are ever at risk,
  // not the whole recording. `joinedAt` is the server timestamp from
  // "groupCallJoined", not a local clock reading (see api.js).
  const startRecording = useCallback((stream, joinedAt) => {
    if (!stream || !stream.getAudioTracks().length) return;
    const roomId = roomIdRef.current;
    // Idempotency guard — see activeRecordingSessions' comment above.
    if (!roomId || activeRecordingSessions.has(roomId)) {
      return;
    }
    activeRecordingSessions.add(roomId);
    try {
      const audioOnly = new MediaStream(stream.getAudioTracks());

      // Feature-detect the best container this browser can actually
      // produce — see ../utils/audioRecording.js's pickSupportedAudioMimeType
      // for the fallback list and why this matters (Safari/iOS don't
      // support "audio/webm;codecs=opus" at all).
      const mimeType = pickSupportedAudioMimeType();
      if (!mimeType) {
        console.error(
          "startRecording: no supported audio MediaRecorder mimeType on this browser — this participant's audio will not be transcribed."
        );
        return;
      }

      // Opus's default bitrate for a plain audio-only MediaRecorder call
      // can land as low as ~24-32kbps in some browsers, which is fine
      // for playback but throws away detail whisper relies on,
      // especially for quieter/farther-from-mic speakers in a group
      // call. 128kbps mono is comfortably more than enough for speech
      // and still keeps a 10s chunk under ~160KB.
      const recorder = new MediaRecorder(audioOnly, {
        mimeType,
        audioBitsPerSecond: CALL_AUDIO_BITRATE,
      });
      chunkSeqRef.current = 0;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0 && roomIdRef.current) {
          const seq = chunkSeqRef.current++;
          uploadCallAudioChunk(roomIdRef.current, joinedAt, seq, event.data).catch((err) => {
            console.error("uploadCallAudioChunk error:", err);
          });
        }
      };
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

  // Send a meeting-chat message. The server persists it and broadcasts
  // the saved copy (with its real _id) back to the whole room, sender
  // included (see onGroupCallChatMessage below) — so unlike before, we
  // don't append an optimistic local copy here; our own message shows up
  // the same way everyone else's does, just a beat later.
  const sendChatMessage = useCallback(
    (text) => {
      const trimmed = (text || "").trim();
      if (!trimmed || !socket || !roomIdRef.current) return;
      socket.emit("groupCallChatMessage", { roomId: roomIdRef.current, message: trimmed });
    },
    [socket]
  );

  // Advances our read cursor to `messageId` (defaults to the newest
  // message currently loaded) and persists it server-side, so a later
  // leave + rejoin of this same meeting picks up unread state from
  // exactly here rather than from the start of the chat. Called by the
  // chat panel whenever it's open and visible.
  const markChatRead = useCallback(
    (messageId) => {
      setUnreadChatCount(0);
      const targetId = messageId || chatMessages[chatMessages.length - 1]?._id;
      if (!targetId || targetId === lastReadMessageIdRef.current) return;
      if (!socket || !roomIdRef.current) return;
      lastReadMessageIdRef.current = targetId;
      socket.emit("markCallChatRead", { roomId: roomIdRef.current, lastReadMessageId: targetId });
    },
    [socket, chatMessages]
  );

  // Loads one older page of this meeting's chat (scrolling further back
  // than what joinCallRoom seeded) and prepends it to the in-memory list.
  const loadOlderChatMessages = useCallback(async () => {
    if (!roomIdRef.current || !hasMoreChatHistory || loadingOlderChatRef.current) return;
    const oldest = chatMessages[0];
    if (!oldest) return;

    loadingOlderChatRef.current = true;
    setLoadingOlderChat(true);
    try {
      const { data } = await getGroupCallChatHistory(roomIdRef.current, {
        before: oldest.sentAt,
      });
      const older = data.messages.map((m) => ({
        _id: String(m._id),
        fromUserId: m.sender?._id || m.sender,
        message: m.message,
        sentAt: m.createdAt,
        isSelf: String(m.sender?._id || m.sender) === String(user?._id),
      }));
      setChatMessages((prev) => [...older, ...prev]);
      setHasMoreChatHistory(Boolean(data.hasMore));
    } catch (err) {
      console.error("loadOlderChatMessages error:", err);
    } finally {
      loadingOlderChatRef.current = false;
      setLoadingOlderChat(false);
    }
  }, [hasMoreChatHistory, user, chatMessages]);

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

    const onGroupCallJoined = async ({
      peers: existingPeers,
      hostId: joinedHostId,
      chatHistory,
      lastReadMessageId,
      callStartedAt,
      joinedAt,
    }) => {
      setHostId(joinedHostId || null);

      // Start recording my own mic for transcription purposes as soon as
      // the room actually accepts me — callStartedAt/joinedAt are both
      // server timestamps (see Socketmanager.js), so this stays aligned
      // with everyone else's recording regardless of each device's own
      // clock. `callStartedAt` itself isn't needed client-side beyond
      // this — the merge/offset math happens entirely on the backend
      // once all participants' audio is uploaded.
      joinedAtRef.current = joinedAt;
      startRecording(localStreamRef.current, joinedAt);

      // Meeting-level chat: whether this is a first join or a rejoin,
      // the server hands back the same persisted history plus wherever
      // our own read cursor last left off, so we can figure out exactly
      // which messages (if any) are new since we were last here.
      if (chatHistory) {
        const seeded = chatHistory.messages.map((m) => ({
          _id: String(m._id),
          fromUserId: m.sender,
          message: m.message,
          sentAt: m.createdAt,
          isSelf: String(m.sender) === String(user?._id),
        }));
        setChatMessages(seeded);
        setHasMoreChatHistory(Boolean(chatHistory.hasMore));

        lastReadMessageIdRef.current = lastReadMessageId || null;
        const readIndex = lastReadMessageId
          ? seeded.findIndex((m) => m._id === lastReadMessageId)
          : -1;
        const unread = seeded.slice(readIndex + 1).filter((m) => !m.isSelf);
        setUnreadChatCount(unread.length);
        setFirstUnreadMessageId(unread[0]?._id || null);
      }

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

    // Incoming meeting-chat message — the server already persisted this
    // (see Socketmanager.js) and broadcasts it to the whole room,
    // including back to whoever sent it, so this is how our own sent
    // messages appear too, not just everyone else's. Only bumps the
    // unread badge for messages that aren't our own; the chat panel
    // clears it via markChatRead while it's open.
    const onGroupCallChatMessage = ({ _id, fromUserId, message, sentAt }) => {
      const isSelf = String(fromUserId) === String(user?._id);
      setChatMessages((prev) => [...prev, { _id, fromUserId, message, sentAt, isSelf }]);
      if (!isSelf) setUnreadChatCount((prev) => prev + 1);
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
  }, [socket, getOrCreatePeerConnection, cleanupPeer, resetAll, user, startRecording]);

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
    hasMoreChatHistory,
    loadingOlderChat,
    firstUnreadMessageId,
    loadOlderChatMessages,
  };

  return <GroupCallContext.Provider value={value}>{children}</GroupCallContext.Provider>;
}