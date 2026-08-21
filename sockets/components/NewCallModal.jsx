import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGroupCall } from "../context/Groupcallcontext";

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export default function NewCallModal({ onClose }) {
  const navigate = useNavigate();
  const { generateCallLink } = useGroupCall();

  const [callType, setCallType] = useState(null); // null | "audio" | "video"
  const [link, setLink] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const handleCreate = async (type) => {
    setCreating(true);
    setError("");
    try {
      const data = await generateCallLink(type);
      setCallType(type);
      setLink(data.link);
    } catch (err) {
      setError(err.response?.data?.message || "Couldn't create the call link.");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — link text is still visible to copy manually
    }
  };

  const handleStartNow = () => {
    const roomId = link.split("/").pop();
    onClose?.();
    navigate(`/call/${roomId}`);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="new-call-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New call</h3>

        {!link ? (
          <>
            <p className="new-call-subtitle">
              Generate a link. Anyone who opens it can join with audio or video —
              no group is created, it's just this one call.
            </p>
            <div className="new-call-options">
              <button type="button" className="new-call-option" disabled={creating} onClick={() => handleCreate("audio")}>
                <PhoneIcon />
                <span>Audio call link</span>
              </button>
              <button type="button" className="new-call-option" disabled={creating} onClick={() => handleCreate("video")}>
                <VideoIcon />
                <span>Video call link</span>
              </button>
            </div>
            {error && <p className="new-call-error">{error}</p>}
          </>
        ) : (
          <>
            <p className="new-call-subtitle">
              Your {callType} call link is ready. Share it with anyone you want to join.
            </p>
            <div className="new-call-link-row">
              <input type="text" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button type="button" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <button type="button" className="new-call-start-btn" onClick={handleStartNow}>
              Start call now
            </button>
          </>
        )}

        <button type="button" className="new-call-cancel-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}