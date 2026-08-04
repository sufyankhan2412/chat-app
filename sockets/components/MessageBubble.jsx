import React from "react";

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

export default function MessageBubble({ message, isOwn }) {
  return (
    <div className={`message-row ${isOwn ? "own" : "other"}`}>
      <div className={`message-bubble ${isOwn ? "own-bubble" : "other-bubble"}`}>
        <span className="message-content">{message.content}</span>
        <span className="message-meta">
          <span className="message-time">{formatTime(message.createdAt)}</span>
          {isOwn && <Ticks status={message.status} />}
        </span>
      </div>
    </div>
  );
}