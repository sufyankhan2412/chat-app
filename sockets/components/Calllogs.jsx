import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getCallLogs, deleteMessage, deleteGroupCallLog } from "../api";
import { useAuth } from "../context/Authcontext";
import { useCall } from "../context/Callcontext";
import { resolveAvatarUrl } from "../utils/avatar";
import { getCallDisplay } from "../utils/Calldisplay";
import { formatCallDuration } from "../../backend/formatCallDuration";
import { PhoneIcon, VideoIcon, CallDirectionArrow } from "./Callicons";
import CallDetailModal from "./Calldetailmodal";
import GroupCallDetailModal from "./GroupCallDetailModal";
import NewCallModal from "./NewCallModal";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CallsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="72" height="72" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function NewCallGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function GroupCallGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

// Mirrors Sidebar.jsx's own "today / yesterday / short date" convention so
// the Calls page reads consistently with the rest of the app.
function formatLogTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

// Turns a raw call log entry into the shape the list renders — kept as its
// own step (rather than grouping repeats under one row) so every call shows
// its own missed/answered status and timestamp, nothing hidden behind a
// "(n)" counter.
function toRow(call, myId) {
  const senderId = String(call.sender?._id || call.sender);
  const isOwn = senderId === String(myId);
  const otherUser = isOwn ? call.receiver : call.sender;
  return { entryType: "direct", latest: call, otherUser, isOwn };
}

// A group-call row shows every other attendee by name (WhatsApp's own
// group-call rows do the same — "You, Alex, Sam" style) plus how long
// *this* viewer personally stayed, since that's the one number that's
// different for every attendee even though everyone's looking at the same
// underlying log.
function toGroupRow(call, myId) {
  const others = call.participants.filter(
    (p) => String(p.user?._id || p.user) !== String(myId)
  );
  const mine = call.participants.find(
    (p) => String(p.user?._id || p.user) === String(myId)
  );
  const names = others.map((p) => p.user?.username || "Unknown");
  return { entryType: "group", latest: call, others, names, myDuration: mine?.duration || 0 };
}

