import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getCallLogs, deleteMessage } from "../api";
import { useAuth } from "../context/Authcontext";
import { useCall } from "../context/Callcontext";
import { resolveAvatarUrl } from "../utils/avatar";
import { getCallDisplay } from "../utils/callDisplay";
import { PhoneIcon, VideoIcon, CallDirectionArrow } from "./CallIcons";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
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

// Collapses consecutive calls with the same contact into a single row with
// a "(n)" count badge — the same grouping WhatsApp's own Calls tab uses,
// so calling someone back-to-back doesn't flood the list with duplicates.
function groupCalls(calls, myId) {
  const groups = [];
  for (const call of calls) {
    const senderId = String(call.sender?._id || call.sender);
    const isOwn = senderId === String(myId);
    const otherUser = isOwn ? call.receiver : call.sender;
    const otherId = String(otherUser?._id || otherUser || senderId);

    const last = groups[groups.length - 1];
    if (last && last.otherId === otherId) {
      last.count += 1;
      last.calls.push(call);
    } else {
      groups.push({ otherId, otherUser, latest: call, isOwn, count: 1, calls: [call] });
    }
  }
  return groups;
}

export default function CallLogsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { startCall } = useCall();

  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // "all" | "missed"

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
      if (filter !== "missed") return true;
      const isOwn = String(c.sender?._id || c.sender) === String(user._id);
      return c.call?.status !== "completed" && !isOwn;
    });
    return groupCalls(filtered, user._id);
  }, [calls, filter, user]);

  // Removes a whole group from my own call history (mirrors "delete for
  // me" on a regular message — the other participant's copy is untouched).
  const handleDeleteGroup = async (group) => {
    try {
      await Promise.all(group.calls.map((c) => deleteMessage(c._id, false)));
      setCalls((prev) => prev.filter((c) => !group.calls.some((gc) => gc._id === c._id)));
    } catch (err) {
      console.error("Failed to delete call log entry:", err);
    }
  };

  return (
    <div className="call-logs-page">
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
            {filter === "missed" ? "No missed calls" : "No call history yet"}
          </div>
        )}

        {!loading &&
          groups.map((g) => {
            const call = g.latest;
            const { isVideo, missed, outgoing, title, subtitle } = getCallDisplay(
              call.call,
              g.isOwn
            );
            const username = g.otherUser?.username || "Unknown";

            return (
              <div key={g.latest._id} className={`call-log-item ${missed ? "call-log-missed" : ""}`}>
                <img
                  src={resolveAvatarUrl(g.otherUser?.avatar)}
                  alt={username}
                  className="avatar-md"
                />
                <div className="call-log-info">
                  <span className="call-log-name">
                    {username}
                    {g.count > 1 && <span className="call-log-count">({g.count})</span>}
                  </span>
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
                    onClick={() => g.otherUser && startCall(g.otherUser, "audio")}
                  >
                    <PhoneIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Video call"
                    disabled={!g.otherUser}
                    onClick={() => g.otherUser && startCall(g.otherUser, "video")}
                  >
                    <VideoIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-btn call-log-delete-btn"
                    title="Delete from call history"
                    onClick={() => handleDeleteGroup(g)}
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
  );
}