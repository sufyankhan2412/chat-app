import React, { useEffect, useState } from "react";
import { getContacts } from "../api";
import { useSocket } from "../context/Socketcontext";
import { useAuth } from "../context/Authcontext";
import { useProfileModal } from "../context/Profilemodalcontext";
import { resolveAvatarUrl } from "../utils/avatar";
import SearchUsers from "../SearchUsers";

// Formats the last-message timestamp the way WhatsApp does in the chat list:
// time for today, "Yesterday" for yesterday, short date otherwise.
function formatPreviewTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

// Attachment messages often have no caption, so the sidebar preview needs a
// WhatsApp-style fallback label ("📷 Photo") instead of showing a blank line.
function previewText(lastMessage) {
  if (!lastMessage) return null;
  if (lastMessage.content) return lastMessage.content;

  switch (lastMessage.type) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "voice":
      return "🎤 Voice message";
    case "file":
      return "📎 Document";
    default:
      return "";
  }
}

// Small tick icon for the sidebar preview line (only shown for messages I sent)
function PreviewTicks({ status }) {
  if (status === "sent") return <span className="preview-tick tick-grey">✓</span>;
  if (status === "delivered") return <span className="preview-tick tick-grey">✓✓</span>;
  if (status === "read") return <span className="preview-tick tick-blue">✓✓</span>;
  return null;
}