export default function CallLogsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { startCall } = useCall();

  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // "all" | "missed"
  const [query, setQuery] = useState("");
  // Whichever contact's row was tapped — opens the WhatsApp-style "Call
  // details" screen (their info + full call history) over this page.
  const [detailUser, setDetailUser] = useState(null);
  // roomId of a group-call row that was tapped — opens the group call's
  // shared log (every participant + their own duration).
  const [detailRoomId, setDetailRoomId] = useState(null);
  const [showNewCall, setShowNewCall] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getCallLogs();
        if (!cancelled) setCalls(res.data.calls || []);
      } catch (err) {
        console.error("Failed to fetch call logs:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    if (!user) return [];
    const filtered = calls.filter((c) => {
      if (filter === "missed") {
        // Group calls don't have a "missed" state (you either joined or
        // you didn't, and if you didn't there's no log entry for you at
        // all) — the Missed tab only ever concerns 1:1 calls.
        if (c.entryType === "group") return false;
        const isOwn = String(c.sender?._id || c.sender) === String(user._id);
        if (c.call?.status === "completed" || isOwn) return false;
      }
      return true;
    });
    const rows = filtered.map((c) =>
      c.entryType === "group" ? toGroupRow(c, user._id) : toRow(c, user._id)
    );
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.entryType === "group") {
        return r.names.some((n) => n.toLowerCase().includes(q));
      }
      return (r.otherUser?.username || "").toLowerCase().includes(q);
    });
  }, [calls, filter, user, query]);

  // Removes a single call from my own call history (mirrors "delete for
  // me" on a regular message — the other participant's copy is untouched).
  const handleDeleteCall = async (call) => {
    try {
      await deleteMessage(call._id, false);
      setCalls((prev) => prev.filter((c) => c._id !== call._id));
    } catch (err) {
      console.error("Failed to delete call log entry:", err);
    }
  };

  // Same "delete for me" idea, for a group-call log row.
  const handleDeleteGroupCall = async (call) => {
    try {
      await deleteGroupCallLog(call.roomId);
      setCalls((prev) => prev.filter((c) => c.roomId !== call.roomId));
    } catch (err) {
      console.error("Failed to delete group call log entry:", err);
    }
  };

  return (
    <div className="call-logs-page">
      <div className="call-logs-panel">
        <div className="call-logs-header">
          <button
            type="button"
            className="icon-btn call-logs-back-btn"
            onClick={() => navigate("/chat")}
            title="Back to chats"
          >
            <BackIcon />
          </button>
          <span className="call-logs-title">Calls</span>
          <button
            type="button"
            className="icon-btn call-logs-new-btn"
            onClick={() => setShowNewCall(true)}
            title="New call"
          >
            <NewCallGlyph />
          </button>
        </div>

        <div className="call-logs-search">
          <SearchIcon />
          <input
            type="text"
            placeholder="Search calls"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="call-logs-tabs">
          <button
            type="button"
            className={`call-logs-tab ${filter === "all" ? "active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`call-logs-tab ${filter === "missed" ? "active" : ""}`}
            onClick={() => setFilter("missed")}
          >
            Missed
          </button>
        </div>

        <div className="call-logs-list">
          {loading && (
            <div className="messages-loading">
              <div className="spinner" />
            </div>
          )}

          {!loading && groups.length === 0 && (
            <div className="empty-state">
              {query
                ? "No calls match your search"
                : filter === "missed"
                ? "No missed calls"
                : "No call history yet"}
            </div>
          )}

          {!loading &&
            groups.map((g) => {
              if (g.entryType === "group") {
                const call = g.latest;
                const namesLabel =
                  g.names.length === 0
                    ? "Just you"
                    : g.names.length <= 2
                    ? g.names.join(", ")
                    : `${g.names.slice(0, 2).join(", ")} +${g.names.length - 2}`;

                return (
                  <div
                    key={call.roomId}
                    className="call-log-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailRoomId(call.roomId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setDetailRoomId(call.roomId);
                    }}
                  >
                    <span className="call-log-avatar call-log-group-icon">
                      <GroupCallGlyph />
                    </span>
                    <div className="call-log-info">
                      <span className="call-log-name">{namesLabel}</span>
                      <span className="call-log-meta">
                        {call.callType === "video" ? <VideoIcon width="14" height="14" /> : <PhoneIcon width="14" height="14" />}
                        {call.callType === "video" ? "Video call" : "Voice call"}
                        {" · "}
                        {formatCallDuration(g.myDuration)}
                        {" · "}
                        {formatLogTime(call.createdAt)}
                      </span>
                    </div>
                    <div className="call-log-actions">
                      <button
                        type="button"
                        className="icon-btn call-log-delete-btn"
                        title="Delete from call history"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteGroupCall(call);
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              }

              const call = g.latest;
              const { isVideo, missed, outgoing, title, subtitle } = getCallDisplay(
                call.call,
                g.isOwn
              );
              const username = g.otherUser?.username || "Unknown";

              return (
                <div
                  key={call._id}
                  className={`call-log-item ${missed ? "call-log-missed" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => g.otherUser && setDetailUser(g.otherUser)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && g.otherUser) {
                      setDetailUser(g.otherUser);
                    }
                  }}
                >
                  <img
                    src={resolveAvatarUrl(g.otherUser?.avatar)}
                    alt={username}
                    className="avatar-md call-log-avatar"
                  />
                  <div className="call-log-info">
                    <span className="call-log-name">{username}</span>
                    <span className="call-log-meta">
                      <CallDirectionArrow outgoing={outgoing} missed={missed} />
                      {title}
                      {call.call?.status === "completed" && ` · ${subtitle}`}
                      {" · "}
                      {formatLogTime(call.createdAt)}
                    </span>
                  </div>
                  <div className="call-log-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="Voice call"
                      disabled={!g.otherUser}
                      onClick={(e) => {
                        e.stopPropagation();
                        g.otherUser && startCall(g.otherUser, "audio");
                      }}
                    >
                      <PhoneIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Video call"
                      disabled={!g.otherUser}
                      onClick={(e) => {
                        e.stopPropagation();
                        g.otherUser && startCall(g.otherUser, "video");
                      }}
                    >
                      <VideoIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-btn call-log-delete-btn"
                      title="Delete from call history"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCall(call);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <div className="call-logs-empty-panel">
        <CallsGlyph />
        <h2>WhatsApp Calls</h2>
        <p>
          Call your contacts for free with an internet connection. Voice and
          video calls stay end-to-end encrypted between you and the person
          you're calling — pick a chat and hit the phone or camera icon to
          start one.
        </p>
      </div>

      {detailUser && (
        <CallDetailModal
          user={detailUser}
          myId={user?._id}
          onStartCall={(contact, type) => {
            setDetailUser(null);
            startCall(contact, type);
          }}
          onClose={() => setDetailUser(null)}
        />
      )}

      {detailRoomId && (
        <GroupCallDetailModal roomId={detailRoomId} onClose={() => setDetailRoomId(null)} />
      )}

      {showNewCall && <NewCallModal onClose={() => setShowNewCall(false)} />}
    </div>
  );
}