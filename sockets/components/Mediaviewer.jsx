import React, { useEffect } from "react";

// Renders on top of the chat (not a new tab/window) when a photo or video
// bubble is clicked. Closing it just hides this overlay — you're still on
// the exact same page/tab you were on, so "going back" is instant and
// doesn't lose scroll position or socket state the way a new tab would.
export default function MediaViewer({ media, onClose }) {
  useEffect(() => {
    if (!media) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    // Prevent the chat behind the overlay from scrolling while it's open
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [media, onClose]);

  if (!media) return null;

  return (
    <div className="media-viewer-overlay" onClick={onClose}>
      <button type="button" className="media-viewer-back" onClick={onClose}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back to chat
      </button>

      <div className="media-viewer-content" onClick={(e) => e.stopPropagation()}>
        {media.type === "image" ? (
          <img src={media.url} alt={media.fileName || "photo"} className="media-viewer-image" />
        ) : (
          <video src={media.url} controls autoPlay className="media-viewer-video" />
        )}
      </div>
    </div>
  );
}