export default function Sidebar({ activeContact, onSelectContact }) {
  const [contacts, setContacts] = useState([]);
  const socket = useSocket();
  const { user, logout } = useAuth();
  const { openOwnProfile } = useProfileModal();

useEffect(() => {
  if (!user) return;

  const fetchContacts = async () => {
    try {
      const res = await getContacts();
      setContacts(res.data.contacts);
    } catch (err) {
      console.error("Failed to fetch contacts:", err);
    }
  };

  fetchContacts();
}, [user]);

  // Keep online/offline status live via socket events
  useEffect(() => {
    if (!socket) return;

    const handleOnline = ({ userId }) => {
      setContacts((prev) =>
        prev.map((c) => (String(c._id) === String(userId) ? { ...c, isOnline: true } : c))
      );
    };

    const handleOffline = ({ userId, lastSeen }) => {
      setContacts((prev) =>
        prev.map((c) =>
          String(c._id) === String(userId) ? { ...c, isOnline: false, lastSeen } : c
        )
      );
    };

    socket.on("userOnline", handleOnline);
    socket.on("userOffline", handleOffline);

    return () => {
      socket.off("userOnline", handleOnline);
      socket.off("userOffline", handleOffline);
    };
  }, [socket]);

  // Keep each contact's blocked state live — fired back to me (all my open
  // tabs) whenever I block/unblock someone, from any screen.
  useEffect(() => {
    if (!socket) return;

    const handleBlocked = ({ userId }) => {
      setContacts((prev) =>
        prev.map((c) => (String(c._id) === String(userId) ? { ...c, isBlocked: true } : c))
      );
    };
    const handleUnblocked = ({ userId }) => {
      setContacts((prev) =>
        prev.map((c) => (String(c._id) === String(userId) ? { ...c, isBlocked: false } : c))
      );
    };

    socket.on("contactBlocked", handleBlocked);
    socket.on("contactUnblocked", handleUnblocked);

    return () => {
      socket.off("contactBlocked", handleBlocked);
      socket.off("contactUnblocked", handleUnblocked);
    };
  }, [socket]);

  // Replace a contact's last-message preview and bump that contact to the
  // top of the list, the same way WhatsApp bubbles the active chat up.
  const upsertLastMessage = (contactId, lastMessage) => {
    setContacts((prev) => {
      const idx = prev.findIndex((c) => String(c._id) === String(contactId));
      if (idx === -1) return prev; // message from/to someone not yet in the list
      const updated = { ...prev[idx], lastMessage };
      const rest = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      return [updated, ...rest];
    });
  };

  // Keep each contact's last-message preview + tick status live
  useEffect(() => {
    if (!socket || !user) return;

    const toPreview = (message) => ({
      _id: message._id,
      content: message.content,
      status: message.status,
      sender: message.sender,
      createdAt: message.createdAt,
    });

    // A message arrived from a contact
    const handleReceiveMessage = (message) => {
      upsertLastMessage(message.sender, toPreview(message));
    };

    // Echo of a message I just sent
    const handleMessageSent = (message) => {
      upsertLastMessage(message.receiver, toPreview(message));
    };

    // My message(s) flipped from "sent" to "delivered" (contact came online)
    const handleMessagesDelivered = ({ messageIds }) => {
      setContacts((prev) =>
        prev.map((c) =>
          c.lastMessage && messageIds.includes(String(c.lastMessage._id))
            ? { ...c, lastMessage: { ...c.lastMessage, status: "delivered" } }
            : c
        )
      );
    };

    // A contact opened the chat and read my message(s) -> ticks turn blue
    const handleMessagesRead = ({ by }) => {
      setContacts((prev) =>
        prev.map((c) =>
          String(c._id) === String(by) &&
          c.lastMessage &&
          String(c.lastMessage.sender) === String(user._id)
            ? { ...c, lastMessage: { ...c.lastMessage, status: "read" } }
            : c
        )
      );
    };

    socket.on("receiveMessage", handleReceiveMessage);
    socket.on("messageSent", handleMessageSent);
    socket.on("messagesDelivered", handleMessagesDelivered);
    socket.on("messagesRead", handleMessagesRead);

    return () => {
      socket.off("receiveMessage", handleReceiveMessage);
      socket.off("messageSent", handleMessageSent);
      socket.off("messagesDelivered", handleMessagesDelivered);
      socket.off("messagesRead", handleMessagesRead);
    };
  }, [socket, user]);

  const handleContactAdded = (contact) => {
    setContacts((prev) => {
      if (prev.find((c) => String(c._id) === String(contact._id))) return prev;
      return [{ ...contact, lastMessage: null }, ...prev];
    });
    onSelectContact(contact);
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="me" onClick={() => openOwnProfile(user)} title="View profile">
          <img src={resolveAvatarUrl(user?.avatar)} alt="me" className="avatar-sm" />
          <span>{user?.username}</span>
        </div>
        <button className="logout-btn" onClick={logout} title="Logout">
          <svg
            viewBox="0 0 24 24"
            width="19"
            height="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>

      <SearchUsers onContactAdded={handleContactAdded} />

      <div className="contact-list">
        {contacts.length === 0 && (
          <div className="empty-state">
            Search for a username above to start a chat
          </div>
        )}
        {contacts.map((c) => {
          const lastMsg = c.lastMessage;
          const isOwnLastMsg = lastMsg && String(lastMsg.sender) === String(user._id);
          const isUnread = lastMsg && !isOwnLastMsg && lastMsg.status !== "read";

          return (
            <div
              key={c._id}
              className={`contact-item ${
                activeContact?._id === c._id ? "active" : ""
              }`}
              onClick={() => onSelectContact(c)}
            >
              <div
                className="avatar-wrapper"
              >
                <img src={resolveAvatarUrl(c.avatar)} alt={c.username} className="avatar-md" />
                <span
                  className={`status-dot ${c.isOnline ? "online" : "offline"}`}
                />
              </div>
              <div className="contact-info">
                <div className="contact-top-row">
                  <span className={`contact-name ${isUnread ? "unread" : ""}`}>
                    {c.username}
                  </span>
                  {lastMsg && (
                    <span className={`contact-time ${isUnread ? "unread" : ""}`}>
                      {formatPreviewTime(lastMsg.createdAt)}
                    </span>
                  )}
                </div>
                <div className="contact-bottom-row">
                  <span className={`contact-last-message ${isUnread ? "unread" : ""}`}>
                    {c.isBlocked ? (
                      <span className="contact-last-message-text contact-blocked-label">
                        Blocked
                      </span>
                    ) : (
                      <>
                        {isOwnLastMsg && <PreviewTicks status={lastMsg.status} />}
                        <span className="contact-last-message-text">
                          {lastMsg ? previewText(lastMsg) : "Say hi 👋"}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}