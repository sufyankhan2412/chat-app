import React, { useEffect, useRef, useState } from "react";
import { useCall, CALL_STATE } from "../context/Callcontext";
import { resolveAvatarUrl } from "../utils/avatar";

// Simple line-style call icons drawn to match the app's existing icon set
// (see ChatWindow.jsx's back/menu icons) — plain currentColor strokes,
// not any third-party brand's icon assets.
function PhoneIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function VideoIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function PhoneOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.86.32 1.75.55 2.67.68A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function MicIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  );
}

function MicOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
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
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function CameraOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1" />
      <path d="M9 7h5a2 2 0 0 1 2 2v5m4.5-2.5L23 7v10l-4.5-3.5" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

export default function CallModal() {
  const {
    callState,
    callType,
    remoteUser,
    localStream,
    remoteStream,
    isMuted,
    isCameraOff,
    callError,
    callStartedAt,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
  } = useCall();

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream || null;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream || null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream || null;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (callState !== CALL_STATE.ONGOING || !callStartedAt) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed(Date.now() - callStartedAt), 1000);
    return () => clearInterval(id);
  }, [callState, callStartedAt]);

  if (callState === CALL_STATE.IDLE) {
    // Still show a transient error toast (e.g. "they're offline") even
    // once we're back to idle.
    if (!callError) return null;
    return (
      <div className="call-toast" role="status">
        {callError}
      </div>
    );
  }

  const isVideo = callType === "video";
  const name = remoteUser?.username || "Unknown";
  const avatarUrl = resolveAvatarUrl(remoteUser?.avatar);

  return (
    <div className="call-overlay">
      {/* Hidden audio sink so voice plays even while the video element (if any)
          is muted/hidden — harmless no-op duplicate for video calls. */}
      {!isVideo && <audio ref={remoteAudioRef} autoPlay playsInline />}

      {isVideo && callState === CALL_STATE.ONGOING ? (
        <div className="call-video-stage">
          <video
            ref={remoteVideoRef}
            className="call-remote-video"
            autoPlay
            playsInline
          />
          {!remoteStream && (
            <div className="call-video-waiting">
              <img src={avatarUrl} alt={name} className="call-avatar call-avatar-lg" />
              <p>Connecting…</p>
            </div>
          )}
          <video
            ref={localVideoRef}
            className={`call-local-video ${isCameraOff ? "call-local-video-off" : ""}`}
            autoPlay
            playsInline
            muted
          />
        </div>
      ) : (
        <div className="call-audio-stage">
          <div className={`call-avatar-ring ${callState === CALL_STATE.ONGOING ? "" : "call-avatar-ring-pulse"}`}>
            <img src={avatarUrl} alt={name} className="call-avatar call-avatar-lg" />
          </div>
        </div>
      )}

      <div className="call-info-bar">
        <span className="call-contact-name">{name}</span>
        <span className="call-status-text">
          {callState === CALL_STATE.OUTGOING && "Calling…"}
          {callState === CALL_STATE.INCOMING &&
            `Incoming ${isVideo ? "video" : "voice"} call…`}
          {callState === CALL_STATE.ONGOING && formatDuration(elapsed)}
        </span>
      </div>

      <div className="call-controls">
        {callState === CALL_STATE.INCOMING ? (
          <>
            <button
              type="button"
              className="call-btn call-btn-decline"
              onClick={rejectCall}
              title="Decline"
            >
              <PhoneOffIcon />
            </button>
            <button
              type="button"
              className="call-btn call-btn-accept"
              onClick={acceptCall}
              title="Accept"
            >
              {isVideo ? <VideoIcon /> : <PhoneIcon />}
            </button>
          </>
        ) : (
          <>
            {callState === CALL_STATE.ONGOING && (
              <button
                type="button"
                className={`call-btn call-btn-secondary ${isMuted ? "call-btn-active" : ""}`}
                onClick={toggleMute}
                title={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted ? <MicOffIcon /> : <MicIcon />}
              </button>
            )}
            {callState === CALL_STATE.ONGOING && isVideo && (
              <button
                type="button"
                className={`call-btn call-btn-secondary ${isCameraOff ? "call-btn-active" : ""}`}
                onClick={toggleCamera}
                title={isCameraOff ? "Turn camera on" : "Turn camera off"}
              >
                {isCameraOff ? <CameraOffIcon /> : <CameraIcon />}
              </button>
            )}
            <button
              type="button"
              className="call-btn call-btn-decline"
              onClick={endCall}
              title="End call"
            >
              <PhoneOffIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}