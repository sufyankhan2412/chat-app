import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getMessages, uploadAttachment, blockUser, unblockUser, clearChat, deleteMessage, undoDeleteMessage, starMessage, unstarMessage } from "../api";
import { useSocket } from "../context/Socketcontext";
import { useAuth } from "../context/Authcontext";
import { useCall } from "../context/Callcontext";
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
const FALLBACK_UNDO_WINDOW_MS = 10 * 1000; // mirrors the server's UNDO_DELETE_GRACE_MS, used only if a response is missing undoExpiresAt for some reason

// Picking "Photo/Video" vs "Document" in the attachment menu just changes
// which `accept` the hidden file input uses, and whether the resulting
// message type is "image"/"video" (auto-detected from the file) or "file".
const MEDIA_ACCEPT = "image/*,video/*";

function detectAttachmentType(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

// Sentinel used to detect "first render" in the contact-switch reset below —
// it can never equal a real contact id (string) or `null`.
const UNINITIALIZED_CONTACT_ID = Symbol("uninitialized-contact-id");

export default function ChatWindow({ contact, onBack }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const [contactStatus, setContactStatus] = useState({
    isOnline: contact?.isOnline,
    lastSeen: contact?.lastSeen,
  });
  const [isBlocked, setIsBlocked] = useState(Boolean(contact?.isBlocked));
  const [deletingChat, setDeletingChat] = useState(false);
  const [sendError, setSendError] = useState("");

  // ---- Delete-message action sheet (opened on double-click of a bubble) ----
  const [messageToDelete, setMessageToDelete] = useState(null); // the message object, or null when closed
  const [deleteMessageBusy, setDeleteMessageBusy] = useState(false);
  const [deleteMessageError, setDeleteMessageError] = useState("");

  // ---- Undo "delete for everyone" toast ----
  // Only one pending-delete toast shown at a time (Gmail "undo send" style)
  // — { messageId, undoExpiresAt, secondsLeft } or null when hidden.
  const [undoToast, setUndoToast] = useState(null);
  const undoToastIntervalRef = useRef(null);

  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [showScrollbar, setShowScrollbar] = useState(false);

  // ---- Attachment picker + preview-before-send state ----
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // { file, type, previewUrl }
  const [isUploading, setIsUploading] = useState(false);

  // ---- Chat header "⋮" menu (Clear chat, Block user) ----
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
  const [headerMenuBusy, setHeaderMenuBusy] = useState(false);

  // ---- Voice recording state ----
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  // { type: "image" | "video", url, fileName } of whatever's currently open
  // in the fullscreen viewer, or null when it's closed.
  const [viewerMedia, setViewerMedia] = useState(null);

  const socket = useSocket();
  const { user } = useAuth();
  const { openUserProfile } = useProfileModal();
  const { startCall, callState } = useCall();
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
  const headerMenuRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingIntervalRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const discardRecordingRef = useRef(false);
  const recordingStartRef = useRef(null);
  const isStartingRecordingRef = useRef(false); // guards against a double-click starting two recordings
  const prevContactIdRef = useRef(null); // last contact we auto-scrolled for, so we only force-jump on an actual chat switch
  const activeContactIdRef = useRef(null); // always the truly-current contact id, kept in sync below (unlike a stale closure)
  // messageId -> { contactId, undoExpiresAt } for any delete-for-everyone still
  // inside its undo window, regardless of whether that chat is the one on
  // screen right now — lets the countdown (and the button) survive switching
  // to another chat and back, instead of being tied to whichever chat happens
  // to be open.
  const pendingDeleteInfoRef = useRef(new Map());

  // Sentinel that can never equal a real contact id (or null), so the
  // render-phase reset below always runs on the very first render too.
  const [renderedContactId, setRenderedContactId] = useState(UNINITIALIZED_CONTACT_ID);

  // Swap in the new contact's messages (and related per-conversation UI
  // state) synchronously during render, the instant the `contact` prop
  // changes. Doing this in a `useEffect` instead — as this used to — lets
  // React commit and PAINT one frame of the *previous* chat's messages
  // (and scroll position) under the *new* contact's header before the
  // effect gets a chance to run, which is exactly the visible "jerk" when
  // opening a chat: old content flashes, then swaps, then jump-scrolls.
  // Adjusting state directly in the render body (React's documented
  // pattern for "resetting state when a prop changes") replaces the
  // in-progress render before anything reaches the screen, so the swap is
  // already done by the first (and only) paint.
  const nextContactId = contact?._id ?? null;
  if (nextContactId !== renderedContactId) {
    setRenderedContactId(nextContactId);
    activeContactIdRef.current = nextContactId ? String(nextContactId) : null;
    if (contact) {
      const cached = messageCacheRef.current.get(String(contact._id));
      setMessages(cached?.messages || []);
      setHasMoreOlder(cached?.hasMore ?? false);
      setLoadingMessages(!cached);
      setIsOtherTyping(false);
      setContactStatus({ isOnline: contact.isOnline, lastSeen: contact.lastSeen });
      setIsBlocked(Boolean(contact.isBlocked));
    } else {
      setMessages([]);
      setHasMoreOlder(false);
      setLoadingMessages(false);
    }
    setSendError("");
    // Never show the scrollbar just because we switched chats
    setShowScrollbar(false);
    // A pending "delete for everyone" doesn't belong to any one chat view —
    // it belongs to the message. If the chat we're switching into has one
    // still inside its undo window, pick the countdown back up right where
    // it really is (based on the real expiry time, not a fresh 10s); if it
    // has none (or it already lapsed while we were away), just clear the UI.
    if (undoToastIntervalRef.current) clearInterval(undoToastIntervalRef.current);
    const nextIdStr = nextContactId ? String(nextContactId) : null;
    let resumedUndo = null;
    if (nextIdStr) {
      for (const [pendingMessageId, info] of pendingDeleteInfoRef.current) {
        if (info.contactId === nextIdStr) {
          if (new Date(info.undoExpiresAt).getTime() > Date.now()) {
            resumedUndo = { messageId: pendingMessageId, undoExpiresAt: info.undoExpiresAt };
          } else {
            pendingDeleteInfoRef.current.delete(pendingMessageId);
          }
          break;
        }
      }
    }
    if (resumedUndo) {
      showUndoToast(resumedUndo.messageId, resumedUndo.undoExpiresAt);
    } else {
      setUndoToast(null);
    }
  }

  useEffect(() => {
    if (!contact) return;
    const contactId = String(contact._id);

    if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);

    const cached = messageCacheRef.current.get(contactId);
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

  // ---------------------------------------------------------------------
  // Undo-delete-for-everyone helpers
  // ---------------------------------------------------------------------

  // Marks a message as "pending deletion" locally — this greys the bubble
  // out on the sender's own screen right away, without waiting for the
  // server to finalize anything. The other participant is never told this
  // happened; they keep seeing the message completely normally until (and
  // unless) the delete is actually finalized.
  // Marks a message as "pending deletion" in the given chat's cache — this
  // greys the bubble out right away. If that chat happens to be the one on
  // screen, the live view updates too; if not (we've since switched away),
  // only the cache is touched, and the switch-back logic above will restore
  // the live view (and the undo button) from that cache. The other
  // participant is never told this happened; they keep seeing the message
  // completely normally until (and unless) the delete is actually finalized.
  const applyPendingDeleteLocally = (contactId, messageId, undoExpiresAt) => {
    pendingDeleteInfoRef.current.set(String(messageId), { contactId, undoExpiresAt });

    const cached = messageCacheRef.current.get(contactId);
    if (cached) {
      const next = cached.messages.map((m) =>
        String(m._id) === String(messageId)
          ? { ...m, pendingDeleteForEveryone: true, deleteForEveryoneUndoExpiresAt: undoExpiresAt }
          : m
      );
      messageCacheRef.current.set(contactId, { messages: next, hasMore: cached.hasMore });
    }

    if (activeContactIdRef.current === contactId) {
      setMessages((prev) =>
        prev.map((m) =>
          String(m._id) === String(messageId)
            ? { ...m, pendingDeleteForEveryone: true, deleteForEveryoneUndoExpiresAt: undoExpiresAt }
            : m
        )
      );
    }
  };

  const clearPendingDeleteLocally = (contactId, messageId) => {
    pendingDeleteInfoRef.current.delete(String(messageId));

    const cached = messageCacheRef.current.get(contactId);
    if (cached) {
      const next = cached.messages.map((m) =>
        String(m._id) === String(messageId)
          ? { ...m, pendingDeleteForEveryone: false, deleteForEveryoneUndoExpiresAt: null }
          : m
      );
      messageCacheRef.current.set(contactId, { messages: next, hasMore: cached.hasMore });
    }

    if (activeContactIdRef.current === contactId) {
      setMessages((prev) =>
        prev.map((m) =>
          String(m._id) === String(messageId)
            ? { ...m, pendingDeleteForEveryone: false, deleteForEveryoneUndoExpiresAt: null }
            : m
        )
      );
    }
  };

  // Flips a message to its fully-finalized "deleted for everyone" state in
  // the given chat's cache (and live view, if that chat is on screen),
  // regardless of which chat happens to be open when the finalize event
  // actually arrives.
  const finalizeDeleteForEveryoneLocally = (contactId, messageId) => {
    pendingDeleteInfoRef.current.delete(String(messageId));
    const wipe = (m) =>
      String(m._id) === String(messageId)
        ? {
            ...m,
            deletedForEveryone: true,
            pendingDeleteForEveryone: false,
            deleteForEveryoneUndoExpiresAt: null,
            content: "",
            attachment: undefined,
          }
        : m;

    if (contactId) {
      const cached = messageCacheRef.current.get(contactId);
      if (cached) {
        messageCacheRef.current.set(contactId, { messages: cached.messages.map(wipe), hasMore: cached.hasMore });
      }
    }

    if (!contactId || activeContactIdRef.current === contactId) {
      setMessages((prev) => prev.map(wipe));
    }
  };

  // Hoisted (function declaration, not a const) so it can be called from the
  // contact-switch block above — which runs earlier in the component body,
  // on every render — to resume an in-flight countdown for a chat we're
  // switching back into.
  function showUndoToast(messageId, undoExpiresAt) {
    if (undoToastIntervalRef.current) clearInterval(undoToastIntervalRef.current);

    const expiresMs = new Date(undoExpiresAt).getTime();
    const totalSeconds = Math.max(1, Math.round((expiresMs - Date.now()) / 1000));

    const tick = () => {
      const secondsLeft = Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000));
      setUndoToast({ messageId, secondsLeft, totalSeconds, undoExpiresAt });
      if (secondsLeft <= 0) {
        clearInterval(undoToastIntervalRef.current);
        setUndoToast(null);
      }
    };
    tick();
    undoToastIntervalRef.current = setInterval(tick, 250);
  }

  const dismissUndoToast = () => {
    if (undoToastIntervalRef.current) clearInterval(undoToastIntervalRef.current);
    setUndoToast(null);
  };

  const handleUndoDelete = async () => {
    if (!undoToast) return;
    const { messageId } = undoToast;
    const contactId = pendingDeleteInfoRef.current.get(String(messageId))?.contactId || activeContactIdRef.current;
    dismissUndoToast();
    try {
      await undoDeleteMessage(messageId);
      if (contactId) clearPendingDeleteLocally(contactId, messageId);
    } catch (err) {
      console.error("Failed to undo delete:", err);
      // Most likely the grace window had already lapsed server-side — the
      // "messageDeleted" socket event finalizing it will arrive shortly
      // (or already did), so there's nothing else to reconcile here.
    }
  };

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

    // A "delete for everyone" I triggered just entered its undo window —
    // fired only to MY OWN other tabs/devices, never to the other
    // participant. Sync the pending state + toast here too, so every tab
    // I have open agrees on the countdown. (No conversation id comes with
    // this event, so if we already recorded which chat it belongs to —
    // e.g. this is the very tab that triggered the delete — trust that;
    // otherwise fall back to whichever chat is currently open.)
    const handleMessageDeletePending = ({ messageId, undoExpiresAt }) => {
      const owningContactId =
        pendingDeleteInfoRef.current.get(String(messageId))?.contactId || contactId;
      applyPendingDeleteLocally(owningContactId, messageId, undoExpiresAt);
      if (owningContactId === activeContactIdRef.current) {
        showUndoToast(messageId, undoExpiresAt);
      }
    };

    // I hit Undo (on this tab or another one) in time — revert the local
    // pending state and drop the toast if it's still showing this message.
    const handleMessageDeleteUndone = ({ messageId }) => {
      const owningContactId =
        pendingDeleteInfoRef.current.get(String(messageId))?.contactId || contactId;
      clearPendingDeleteLocally(owningContactId, messageId);
      setUndoToast((current) =>
        current && String(current.messageId) === String(messageId) ? null : current
      );
    };

    // A message was deleted — either by me (on another tab/device) via
    // "delete for me", or the undo window on a "delete for everyone"
    // fully lapsed and the server just finalized it. Either way, reflect
    // it in the right chat's message list immediately, whether or not
    // that chat happens to be the one on screen right now.
    const handleMessageDeleted = ({ messageId, forEveryone, withUserId }) => {
      if (forEveryone) {
        const owningContactId =
          pendingDeleteInfoRef.current.get(String(messageId))?.contactId ||
          (withUserId ? String(withUserId) : contactId);
        finalizeDeleteForEveryoneLocally(owningContactId, messageId);
      } else {
        const owningContactId = withUserId ? String(withUserId) : contactId;
        if (owningContactId === activeContactIdRef.current) {
          setMessages((prev) => {
            const next = prev.filter((m) => String(m._id) !== String(messageId));
            const prevCached = messageCacheRef.current.get(owningContactId);
            messageCacheRef.current.set(owningContactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
            return next;
          });
        } else {
          const cached = messageCacheRef.current.get(owningContactId);
          if (cached) {
            messageCacheRef.current.set(owningContactId, {
              messages: cached.messages.filter((m) => String(m._id) !== String(messageId)),
              hasMore: cached.hasMore,
            });
          }
        }
      }
      // In case the undo window lapsed while the toast was still showing
      // (e.g. this tab's own countdown drifted), make sure it's gone too.
      setUndoToast((current) =>
        current && String(current.messageId) === String(messageId) ? null : current
      );
    };

    // I cleared this chat from another tab/device — mirror it here too.
    const handleChatCleared = ({ withUserId }) => {
      if (String(withUserId) !== contactId) return;
      messageCacheRef.current.set(contactId, { messages: [], hasMore: false });
      setMessages([]);
      setHasMoreOlder(false);
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
    socket.on("messageDeletePending", handleMessageDeletePending);
    socket.on("messageDeleteUndone", handleMessageDeleteUndone);
    socket.on("messageDeleted", handleMessageDeleted);
    socket.on("chatCleared", handleChatCleared);

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
      socket.off("messageDeletePending", handleMessageDeletePending);
      socket.off("messageDeleteUndone", handleMessageDeleteUndone);
      socket.off("messageDeleted", handleMessageDeleted);
      socket.off("chatCleared", handleChatCleared);
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

    const contactId = contact?._id ?? null;
    const contactChanged = prevContactIdRef.current !== contactId;
    prevContactIdRef.current = contactId;

    // Only force the view down to the newest message when we've just opened
    // a conversation, or when the person was already sitting at (or near)
    // the bottom — e.g. a new message just arrived while they were reading
    // the latest messages. In-place edits to the existing list (starring a
    // message, read receipts, delivery ticks) update `messages` too, but
    // must never yank someone back down while they're scrolled up reading
    // older history.
    if (contactChanged || isPinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      // We just forced the view to the bottom, so mark it "pinned" — any
      // image/video that loads after this point and grows the container
      // should keep it snapped to the bottom too (see handleMediaLoad).
      isPinnedToBottomRef.current = true;
    }
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
      if (undoToastIntervalRef.current) clearInterval(undoToastIntervalRef.current);
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

  // Close the chat-header "⋮" menu when clicking outside it, or on Escape
  useEffect(() => {
    if (!isHeaderMenuOpen) return;
    const handleClickOutside = (e) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
        setIsHeaderMenuOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === "Escape") setIsHeaderMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isHeaderMenuOpen]);

  // Never leave the menu open (or mid-request) when switching chats
  useEffect(() => {
    setIsHeaderMenuOpen(false);
    setHeaderMenuBusy(false);
  }, [contact?._id]);

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

  // Block/unblock from the "⋮" menu in the chat header.
  const handleToggleBlockFromMenu = async () => {
    if (!contact || headerMenuBusy) return;
    setHeaderMenuBusy(true);
    try {
      if (isBlocked) {
        await unblockUser(contact._id);
        setIsBlocked(false);
      } else {
        await blockUser(contact._id);
        setIsBlocked(true);
      }
      setIsHeaderMenuOpen(false);
    } catch (err) {
      console.error("Failed to toggle block:", err);
    } finally {
      setHeaderMenuBusy(false);
    }
  };

  // "Clear chat" — WhatsApp-style: wipes the message history on my side
  // only. The contact keeps their own copy and is never notified.
  const handleClearChat = async () => {
    if (!contact || deletingChat) return;
    const confirmed = window.confirm(
      `Clear this chat with ${contact.username}? Messages will be removed from your side only and this can't be undone.`
    );
    if (!confirmed) return;

    setDeletingChat(true);
    try {
      await clearChat(contact._id);
      const contactId = String(contact._id);
      messageCacheRef.current.set(contactId, { messages: [], hasMore: false });
      setMessages([]);
      setHasMoreOlder(false);
      setIsHeaderMenuOpen(false);
    } catch (err) {
      console.error("Failed to clear chat:", err);
    } finally {
      setDeletingChat(false);
    }
  };

  // ---------------------------------------------------------------------
  // Delete message (double-click a bubble to open the action sheet)
  // ---------------------------------------------------------------------

  const openDeleteSheetForMessage = (message) => {
    // Nothing left to delete once it's fully gone, and don't let someone
    // re-open the sheet on a message that's already mid-undo-window.
    if (message.deletedForEveryone || message.pendingDeleteForEveryone) return;
    setDeleteMessageError("");
    setMessageToDelete(message);
  };

  const closeDeleteSheet = () => {
    if (deleteMessageBusy) return;
    setMessageToDelete(null);
    setDeleteMessageError("");
  };

  const confirmDeleteMessage = async (forEveryone) => {
    if (!messageToDelete || deleteMessageBusy || !contact) return;
    const targetId = messageToDelete._id;
    const contactId = String(contact._id);

    setDeleteMessageBusy(true);
    setDeleteMessageError("");
    try {
      const res = await deleteMessage(targetId, forEveryone);

      if (forEveryone) {
        // Soft delete: the message isn't actually gone yet — it's sitting
        // in a short server-side undo window. Grey it out locally right
        // away and surface an Undo toast with a live countdown.
        const undoExpiresAt =
          res?.data?.undoExpiresAt || new Date(Date.now() + FALLBACK_UNDO_WINDOW_MS).toISOString();
        applyPendingDeleteLocally(contactId, targetId, undoExpiresAt);
        showUndoToast(targetId, undoExpiresAt);
      } else {
        setMessages((prev) => {
          const next = prev.filter((m) => String(m._id) !== String(targetId));
          const prevCached = messageCacheRef.current.get(contactId);
          messageCacheRef.current.set(contactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
          return next;
        });
      }

      setMessageToDelete(null);
    } catch (err) {
      setDeleteMessageError(
        err?.response?.data?.message || "Failed to delete message. Please try again."
      );
    } finally {
      setDeleteMessageBusy(false);
    }
  };

  // Star/unstar a message. Updates optimistically (and the per-contact
  // cache) so the star feels instant instead of waiting on the network.
  const handleToggleStar = async (messageId, currentlyStarred) => {
    const applyLocally = (starred) => {
      setMessages((prev) => {
        const next = prev.map((m) => {
          if (m._id !== messageId) return m;
          const starredBy = m.starredBy || [];
          const nextStarredBy = starred
            ? [...starredBy, user._id]
            : starredBy.filter((id) => String(id) !== String(user._id));
          return { ...m, starredBy: nextStarredBy };
        });
        const contactId = String(contact._id);
        const prevCached = messageCacheRef.current.get(contactId);
        messageCacheRef.current.set(contactId, { messages: next, hasMore: prevCached?.hasMore ?? false });
        return next;
      });
    };

    applyLocally(!currentlyStarred);
    try {
      if (currentlyStarred) {
        await unstarMessage(messageId);
      } else {
        await starMessage(messageId);
      }
    } catch (err) {
      console.error("Failed to toggle star:", err);
      applyLocally(currentlyStarred); // roll back on failure
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

        <button
          type="button"
          className="icon-btn chat-header-call-btn"
          disabled={callState !== "idle"}
          onClick={(e) => {
            e.stopPropagation();
            startCall(contact, "video");
          }}
          title="Video call"
        >
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </button>

        <button
          type="button"
          className="icon-btn chat-header-call-btn"
          disabled={callState !== "idle"}
          onClick={(e) => {
            e.stopPropagation();
            startCall(contact, "audio");
          }}
          title="Voice call"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </button>

        <div className="chat-header-menu-wrapper" ref={headerMenuRef}>
          <button
            type="button"
            className="icon-btn chat-header-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setIsHeaderMenuOpen((v) => !v);
            }}
            title="Menu"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          {isHeaderMenuOpen && (
            <div className="chat-header-menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="chat-header-menu-item"
                onClick={handleClearChat}
                disabled={deletingChat}
              >
                <span className="chat-header-menu-item-icon" aria-hidden="true"></span>
                <span>{deletingChat ? "Clearing..." : "Clear chat"}</span>
              </button>
              <button
                type="button"
                className="chat-header-menu-item chat-header-menu-item-danger"
                onClick={handleToggleBlockFromMenu}
                disabled={headerMenuBusy}
              >
                <span className="chat-header-menu-item-icon" aria-hidden="true"></span>
                <span>
                  {headerMenuBusy
                    ? "Please wait..."
                    : isBlocked
                    ? `Unblock ${contact.username}`
                    : `Block ${contact.username}`}
                </span>
              </button>
            </div>
          )}
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
        isStarred={(m.starredBy || []).some((id) => String(id) === String(user._id))}
        onOpenMedia={setViewerMedia}
        onMediaLoad={handleMediaLoad}
        onToggleStar={handleToggleStar}
        onDoubleClick={openDeleteSheetForMessage}
        undoInfo={undoToast && undoToast.messageId === m._id ? undoToast : null}
        onUndoDelete={handleUndoDelete}
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
        <div className="blocked-state">
          <button type="button" className="blocked-pill" onClick={handleUnblockFromChat}>
            You blocked {contact.username}. Tap to unblock.
          </button>
          <div className="blocked-actions">
            <button type="button" className="blocked-action blocked-action-delete" onClick={handleClearChat} disabled={deletingChat}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
              <span>{deletingChat ? "Clearing..." : "Clear chat"}</span>
            </button>
            <button type="button" className="blocked-action blocked-action-unblock" onClick={handleUnblockFromChat}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <line x1="5.5" y1="18.5" x2="18.5" y2="5.5" />
              </svg>
              <span>Unblock</span>
            </button>
          </div>
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

{messageToDelete && (
  <div className="delete-message-sheet-backdrop" onClick={closeDeleteSheet}>
    <div className="delete-message-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="delete-message-sheet-header">
        <span className="delete-message-sheet-icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
          </svg>
        </span>
        <div className="delete-message-sheet-header-text">
          <span className="delete-message-sheet-title">Delete message</span>
          <span className="delete-message-sheet-subtitle">This can't be undone once finished</span>
        </div>
      </div>

      {deleteMessageError && (
        <div className="delete-message-sheet-error">{deleteMessageError}</div>
      )}

      <div className="delete-message-sheet-options">
        <button
          type="button"
          className="delete-message-sheet-option"
          onClick={() => confirmDeleteMessage(false)}
          disabled={deleteMessageBusy}
        >
          <span className="delete-message-sheet-option-icon">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14l-4-4 4-4" />
              <path d="M5 10h11a4 4 0 010 8h-1" />
            </svg>
          </span>
          <span className="delete-message-sheet-option-text">
            <span className="delete-message-sheet-option-label">Delete for me</span>
            <span className="delete-message-sheet-option-hint">Removes it from your view only</span>
          </span>
        </button>

        {String(messageToDelete.sender) === String(user._id) && (
          <button
            type="button"
            className="delete-message-sheet-option delete-message-sheet-option-danger"
            onClick={() => confirmDeleteMessage(true)}
            disabled={deleteMessageBusy}
          >
            <span className="delete-message-sheet-option-icon">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </span>
            <span className="delete-message-sheet-option-text">
              <span className="delete-message-sheet-option-label">Delete for everyone</span>
              <span className="delete-message-sheet-option-hint">Removes it for both of you</span>
            </span>
          </button>
        )}
      </div>

      <button
        type="button"
        className="delete-message-sheet-cancel"
        onClick={closeDeleteSheet}
        disabled={deleteMessageBusy}
      >
        Cancel
      </button>
    </div>
  </div>
)}

    </div>
  );
}