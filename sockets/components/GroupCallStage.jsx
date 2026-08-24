import React, { useEffect, useRef, useState } from "react";
import { useGroupCall } from "../context/Groupcallcontext";
import { getUserProfile } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";

function MicIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  );
}
function MicOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 4.24 2.74M15 9.34V4a3 3 0 0 0-5.68-1.33" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2M19 10v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}
function CameraIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}
function CameraOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1" />
      <path d="M9 7h5a2 2 0 0 1 2 2v5m4.5-2.5L23 7v10l-4.5-3.5" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function PhoneOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.86.32 1.75.55 2.67.68A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function LinkIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function RemoveParticipantIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

// The "professional" chat-bubble logo — clicking this is what opens/closes
// the in-call chat panel, same trigger spot as Meet's chat icon in the
// call toolbar.
function ChatIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function SendIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function CloseIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Small floating chat panel — mirrors Meet's "in-call messages": lives only
// as long as the parent <GroupCallStage/> is mounted (i.e. the call is
// open), messages are plain component state passed down from
// GroupCallContext (nothing ever touches a database), and it vanishes the
// instant the call ends since the whole overlay unmounts then.
function GroupCallChatPanel({ messages, profiles, onSend, onClose }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  const nameFor = (msg) => {
    if (msg.isSelf) return "You";
    return profiles[msg.fromUserId]?.username || "Participant";
  };

  return (
    <div className="gc-chat-panel">
      <div className="gc-chat-header">
        <span>In-call messages</span>
        <button type="button" className="gc-chat-close-btn" onClick={onClose} title="Close chat">
          <CloseIcon />
        </button>
      </div>

      <div className="gc-chat-hint">Messages here can only be seen by people in the call, and are cleared when the call ends.</div>

      <div className="gc-chat-messages" ref={listRef}>
        {messages.length === 0 && <div className="gc-chat-empty">No messages yet — say hi!</div>}
        {messages.map((msg, idx) => (
          <div key={idx} className={`gc-chat-msg ${msg.isSelf ? "gc-chat-msg-self" : ""}`}>
            <div className="gc-chat-msg-meta">
              <span className="gc-chat-msg-author">{nameFor(msg)}</span>
              <span className="gc-chat-msg-time">
                {new Date(msg.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="gc-chat-msg-bubble">{msg.message}</div>
          </div>
        ))}
      </div>

      <form className="gc-chat-input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          className="gc-chat-input"
          placeholder="Send a message to everyone"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={1000}
        />
        <button type="submit" className="gc-chat-send-btn" disabled={!draft.trim()} title="Send">
          <SendIcon />
        </button>
      </form>
    </div>
  );
}

function ParticipantTile({ userId, stream, mode, profile, isHost, canRemove, onRemove }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream || null;
    if (audioRef.current) audioRef.current.srcObject = stream || null;
  }, [stream]);

  const name = profile?.username || "Joining…";

  return (
    <div className="gc-tile">
      {mode === "video" ? (
        <>
          <video ref={videoRef} autoPlay playsInline className="gc-tile-video" />
          {!stream && (
            <div className="gc-tile-placeholder">
              <img src={resolveAvatarUrl(profile?.avatar)} alt={name} className="gc-tile-avatar" />
            </div>
          )}
        </>
      ) : (
        <>
          <audio ref={audioRef} autoPlay />
          <div className="gc-tile-placeholder">
            <img src={resolveAvatarUrl(profile?.avatar)} alt={name} className="gc-tile-avatar" />
          </div>
        </>
      )}
      {canRemove && (
        <button
          type="button"
          className="gc-tile-remove-btn"
          onClick={() => {
            if (window.confirm(`Remove ${name} from this call?`)) onRemove(userId);
          }}
          title={`Remove ${name}`}
        >
          <RemoveParticipantIcon />
        </button>
      )}
      <span className="gc-tile-name">
        {name}
        {isHost && <span className="gc-tile-host-badge">Host</span>}
      </span>
    </div>
  );
}

