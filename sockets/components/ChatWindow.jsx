import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getMessages } from "../api";
import { useSocket } from "../context/Socketcontext";
import { useAuth } from "../context/Authcontext";
import MessageBubble from "./MessageBubble";

const TYPING_STOP_DELAY = 1500;
const SCROLLBAR_HIDE_DELAY = 1000; // how long the scrollbar stays visible after you stop scrolling

export default function ChatWindow({ contact }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const [contactStatus, setContactStatus] = useState({
    isOnline: contact?.isOnline,
    lastSeen: contact?.lastSeen,
  });
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showScrollbar, setShowScrollbar] = useState(false);

  const socket = useSocket();
  const { user } = useAuth();
  const messagesContainerRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);
  const messageCacheRef = useRef(new Map());
  const scrollbarHideTimeoutRef = useRef(null);

  useEffect(() => {
    if (!contact) return;

    const contactId = String(contact._id);
    setIsOtherTyping(false);
    setContactStatus({ isOnline: contact.isOnline, lastSeen: contact.lastSeen });

    const cachedMessages = messageCacheRef.current.get(contactId) || [];
    setMessages(cachedMessages);
    setLoadingMessages(cachedMessages.length === 0);

    // Never show the scrollbar just because we switched chats
    setShowScrollbar(false);
    if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);

    let isCurrent = true;
    const fetchHistory = async () => {
      try {
        const res = await getMessages(contact._id);
        if (!isCurrent) return;
        messageCacheRef.current.set(contactId, res.data.messages);
        setMessages(res.data.messages);
      } catch (err) {
        if (isCurrent) console.error(err);
      } finally {
        if (isCurrent) setLoadingMessages(false);
      }
    };

    fetchHistory();

    return () => {
      isCurrent = false;
    };
  }, [contact]);

  useEffect(() => {
    if (!socket || !contact || !user) return;

    const roomName = [String(user._id), String(contact._id)].sort().join("_");
    socket.emit("joinChat", { roomName });

    return () => {
      socket.emit("leaveChat", { roomName });
    };
  }, [socket, contact, user]);

  useEffect(() => {
    if (!socket || !contact) return;

    const hasUnread = messages.some(
      (m) => String(m.sender) === String(contact._id) && m.status !== "read"
    );

    if (hasUnread) {
      socket.emit("markAsRead", { senderId: contact._id });
      setMessages((prev) =>
        prev.map((m) =>
          String(m.sender) === String(contact._id) ? { ...m, status: "read" } : m
        )
      );
    }
  }, [messages.length, contact, socket]);

  useEffect(() => {
    if (!socket || !contact || !user) return;

    const contactId = String(contact._id);

    const handleReceiveMessage = (message) => {
      if (
        String(message.sender) === contactId &&
        String(message.receiver) === String(user._id)
      ) {
        setMessages((prev) => {
          const next = [...prev, message];
          messageCacheRef.current.set(contactId, next);
          return next;
        });
        socket.emit("markAsRead", { senderId: message.sender });
      }
    };

    const handleMessageSent = (message) => {
      if (
        String(message.sender) === String(user._id) &&
        String(message.receiver) === contactId
      ) {
        setMessages((prev) => {
          const next = [...prev, message];
          messageCacheRef.current.set(contactId, next);
          return next;
        });
      }
    };

    const handleMessagesDelivered = ({ messageIds }) => {
      setMessages((prev) => {
        const next = prev.map((m) =>
          messageIds.includes(String(m._id)) ? { ...m, status: "delivered" } : m
        );
        messageCacheRef.current.set(contactId, next);
        return next;
      });
    };

    const handleMessagesRead = ({ by }) => {
      if (String(by) === contactId) {
        setMessages((prev) => {
          const next = prev.map((m) =>
            String(m.sender) === String(user._id) ? { ...m, status: "read" } : m
          );
          messageCacheRef.current.set(contactId, next);
          return next;
        });
      }
    };

    const handleTyping = ({ from }) => {
      if (String(from) === contactId) setIsOtherTyping(true);
    };

    const handleStopTyping = ({ from }) => {
      if (String(from) === contactId) setIsOtherTyping(false);
    };

    const handleUserOnline = ({ userId }) => {
      if (String(userId) === contactId) {
        setContactStatus((s) => ({ ...s, isOnline: true }));
      }
    };

    const handleUserOffline = ({ userId, lastSeen }) => {
      if (String(userId) === contactId) {
        setContactStatus({ isOnline: false, lastSeen });
      }
    };

    socket.on("receiveMessage", handleReceiveMessage);
    socket.on("messageSent", handleMessageSent);
    socket.on("messagesDelivered", handleMessagesDelivered);
    socket.on("messagesRead", handleMessagesRead);
    socket.on("typing", handleTyping);
    socket.on("stopTyping", handleStopTyping);
    socket.on("userOnline", handleUserOnline);
    socket.on("userOffline", handleUserOffline);

    return () => {
      socket.off("receiveMessage", handleReceiveMessage);
      socket.off("messageSent", handleMessageSent);
      socket.off("messagesDelivered", handleMessagesDelivered);
      socket.off("messagesRead", handleMessagesRead);
      socket.off("typing", handleTyping);
      socket.off("stopTyping", handleStopTyping);
      socket.off("userOnline", handleUserOnline);
      socket.off("userOffline", handleUserOffline);
    };
  }, [socket, contact, user]);

  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [contact, messages, isOtherTyping]);

  useEffect(() => {
    return () => {
      if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, []);

  const handleUserScrollActivity = () => {
    setShowScrollbar(true);

    if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);
    scrollbarHideTimeoutRef.current = setTimeout(() => {
      setShowScrollbar(false);
    }, SCROLLBAR_HIDE_DELAY);
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
    if (!socket || !contact) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket.emit("typing", { receiverId: contact._id });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      socket.emit("stopTyping", { receiverId: contact._id });
    }, TYPING_STOP_DELAY);
  };

  const handleSend = (e) => {
    e.preventDefault();
    if (!input.trim() || !socket || !contact) return;

    socket.emit("sendMessage", {
      receiverId: contact._id,
      content: input.trim(),
    });
    setInput("");

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    isTypingRef.current = false;
    socket.emit("stopTyping", { receiverId: contact._id });
  };

  if (!contact) {
    return (
      <div className="chat-window empty">
        <p>Select a contact from the left to start chatting</p>
      </div>
    );
  }

  return (
    <div className="chat-window">
      <div className="chat-header">
        <img src={contact.avatar} alt={contact.username} className="avatar-md" />
        <div className="chat-header-info">
          <span className="chat-header-name">{contact.username}</span>
          <span className="chat-header-status">
            {isOtherTyping
              ? "typing..."
              : contactStatus.isOnline
              ? "Online"
              : contactStatus.lastSeen
              ? `Last seen ${new Date(contactStatus.lastSeen).toLocaleString()}`
              : "Offline"}
          </span>
        </div>
      </div>

      <div
        className={`messages-container${showScrollbar ? " scrollbar-visible" : ""}`}
        ref={messagesContainerRef}
        onWheel={handleUserScrollActivity}
        onTouchMove={handleUserScrollActivity}
        onMouseDown={handleUserScrollActivity}
      >
        {loadingMessages && (
          <div className="messages-loading">
            <div className="spinner" />
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m._id}
            message={m}
            isOwn={String(m.sender) === String(user._id)}
          />
        ))}
        {isOtherTyping && (
          <div className="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
      </div>

      <form className="message-input-bar" onSubmit={handleSend}>
        <input
          type="text"
          placeholder="Type a message..."
          value={input}
          onChange={handleInputChange}
        />
        <button type="submit" disabled={!input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}