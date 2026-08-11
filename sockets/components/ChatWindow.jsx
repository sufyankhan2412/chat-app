import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getMessages, uploadAttachment, unblockUser } from "../api";
import { useSocket } from "../context/Socketcontext";
import { useAuth } from "../context/Authcontext";
import { useProfileModal } from "../context/Profilemodalcontext";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatFileSize, formatDuration } from "../utils/formatFileSize";
import MessageBubble from "./MessageBubble";
import MediaViewer from "./MediaViewer";
import { formatLastSeen } from "../utils/formatLastSeen";
import {
  getMessageDateLabel,
  isSameDay,
} from "../utils/messageDate";

const TYPING_STOP_DELAY = 1500;
const SCROLLBAR_HIDE_DELAY = 1000; // how long the scrollbar stays visible after you stop scrolling
const PAGE_SIZE = 30; // how many messages to fetch per page (initial load + each "load older" step)
const LOAD_OLDER_THRESHOLD = 80; // px from the top that triggers fetching older messages

// Picking "Photo/Video" vs "Document" in the attachment menu just changes
// which `accept` the hidden file input uses, and whether the resulting
// message type is "image"/"video" (auto-detected from the file) or "file".
const MEDIA_ACCEPT = "image/*,video/*";

function detectAttachmentType(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

export default function ChatWindow({ contact, onBack }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const [contactStatus, setContactStatus] = useState({
    isOnline: contact?.isOnline,
    lastSeen: contact?.lastSeen,
  });
  const [isBlocked, setIsBlocked] = useState(Boolean(contact?.isBlocked));
  const [sendError, setSendError] = useState("");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [showScrollbar, setShowScrollbar] = useState(false);

  // ---- Attachment picker + preview-before-send state ----
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // { file, type, previewUrl }
  const [isUploading, setIsUploading] = useState(false);

  // ---- Voice recording state ----
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  // { type: "image" | "video", url, fileName } of whatever's currently open
  // in the fullscreen viewer, or null when it's closed.
  const [viewerMedia, setViewerMedia] = useState(null);

  const socket = useSocket();
  const { user } = useAuth();
  const { openUserProfile } = useProfileModal();
  const messagesContainerRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);
  const messageCacheRef = useRef(new Map());
  const isPrependingOlderRef = useRef(false);
  const pendingScrollRestoreRef = useRef(null); // { prevScrollHeight, prevScrollTop } while an older-page prepend is in flight
  const isPinnedToBottomRef = useRef(true); // whether the view is currently sitting at the bottom of the chat
  const scrollbarHideTimeoutRef = useRef(null);
  const mediaInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachMenuRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingIntervalRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const discardRecordingRef = useRef(false);
  const recordingStartRef = useRef(null);
  const isStartingRecordingRef = useRef(false); // guards against a double-click starting two recordings

  useEffect(() => {
    if (!contact) return;

    const contactId = String(contact._id);
    setIsOtherTyping(false);
    setContactStatus({ isOnline: contact.isOnline, lastSeen: contact.lastSeen });
    setIsBlocked(Boolean(contact.isBlocked));
    setSendError("");

    const cached = messageCacheRef.current.get(contactId);
    setMessages(cached?.messages || []);
    setHasMoreOlder(cached?.hasMore ?? false);
    setLoadingMessages(!cached);

    // Never show the scrollbar just because we switched chats
    setShowScrollbar(false);
    if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);

    if (cached) return; // already have the latest page for this contact

    let isCurrent = true;
    const fetchHistory = async () => {
      try {
        const res = await getMessages(contact._id, { limit: PAGE_SIZE });
        if (!isCurrent) return;
        messageCacheRef.current.set(contactId, {
          messages: res.data.messages,
          hasMore: res.data.hasMore,
        });
        setMessages(res.data.messages);
        setHasMoreOlder(res.data.hasMore);
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

  // Fetch an older page when the user scrolls near the top, preserving
  // their exact visual scroll position (otherwise prepending messages
  // above the viewport would yank the view down/up as content shifts).
  const loadOlderMessages = async () => {
    if (!contact || loadingOlder || !hasMoreOlder || messages.length === 0) return;

    const el = messagesContainerRef.current;
    const prevScrollHeight = el ? el.scrollHeight : 0;
    const prevScrollTop = el ? el.scrollTop : 0;

    setLoadingOlder(true);
    try {
      const oldestCreatedAt = messages[0].createdAt;
      const res = await getMessages(contact._id, {
        limit: PAGE_SIZE,
        before: oldestCreatedAt,
      });

      const contactId = String(contact._id);
      isPrependingOlderRef.current = true;
      pendingScrollRestoreRef.current = { prevScrollHeight, prevScrollTop };
      setMessages((prev) => {
        const next = [...res.data.messages, ...prev];
        messageCacheRef.current.set(contactId, {
          messages: next,
          hasMore: res.data.hasMore,
        });
        return next;
      });
      setHasMoreOlder(res.data.hasMore);
    } catch (err) {
      console.error("Failed to load older messages:", err);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleMessagesScroll = () => {
    handleUserScrollActivity();
    handleScrollPositionTracking();
    const el = messagesContainerRef.current;
    if (!el) return;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD) {
      loadOlderMessages();
    }
  };


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
          const prevCached = messageCacheRef.current.get(contactId);
          messageCacheRef.current.set(contactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
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
          const prevCached = messageCacheRef.current.get(contactId);
          messageCacheRef.current.set(contactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
          return next;
        });
      }
    };

    const handleMessagesDelivered = ({ messageIds }) => {
      setMessages((prev) => {
        const next = prev.map((m) =>
          messageIds.includes(String(m._id)) ? { ...m, status: "delivered" } : m
        );
        const prevCached = messageCacheRef.current.get(contactId);
        messageCacheRef.current.set(contactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
        return next;
      });
    };

    const handleMessagesRead = ({ by }) => {
      if (String(by) === contactId) {
        setMessages((prev) => {
          const next = prev.map((m) =>
            String(m.sender) === String(user._id) ? { ...m, status: "read" } : m
          );
          const prevCached = messageCacheRef.current.get(contactId);
          messageCacheRef.current.set(contactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
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

    // Fired back at me (all my open tabs) right after I block/unblock this
    // contact, so the composer disables/re-enables without a page reload.
    const handleContactBlocked = ({ userId }) => {
      if (String(userId) === contactId) setIsBlocked(true);
    };
    const handleContactUnblocked = ({ userId }) => {
      if (String(userId) === contactId) setIsBlocked(false);
    };

    const handleErrorMessage = ({ message }) => {
      setSendError(message || "Message could not be sent");
    };

    socket.on("receiveMessage", handleReceiveMessage);
    socket.on("messageSent", handleMessageSent);
    socket.on("messagesDelivered", handleMessagesDelivered);
    socket.on("messagesRead", handleMessagesRead);
    socket.on("typing", handleTyping);
    socket.on("stopTyping", handleStopTyping);
    socket.on("userOnline", handleUserOnline);
    socket.on("userOffline", handleUserOffline);
    socket.on("contactBlocked", handleContactBlocked);
    socket.on("contactUnblocked", handleContactUnblocked);
    socket.on("errorMessage", handleErrorMessage);

    return () => {
      socket.off("receiveMessage", handleReceiveMessage);
      socket.off("messageSent", handleMessageSent);
      socket.off("messagesDelivered", handleMessagesDelivered);
      socket.off("messagesRead", handleMessagesRead);
      socket.off("typing", handleTyping);
      socket.off("stopTyping", handleStopTyping);
      socket.off("userOnline", handleUserOnline);
      socket.off("userOffline", handleUserOffline);
      socket.off("contactBlocked", handleContactBlocked);
      socket.off("contactUnblocked", handleContactUnblocked);
      socket.off("errorMessage", handleErrorMessage);
    };
  }, [socket, contact, user]);

  // Auto-dismiss the inline send-error banner after a few seconds
  useEffect(() => {
    if (!sendError) return;
    const t = setTimeout(() => setSendError(""), 4000);
    return () => clearTimeout(t);
  }, [sendError]);

  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (isPrependingOlderRef.current) {
      isPrependingOlderRef.current = false;
      const pending = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      if (el && pending) {
        el.scrollTop = el.scrollHeight - pending.prevScrollHeight + pending.prevScrollTop;
      }
      return;
    }
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // We just forced the view to the bottom, so mark it "pinned" — any
    // image/video that loads after this point and grows the container
    // should keep it snapped to the bottom too (see handleMediaLoad).
    isPinnedToBottomRef.current = true;
  }, [contact, messages, isOtherTyping]);

  // Whether the user is currently sitting at (or very near) the bottom of
  // the conversation. Updated on every scroll so we know, at any later
  // point, whether a late-loading image should pull the view back down.
  const handleScrollPositionTracking = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isPinnedToBottomRef.current = distanceFromBottom < 40;
  };

  // Images/videos finish loading after the initial render, which grows the
  // container. If the trailing message IS the image, measuring "distance
  // from bottom" at this point is unreliable — that distance now includes
  // the very growth we're trying to detect. Instead we trust whether the
  // user was pinned to the bottom *before* this growth happened.
  const handleMediaLoad = () => {
    const el = messagesContainerRef.current;
    if (!el || !isPinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    return () => {
      if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (recordingStreamRef.current) {
        recordingStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (pendingFile?.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the attachment menu when clicking anywhere outside it
  useEffect(() => {
    if (!isAttachMenuOpen) return;
    const handleClickOutside = (e) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target)) {
        setIsAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isAttachMenuOpen]);

  // Switching contacts mid-flow (new chat clicked) should drop any
  // in-progress attachment/recording rather than silently sending it later.
  useEffect(() => {
    cancelPendingFile();
    if (isRecording) cancelRecording();
    setViewerMedia(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?._id]);

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

  // ---------------------------------------------------------------------
  // Attachments (image / video / document)
  // ---------------------------------------------------------------------

  const handleAttachOptionClick = (inputRef) => {
    setIsAttachMenuOpen(false);
    inputRef.current?.click();
  };

  const handleFilePicked = (e, forcedType) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the exact same file again later
    if (!file) return;

    const type = forcedType || detectAttachmentType(file);
    const previewUrl = type === "image" || type === "video" ? URL.createObjectURL(file) : null;

    setPendingFile((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return { file, type, previewUrl };
    });
  };

  const cancelPendingFile = () => {
    setPendingFile((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setInput("");
  };

  // Shared by both attachment sends and voice-note sends: upload the file
  // via REST, then hand the returned attachment metadata to the same
  // "sendMessage" socket event text messages use, so delivery/receipts
  // logic doesn't need a second code path.
  const uploadAndSend = async (file, type, extra = {}) => {
    if (!contact || !socket) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      // "type" MUST be appended before "file" — see the comment on the
      // backend upload route for why the field order matters.
      formData.append("type", type);
      if (extra.duration) formData.append("duration", extra.duration);
      formData.append("file", file);

      const res = await uploadAttachment(formData);

      socket.emit("sendMessage", {
        receiverId: contact._id,
        type,
        content: extra.caption?.trim() || "",
        attachment: res.data.attachment,
      });
    } catch (err) {
      console.error("Attachment upload failed:", err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSendAttachment = async () => {
    if (!pendingFile) return;
    const { file, type, previewUrl } = pendingFile;
    const caption = input;

    setPendingFile(null);
    setInput("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    await uploadAndSend(file, type, { caption });
  };

  // ---------------------------------------------------------------------
  // Voice messages (MediaRecorder API — see README for why)
  // ---------------------------------------------------------------------

  const startRecording = async () => {
    // Without this guard, clicking the mic twice quickly (before the button
    // swaps to the recording bar, since getUserMedia is async) starts a
    // second MediaRecorder + interval on top of the first. The second one
    // overwrites recordingIntervalRef, so the first interval's ID is lost
    // and it can never be cleared — it just keeps ticking in the background
    // forever, stacking with each further stray click.
    if (isRecording || isStartingRecordingRef.current) return;
    isStartingRecordingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      discardRecordingRef.current = false;

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recordingStreamRef.current = null;

        if (discardRecordingRef.current || audioChunksRef.current.length === 0) {
          audioChunksRef.current = [];
          return;
        }

        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const voiceFile = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
        const finalDuration = Math.round((Date.now() - recordingStartRef.current) / 1000);
        audioChunksRef.current = [];

        await uploadAndSend(voiceFile, "voice", { duration: finalDuration });
      };

      recorder.start();
      recordingStartRef.current = Date.now();
      setIsRecording(true);
      setRecordingSeconds(0);

      // Read the elapsed time from the clock rather than incrementing a
      // counter each tick. That way, even if a stray extra interval is ever
      // running, both just compute and set the same correct value — no
      // possibility of double-counting.
      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds(Math.floor((Date.now() - recordingStartRef.current) / 1000));
      }, 250);
    } catch (err) {
      console.error("Microphone access denied or unavailable:", err);
    } finally {
      isStartingRecordingRef.current = false;
    }
  };

  const stopRecordingAndSend = () => {
    discardRecordingRef.current = false;
    mediaRecorderRef.current?.stop();
    clearInterval(recordingIntervalRef.current);
    setIsRecording(false);
  };

  const cancelRecording = () => {
    discardRecordingRef.current = true;
    mediaRecorderRef.current?.stop();
    clearInterval(recordingIntervalRef.current);
    setIsRecording(false);
    setRecordingSeconds(0);
  };

  const handleSend = (e) => {
    e.preventDefault();
    if (isBlocked) return;
    if (pendingFile) return handleSendAttachment();
    if (!input.trim() || !socket || !contact) return;

    socket.emit("sendMessage", {
      receiverId: contact._id,
      type: "text",
      content: input.trim(),
    });
    setInput("");

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    isTypingRef.current = false;
    socket.emit("stopTyping", { receiverId: contact._id });
  };

  const handleUnblockFromChat = async () => {
    if (!contact) return;
    try {
      await unblockUser(contact._id);
      setIsBlocked(false);
    } catch (err) {
      console.error("Failed to unblock:", err);
    }
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
      <div
        className="chat-header"
        onClick={() => openUserProfile(contact)}
        title="View contact info"
      >
        <button
          className="chat-back-btn"
          onClick={(e) => {
            e.stopPropagation();
            onBack?.();
          }}
          title="Back to chats"
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <img src={resolveAvatarUrl(contact.avatar)} alt={contact.username} className="avatar-md" />
        <div className="chat-header-info">
          <span className="chat-header-name">{contact.username}</span>
          <span className="chat-header-status">
           {isOtherTyping
  ? "typing..."
  : contactStatus.isOnline
  ? "Online"
  : formatLastSeen(contactStatus.lastSeen)}
          </span>
        </div>
      </div>

      <div
        className={`messages-container${showScrollbar ? " scrollbar-visible" : ""}`}
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
        onWheel={handleUserScrollActivity}
        onTouchMove={handleUserScrollActivity}
        onMouseDown={handleUserScrollActivity}
      >
        {loadingMessages && (
          <div className="messages-loading">
            <div className="spinner" />
          </div>
        )}
        {!loadingMessages && loadingOlder && (
          <div className="messages-loading-older">
            <div className="spinner spinner-sm" />
          </div>
        )}
       {messages.map((m, index) => {
         const previousMessage = messages[index - 1];

           const showDateSeparator =
              index === 0 ||
        !isSameDay(m.createdAt, previousMessage?.createdAt);

      return (
        <React.Fragment key={m._id}>
          {showDateSeparator && (
            <div className="message-date-separator">
          <span>{getMessageDateLabel(m.createdAt)}</span>
        </div>
      )}

      <MessageBubble
        message={m}
        isOwn={String(m.sender) === String(user._id)}
        onOpenMedia={setViewerMedia}
        onMediaLoad={handleMediaLoad}
      />
    </React.Fragment>
  );
})}
        {isOtherTyping && (
          <div className="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
      </div>

      {pendingFile && (
        <div className="attachment-preview-bar">
          <button type="button" className="attachment-preview-cancel" onClick={cancelPendingFile} title="Remove">
            ✕
          </button>
          {pendingFile.type === "image" && (
            <img src={pendingFile.previewUrl} alt="" className="attachment-preview-thumb" />
          )}
          {pendingFile.type === "video" && (
            <video src={pendingFile.previewUrl} className="attachment-preview-thumb" muted />
          )}
          {pendingFile.type === "file" && (
            <div className="attachment-preview-file">
              <span className="attachment-preview-file-icon">📎</span>
              <span className="attachment-preview-file-name">{pendingFile.file.name}</span>
              <span className="attachment-preview-file-size">
                {formatFileSize(pendingFile.file.size)}
              </span>
            </div>
          )}
        </div>
      )}

      {sendError && !isBlocked && (
        <div className="send-error-banner">{sendError}</div>
      )}

      {isBlocked ? (
        <div className="blocked-banner">
          <span>You blocked {contact.username}. Unblock to send messages.</span>
          <button type="button" className="profile-btn-secondary" onClick={handleUnblockFromChat}>
            Unblock
          </button>
        </div>
      ) : (
        <>
      {/* Hidden pickers, opened via the attachment menu below */}
      <input
        ref={mediaInputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        style={{ display: "none" }}
        onChange={(e) => handleFilePicked(e)}
      />
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => handleFilePicked(e, "file")}
      />

      <form className="message-input-bar" onSubmit={handleSend}>
        <div className="attach-menu-wrapper" ref={attachMenuRef}>
          <button
            type="button"
            className="icon-btn attach-btn"
            onClick={() => setIsAttachMenuOpen((v) => !v)}
            title="Attach"
            disabled={isRecording}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {isAttachMenuOpen && (
            <div className="attach-menu">
              <button type="button" onClick={() => handleAttachOptionClick(mediaInputRef)}>
                <span className="attach-menu-icon photo">🖼️</span> Photos &amp; Videos
              </button>
              <button type="button" onClick={() => handleAttachOptionClick(fileInputRef)}>
                <span className="attach-menu-icon doc">📄</span> Document
              </button>
            </div>
          )}
        </div>

        {isRecording ? (
          <div className="recording-bar">
            <button type="button" className="icon-btn recording-cancel" onClick={cancelRecording} title="Cancel">
              🗑️
            </button>
            <span className="recording-dot" />
            <span className="recording-timer">{formatDuration(recordingSeconds)}</span>
            <span className="recording-hint">Recording voice message…</span>
          </div>
        ) : (
          <input
            type="text"
            placeholder={pendingFile ? "Add a caption..." : "Type a message..."}
            value={input}
            onChange={handleInputChange}
            disabled={isUploading}
          />
        )}

        {isRecording ? (
          <button type="button" className="icon-btn send-btn" onClick={stopRecordingAndSend} title="Send voice message">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
          </button>
        ) : input.trim() || pendingFile ? (
          <button type="submit" className="icon-btn send-btn" disabled={isUploading} title="Send">
            {isUploading ? (
              <span className="spinner spinner-sm" />
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
            )}
          </button>
        ) : (
          <button type="button" className="icon-btn mic-btn" onClick={startRecording} disabled={isUploading} title="Record voice message">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path d="M19 10v2a7 7 0 01-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
        )}
      </form>
        </>
      )}

      <MediaViewer media={viewerMedia} onClose={() => setViewerMedia(null)} />
    </div>
  );
}