export default function GroupCallStage({ onLeave }) {
  const {
    callStatus,
    roomId,
    mode,
    localStream,
    peers,
    isMuted,
    isCameraOff,
    hostId,
    isHost,
    callError,
    leaveCall,
    toggleMute,
    toggleCamera,
    removeParticipant,
    chatMessages,
    unreadChatCount,
    sendChatMessage,
    markChatRead,
  } = useGroupCall();

  const localVideoRef = useRef(null);
  const [profiles, setProfiles] = useState({}); // userId -> { username, avatar }
  const [linkCopied, setLinkCopied] = useState(false);
  // Chat panel starts closed every time — it only opens on an explicit
  // click of the chat icon, per call.
  const [showChat, setShowChat] = useState(false);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream || null;
  }, [localStream]);

  // Keep the unread badge cleared while the panel is actually open,
  // including for messages that arrive while the user is looking at it.
  useEffect(() => {
    if (showChat) markChatRead();
  }, [showChat, chatMessages, markChatRead]);

  // Fetch display info for any peer we don't have a profile for yet.
  useEffect(() => {
    peers.forEach((_, peerId) => {
      if (profiles[peerId]) return;
      getUserProfile(peerId)
        .then(({ data }) => {
          setProfiles((prev) => ({ ...prev, [peerId]: data.user }));
        })
        .catch(() => {});
    });
  }, [peers, profiles]);

  // Self-guarding so this can be mounted globally (alongside <CallModal/>)
  // and simply render nothing the rest of the time — needed because a
  // group call can now start two ways: joining a link directly (rendered
  // inline by JoinCallPage) or an ongoing 1:1 call being upgraded via
  // "Add people" from anywhere in the app (CallModal triggers the join,
  // but has no dedicated screen of its own to show it on).
  if (callStatus !== "in-call") {
    // Surface why we just left even after the overlay itself is gone (e.g.
    // the host removed us) — same transient-toast pattern CallModal uses
    // for its own 1:1 call errors.
    if (callError) {
      return (
        <div className="call-toast" role="status">
          {callError}
        </div>
      );
    }
    return null;
  }

  const handleLeave = () => {
    leaveCall();
    onLeave?.();
  };
  const handleCopyLink = async () => {
    const link = `${window.location.origin}/call/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // clipboard API unavailable — silently ignore, link is still visible below
    }
  };

  const peerEntries = Array.from(peers.entries());
  const totalTiles = peerEntries.length + 1;

  return (
    <div className="gc-overlay">
      <div className="gc-topbar">
        <span className="gc-participant-count">
          {totalTiles} {totalTiles === 1 ? "participant" : "participants"}
        </span>
        {callError && <span className="gc-error-banner">{callError}</span>}
        <div className="gc-topbar-actions">
          <button type="button" className="gc-copy-link-btn" onClick={handleCopyLink}>
            <LinkIcon /> {linkCopied ? "Link copied" : "Copy link"}
          </button>
          {/* The "professional chat logo" — click to open/close the small
              in-call chat panel, works for both video and audio-mode calls. */}
          <button
            type="button"
            className={`gc-chat-toggle-btn ${showChat ? "gc-chat-toggle-btn-active" : ""}`}
            onClick={() => setShowChat((prev) => !prev)}
            title={showChat ? "Close chat" : "Open chat"}
          >
            <ChatIcon />
            {!showChat && unreadChatCount > 0 && (
              <span className="gc-chat-badge">{unreadChatCount > 9 ? "9+" : unreadChatCount}</span>
            )}
          </button>
        </div>
      </div>

      <div className={`gc-grid gc-grid-${Math.min(totalTiles, 9)}`}>
        <div className="gc-tile gc-tile-self">
          {mode === "video" ? (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`gc-tile-video gc-tile-video-mirrored ${isCameraOff ? "gc-hidden" : ""}`}
            />
          ) : null}
          {(mode !== "video" || isCameraOff) && (
            <div className="gc-tile-placeholder">
              <div className="gc-self-avatar-dot" />
            </div>
          )}
          <span className="gc-tile-name">
            You
            {isHost && <span className="gc-tile-host-badge">Host</span>}
          </span>
        </div>

        {peerEntries.map(([peerId, { stream, mode: peerMode }]) => (
          <ParticipantTile
            key={peerId}
            userId={peerId}
            stream={stream}
            mode={peerMode}
            profile={profiles[peerId]}
            isHost={hostId && String(peerId) === String(hostId)}
            canRemove={isHost}
            onRemove={removeParticipant}
          />
        ))}
      </div>

      {/* Only ever rendered while callStatus === "in-call" (see the early
          return above), so this — and every message inside it — disappears
          the moment the call ends. Nothing here is persisted. */}
      {showChat && (
        <GroupCallChatPanel
          messages={chatMessages}
          profiles={profiles}
          onSend={sendChatMessage}
          onClose={() => setShowChat(false)}
        />
      )}

      <div className="gc-controls">
        <button
          type="button"
          className={`call-btn call-btn-secondary ${isMuted ? "call-btn-active" : ""}`}
          onClick={toggleMute}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? <MicOffIcon /> : <MicIcon />}
        </button>
        {mode === "video" && (
          <button
            type="button"
            className={`call-btn call-btn-secondary ${isCameraOff ? "call-btn-active" : ""}`}
            onClick={toggleCamera}
            title={isCameraOff ? "Turn camera on" : "Turn camera off"}
          >
            {isCameraOff ? <CameraOffIcon /> : <CameraIcon />}
          </button>
        )}
        <button type="button" className="call-btn call-btn-decline" onClick={handleLeave} title="Leave call">
          <PhoneOffIcon />
        </button>
      </div>
    </div>
  );
}