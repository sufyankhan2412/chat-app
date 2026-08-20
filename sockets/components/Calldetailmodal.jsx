import React, { useEffect, useState } from "react";
import { getCallLogsWith } from "../api";
import { useProfileModal } from "../context/Profilemodalcontext";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatLastSeen } from "../utils/formatLastSeen";
import { getCallDisplay } from "../utils/callDisplay";
import { PhoneIcon, VideoIcon, CallDirectionArrow } from "./CallIcons";

// Full date + time, e.g. "20 Aug 2026, 10:32 AM" — this is the detail
// screen, so (unlike the list's relative "Yesterday" shorthand) every
// entry gets its exact date, matching WhatsApp's own call-info screen.
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

// Shown when you tap a call log row — the contact's info up top (avatar,
// name, presence) plus quick call/video buttons, then every past call
// with that one contact underneath. Mirrors WhatsApp: tapping a call in
// the Calls tab opens this same "contact + full call history" screen
// rather than immediately redialing.
export default function CallDetailModal({ user, myId, onStartCall, onClose }) {
  const { openUserProfile } = useProfileModal();
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?._id) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await getCallLogsWith(user._id);
        if (!cancelled) setCalls(res.data.calls || []);
      } catch (err) {
        console.error("Failed to fetch call history:", err);
        if (!cancelled) setCalls([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?._id]);

  if (!user) return null;

  const subtitle = user.isOnline ? "Online" : formatLastSeen(user.lastSeen);

  const handleOpenContactInfo = () => {
    onClose();
    openUserProfile(user);
  };

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
          <button
            type="button"
            className="call-detail-avatar-wrapper"
            onClick={handleOpenContactInfo}
            title="View contact info"
          >
            <img
              src={resolveAvatarUrl(user.avatar)}
              alt={user.username}
              className="profile-avatar-lg"
            />
          </button>

          <div className="profile-identity call-detail-identity" onClick={handleOpenContactInfo}>
            <h2 className="profile-name">{user.username}</h2>
            <p className="profile-subtitle">{subtitle}</p>
          </div>

          <div className="call-detail-actions">
            <button
              type="button"
              className="call-detail-action-btn"
              onClick={() => onStartCall(user, "audio")}
            >
              <PhoneIcon width="20" height="20" />
              <span>Voice call</span>
            </button>
            <button
              type="button"
              className="call-detail-action-btn"
              onClick={() => onStartCall(user, "video")}
            >
              <VideoIcon width="20" height="20" />
              <span>Video call</span>
            </button>
          </div>

          <div className="profile-divider" />

          <div className="call-detail-history">
            <div className="call-detail-history-title">Call history</div>

            {loading && (
              <div className="messages-loading">
                <div className="spinner" />
              </div>
            )}

            {!loading && calls.length === 0 && (
              <div className="empty-state">No calls with {user.username} yet</div>
            )}

            {!loading &&
              calls.map((call) => {
                const isOwn = String(call.sender?._id || call.sender) === String(myId);
                const { isVideo, missed, outgoing, title, subtitle: callSubtitle } =
                  getCallDisplay(call.call, isOwn);

                return (
                  <div
                    key={call._id}
                    className={`call-detail-row ${missed ? "call-log-missed" : ""}`}
                  >
                    <span className="call-detail-row-icon">
                      {isVideo ? <VideoIcon /> : <PhoneIcon />}
                    </span>
                    <div className="call-detail-row-info">
                      <span className="call-detail-row-title">
                        <CallDirectionArrow outgoing={outgoing} missed={missed} />
                        {title}
                      </span>
                      <span className="call-detail-row-time">
                        {formatFullTime(call.createdAt)}
                        {call.call?.status === "completed" && ` · ${callSubtitle}`}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}