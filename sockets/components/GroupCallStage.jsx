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

function ParticipantTile({ userId, stream, mode, profile }) {
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
      <span className="gc-tile-name">{name}</span>
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
    leaveCall,
    toggleMute,
    toggleCamera,
  } = useGroupCall();

  const localVideoRef = useRef(null);
  const [profiles, setProfiles] = useState({}); // userId -> { username, avatar }
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream || null;
  }, [localStream]);

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
  if (callStatus !== "in-call") return null;

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
        <button type="button" className="gc-copy-link-btn" onClick={handleCopyLink}>
          <LinkIcon /> {linkCopied ? "Link copied" : "Copy link"}
        </button>
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
          <span className="gc-tile-name">You</span>
        </div>

        {peerEntries.map(([peerId, { stream, mode: peerMode }]) => (
          <ParticipantTile
            key={peerId}
            userId={peerId}
            stream={stream}
            mode={peerMode}
            profile={profiles[peerId]}
          />
        ))}
      </div>

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