import React, { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getCallRoomInfo } from "../api";
import { useGroupCall } from "../context/GroupCallContext";
import { useAuth } from "../context/Authcontext";
import { resolveAvatarUrl } from "../utils/avatar";

function VideoGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function PhoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export default function JoinCallPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { callStatus, joinCall, callError } = useGroupCall();

  const [roomInfo, setRoomInfo] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [previewStream, setPreviewStream] = useState(null);
  const previewVideoRef = useRef(null);

  // Once joined, the globally-mounted <GroupCallStage/> (see App.jsx)
  // takes over the whole screen regardless of route — this page's job is
  // done, so just get out of the URL bar and back to somewhere normal.
  useEffect(() => {
    if (callStatus === "in-call") {
      navigate("/chat", { replace: true });
    }
  }, [callStatus, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getCallRoomInfo(roomId);
        if (!cancelled) setRoomInfo(data);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err.response?.data?.message || "This call link is invalid or has ended."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Camera preview in the lobby, independent of the actual call stream
  // (which GroupCallContext creates only once you actually join).
  useEffect(() => {
    let stream;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        setPreviewStream(stream);
      } catch {
        // No camera / permission denied — fine, still shows the audio-join option.
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    if (previewVideoRef.current) previewVideoRef.current.srcObject = previewStream || null;
  }, [previewStream]);

  const handleJoin = (mode) => {
    previewStream?.getTracks().forEach((t) => t.stop());
    setPreviewStream(null);
    joinCall(roomId, mode);
  };

  if (loading) {
    return (
      <div className="join-call-page">
        <div className="loading-screen">Loading…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="join-call-page">
        <div className="join-call-card">
          <h2>Can't join this call</h2>
          <p className="join-call-subtitle">{loadError}</p>
          <button type="button" className="join-call-btn-secondary" onClick={() => navigate("/chat")}>
            Back to chats
          </button>
        </div>
      </div>
    );
  }

  const initiatorName = roomInfo?.initiator?.username || "Someone";

  return (
    <div className="join-call-page">
      <div className="join-call-card">
        <div className="join-call-preview">
          {previewStream ? (
            <video ref={previewVideoRef} autoPlay playsInline muted className="join-call-preview-video" />
          ) : (
            <img
              src={resolveAvatarUrl(user?.avatar)}
              alt={user?.username}
              className="join-call-preview-avatar"
            />
          )}
        </div>

        <h2>{initiatorName}'s call</h2>
        <p className="join-call-subtitle">
          {roomInfo?.callType === "video" ? "Video call" : "Voice call"} · ready to join?
        </p>

        {callError && <p className="join-call-error">{callError}</p>}

        <div className="join-call-actions">
          <button type="button" className="join-call-btn join-call-btn-audio" onClick={() => handleJoin("audio")}>
            <PhoneGlyph /> Join with audio
          </button>
          <button type="button" className="join-call-btn join-call-btn-video" onClick={() => handleJoin("video")}>
            <VideoGlyph /> Join with video
          </button>
        </div>
      </div>
    </div>
  );
}