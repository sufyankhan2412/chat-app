import React, { useEffect, useState } from "react";
import { getStarredMessages, unstarMessage } from "../api";

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function summarize(message) {
  if (message.type === "text") return message.content;
  if (message.type === "image") return "📷 Photo" + (message.content ? ` · ${message.content}` : "");
  if (message.type === "video") return "🎥 Video" + (message.content ? ` · ${message.content}` : "");
  if (message.type === "voice") return "🎤 Voice message";
  if (message.type === "file") return `📄 ${message.attachment?.fileName || "Document"}`;
  return "";
}

// Messages I've starred, scoped to this one chat — matches what tapping
// "Starred messages" inside a contact's info shows in WhatsApp.
export default function StarredMessages({ userId, myId }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isCurrent = true;
    const fetchStarred = async () => {
      try {
        const res = await getStarredMessages(userId);
        if (isCurrent) setMessages(res.data.messages);
      } catch (err) {
        console.error("Failed to fetch starred messages:", err);
      } finally {
        if (isCurrent) setLoading(false);
      }
    };
    fetchStarred();
    return () => {
      isCurrent = false;
    };
  }, [userId]);

  const handleUnstar = async (id) => {
    setMessages((prev) => prev.filter((m) => m._id !== id));
    try {
      await unstarMessage(id);
    } catch (err) {
      console.error("Failed to unstar:", err);
    }
  };

  if (loading) {
    return (
      <div className="messages-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        Tap and hold on any message to star it, and it'll show up here
      </div>
    );
  }

  return (
    <div className="starred-messages-body">
      {messages.map((m) => (
        <div key={m._id} className="starred-message-row">
          <div className="starred-message-content">
            <span className="starred-message-sender">
              {String(m.sender) === String(myId) ? "You" : "Them"}
            </span>
            <p>{summarize(m)}</p>
            <span className="starred-message-time">{formatTime(m.createdAt)}</span>
          </div>
          <button
            type="button"
            className="starred-message-unstar"
            onClick={() => handleUnstar(m._id)}
            title="Unstar"
          >
            ★
          </button>
        </div>
      ))}
    </div>
  );
}