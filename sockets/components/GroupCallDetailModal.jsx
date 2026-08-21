import React, { useEffect, useState } from "react";
import { getGroupCallLog } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatCallDuration } from "../../backend/formatCallDuration";
import { PhoneIcon, VideoIcon } from "./Callicons";

function formatFullTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Every attendee opens this same view of the same underlying Call
// document — there's no per-user rewriting of history, just each person
// querying the one shared log they were both part of, the way tapping a
// WhatsApp group call entry shows everyone who was on it to everyone who
// was on it.
export default function GroupCallDetailModal({ roomId, onClose }) {
  const [call, setCall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getGroupCallLog(roomId);
        if (!cancelled) setCall(data.call);
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.message || "Couldn't load this call's log.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="profile-modal call-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="profile-modal-header">
          <button className="modal-back-btn" onClick={onClose} title="Close">
            ←
          </button>
          <span>Call details</span>
        </div>

        <div className="profile-modal-body call-detail-body">
          {loading && (
            <div className="messages-loading">
              <div className="spinner" />
            </div>
          )}

          {!loading && error && <div className="empty-state">{error}</div>}

          {!loading && call && (
            <>
              <div className="gc-detail-header">
                {call.callType === "video" ? <VideoIcon width="22" height="22" /> : <PhoneIcon width="22" height="22" />}
                <div>
                  <h2 className="profile-name">
                    {call.callType === "video" ? "Video call" : "Voice call"}
                  </h2>
                  <p className="profile-subtitle">
                    Started by {call.initiator?.username || "Unknown"} · {formatFullTime(call.startedAt)}
                  </p>
                </div>
              </div>

              <div className="profile-divider" />

              <div className="call-detail-history">
                <div className="call-detail-history-title">
                  {call.participants.length} {call.participants.length === 1 ? "participant" : "participants"}
                </div>

                {call.participants.map((p, i) => (
                  <div key={`${p.user?._id || p.user}-${i}`} className="gc-participant-row">
                    <img
                      src={resolveAvatarUrl(p.user?.avatar)}
                      alt={p.user?.username}
                      className="avatar-sm"
                    />
                    <div className="call-detail-row-info">
                      <span className="call-detail-row-title">{p.user?.username || "Unknown"}</span>
                      <span className="call-detail-row-time">
                        {p.mode === "video" ? "Joined with video" : "Joined with audio"}
                        {" · "}
                        {p.leftAt ? (
                          formatCallDuration(p.duration)
                        ) : (
                          <span className="gc-live-badge">
                            <span className="gc-live-dot" /> In call
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}