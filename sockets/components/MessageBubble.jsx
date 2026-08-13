import React from "react";
import VoicePlayer from "./VoicePlayer";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatFileSize } from "../utils/formatFileSize";

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Ticks({ status }) {
  if (status === "sent") {
    return <span className="tick tick-grey">✓</span>;
  }
  if (status === "delivered") {
    return <span className="tick tick-grey">✓✓</span>;
  }
  if (status === "read") {
    return <span className="tick tick-blue">✓✓</span>;
  }
  return null;
}

// resolveAvatarUrl is reused here even though it was written for avatars —
// both cases boil down to "turn a relative /uploads/... path into an
// absolute URL the <img>/<video>/<a> tag can load", so the same helper works.

// WhatsApp-style file icon: a colored "page with folded corner" shape with
// the extension printed on it, instead of a generic emoji that renders
// inconsistently (and looks a bit ugly) across platforms.
const FILE_TYPE_COLORS = {
  PDF: "#e2574c",
  DOC: "#2196f3",
  DOCX: "#2196f3",
  XLS: "#21a366",
  XLSX: "#21a366",
  CSV: "#21a366",
  PPT: "#d24726",
  PPTX: "#d24726",
  ZIP: "#8696a0",
  RAR: "#8696a0",
  "7Z": "#8696a0",
  TXT: "#6c7a89",
};

function getExtension(fileName) {
  if (!fileName || !fileName.includes(".")) return "FILE";
  return fileName.split(".").pop().toUpperCase().slice(0, 4);
}

function FileTypeIcon({ fileName }) {
  const ext = getExtension(fileName);
  const color = FILE_TYPE_COLORS[ext] || "#8696a0";

  return (
    <svg viewBox="0 0 40 40" width="40" height="40" className="message-file-icon-svg">
      <path
        d="M9 2h15l7 7v27a2 2 0 01-2 2H9a2 2 0 01-2-2V4a2 2 0 012-2z"
        fill={color}
      />
      <path d="M24 2v7h7" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" strokeLinejoin="round" />
      <text x="20" y="27" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial, sans-serif">
        {ext.length > 4 ? ext.slice(0, 4) : ext}
      </text>
    </svg>
  );
}

function AttachmentContent({ message, onOpenMedia, onMediaLoad }) {
  const { type, attachment, content } = message;
  const url = resolveAvatarUrl(attachment?.url);

  if (type === "image") {
    return (
      <>
        <div
          className="message-image-link"
          onClick={() => onOpenMedia({ type: "image", url, fileName: attachment.fileName })}
        >
          <img
            src={url}
            alt={attachment.fileName || "photo"}
            className="message-image"
            onLoad={onMediaLoad}
          />
        </div>
        {content && <span className="message-content message-caption">{content}</span>}
      </>
    );
  }

  if (type === "video") {
    // No native `controls` here on purpose — a click anywhere on the bubble
    // (including on the built-in play/pause/seek bar) would otherwise fight
    // with opening the viewer. Instead this is a static, clickable poster
    // with its own play icon; actual playback happens in MediaViewer.
    return (
      <>
        <div
          className="message-video-wrapper"
          onClick={() => onOpenMedia({ type: "video", url, fileName: attachment.fileName })}
        >
          <video src={url} className="message-video" preload="metadata" muted onLoadedMetadata={onMediaLoad} />
          <span className="message-video-play">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </div>
        {content && <span className="message-content message-caption">{content}</span>}
      </>
    );
  }

  if (type === "voice") {
    return <VoicePlayer src={url} duration={attachment.duration} />;
  }

  if (type === "file") {
    return (
      <a href={url} download={attachment.fileName} className="message-file">
        <span className="message-file-icon">
          <FileTypeIcon fileName={attachment.fileName} />
        </span>
        <span className="message-file-info">
          <span className="message-file-name">{attachment.fileName}</span>
          <span className="message-file-size">
            {getExtension(attachment.fileName)} · {formatFileSize(attachment.fileSize)}
          </span>
        </span>
        <span className="message-file-download">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="5" y1="20" x2="19" y2="20" />
          </svg>
        </span>
      </a>
    );
  }

  return <span className="message-content">{content}</span>;
}

// Small, self-contained "Undo" pill shown inline inside a bubble that's
// sitting in its post-delete grace window. Deliberately compact (a chip,
// not a banner) so it reads as part of the bubble rather than an alert.
// The filled backdrop behind the label drains from 100% -> 0% over the
// grace window, doubling as a quiet countdown without needing a number.
function InlineUndoButton({ undoInfo, onUndo }) {
  const progress =
    undoInfo && undoInfo.totalSeconds
      ? Math.max(0, Math.min(1, undoInfo.secondsLeft / undoInfo.totalSeconds))
      : 0;

  return (
    <button
      type="button"
      className="message-undo-inline-btn"
      onClick={onUndo}
      title="Undo delete"
    >
      <span
        className="message-undo-inline-btn-progress"
        style={{ width: `${progress * 100}%` }}
        aria-hidden="true"
      />
      <span className="message-undo-inline-btn-label">Undo</span>
    </button>
  );
}

export default function MessageBubble({
  message,
  isOwn,
  isStarred,
  onOpenMedia,
  onMediaLoad,
  onToggleStar,
  onDoubleClick,
  undoInfo, // { secondsLeft, totalSeconds } while this message can still be undone, else null/undefined
  onUndoDelete,
}) {
  const isDeleted = Boolean(message.deletedForEveryone);
  // Only the sender sees this state (the server only tells the sender's own
  // tabs about a pending delete), so undoInfo being present is what actually
  // gates the button — pendingDeleteForEveryone alone just greys the bubble.
  const isPendingUndo = !isDeleted && Boolean(message.pendingDeleteForEveryone);
  const isMedia = !isDeleted && !isPendingUndo && message.type && message.type !== "text";

  return (
    <div className={`message-row ${isOwn ? "own" : "other"}`}>
      <div
        className={`message-bubble ${isOwn ? "own-bubble" : "other-bubble"} ${
          isMedia ? `bubble-${message.type}` : ""
        } ${isDeleted ? "bubble-deleted" : ""} ${isPendingUndo ? "bubble-pending-undo" : ""}`}
        onDoubleClick={onDoubleClick && !isPendingUndo ? () => onDoubleClick(message) : undefined}
      >
        {!isDeleted && !isPendingUndo && onToggleStar && (
          <button
            type="button"
            className={`message-star-btn${isStarred ? " starred" : ""}`}
            onClick={() => onToggleStar(message._id, isStarred)}
            title={isStarred ? "Unstar message" : "Star message"}
          >
            ★
          </button>
        )}
        {isDeleted ? (
          <span className="message-deleted-content">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            This message was deleted
          </span>
        ) : isPendingUndo ? (
          <div className="message-undo-inline">
            <span className="message-undo-inline-text">Message deleted</span>
            {undoInfo && <InlineUndoButton undoInfo={undoInfo} onUndo={onUndoDelete} />}
          </div>
        ) : (
          <AttachmentContent message={message} onOpenMedia={onOpenMedia} onMediaLoad={onMediaLoad} />
        )}
        <span className="message-meta">
          {isStarred && !isDeleted && !isPendingUndo && <span className="message-star-badge">★</span>}
          <span className="message-time">{formatTime(message.createdAt)}</span>
          {isOwn && !isDeleted && !isPendingUndo && <Ticks status={message.status} />}
        </span>
      </div>
    </div>
  );
}