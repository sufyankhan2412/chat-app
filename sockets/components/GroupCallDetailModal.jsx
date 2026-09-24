import React, { useEffect, useState } from "react";
import { 
  getGroupCallLog, 
  getTranscriptStatus, 
  downloadTranscript, 
  getActionItems
} from "../api";
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
  const [transcript, setTranscript] = useState({ status: "not_started" });
  const [downloading, setDownloading] = useState(false);
  const [actionItems, setActionItems] = useState(null);
  const [loadingActionItems, setLoadingActionItems] = useState(false);
  const [showActionItems, setShowActionItems] = useState(false);

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

  // Polls the transcript status while a call is still being processed
  // (see enqueueGroupCallTranscription in transcriptionService.js) so the
  // "Download transcript" option appears on its own once it's ready,
  // without the user needing to reopen this modal.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer;

    const poll = async () => {
      try {
        const { data } = await getTranscriptStatus(roomId);
        if (cancelled) return;
        setTranscript(data);
        if (data.status === "not_started" || data.status === "processing") {
          timer = setTimeout(poll, 5000);
        }
      } catch {
        // No transcript support for this call (or it hasn't ended yet) —
        // fail silently rather than surfacing a second error banner.
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [roomId]);

  const handleDownloadTranscript = async () => {
    setDownloading(true);
    try {
      const { data } = await downloadTranscript(roomId);
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `call-transcript-${roomId}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("downloadTranscript error:", err);
    } finally {
      setDownloading(false);
    }
  };

  const handleViewActionItems = async () => {
    if (actionItems) {
      setShowActionItems(!showActionItems);
      return;
    }

    setLoadingActionItems(true);
    try {
      const { data } = await getActionItems(roomId);
      setActionItems(data);
      setShowActionItems(true);
    } catch (err) {
      console.error("getActionItems error:", err);
    } finally {
      setLoadingActionItems(false);
    }
  };

  const handleAddToCalendar = (calendarLink) => {
    window.open(calendarLink, '_blank');
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

              <div className="profile-divider" />

              <div className="call-detail-history gc-transcript-section">
                <div className="call-detail-history-title">Transcript & Action Items</div>

                {transcript.status === "completed" && (
                  <div className="gc-transcript-actions">
                    <button
                      type="button"
                      className="gc-transcript-download-btn"
                      onClick={handleDownloadTranscript}
                      disabled={downloading}
                    >
                      {downloading ? "Downloading…" : "📄 Download transcript (.txt)"}
                    </button>
                    
                    <button
                      type="button"
                      className="gc-transcript-download-btn gc-action-items-btn"
                      onClick={handleViewActionItems}
                      disabled={loadingActionItems}
                    >
                      {loadingActionItems ? "Loading…" : showActionItems ? "▼ Hide action items" : "▶ View AI action items"}
                    </button>
                  </div>
                )}

                {showActionItems && actionItems && (
                  <div className="gc-action-items">
                    <div className="gc-auto-sync-notice">
                      ℹ️ Action items are automatically synced to Google Calendar for all participants with connected calendars.
                    </div>
                    
                    {actionItems.summary && (
                      <div className="gc-action-summary">
                        <strong>📝 Meeting Summary:</strong>
                        <p>{actionItems.summary}</p>
                      </div>
                    )}

                    {actionItems.actionItems && actionItems.actionItems.length > 0 && (
                      <div className="gc-action-list">
                        <h4>📋 Action Items ({actionItems.actionItems.length})</h4>
                        {actionItems.actionItems.map((item, index) => (
                          <div key={index} className={`gc-action-item gc-priority-${item.priority.toLowerCase()}`}>
                            <div className="gc-action-header">
                              <span className="gc-action-priority">
                                {item.priority === 'High' ? '🔴' : item.priority === 'Medium' ? '🟡' : '🟢'}
                              </span>
                              <strong>{item.task}</strong>
                            </div>
                            {item.owner && item.owner !== 'Not specified' && (
                              <div className="gc-action-meta">👤 {item.owner}</div>
                            )}
                            {item.deadline && item.deadline !== 'Not specified' && (
                              <div className="gc-action-meta">⏰ {item.deadline}</div>
                            )}
                            {item.context && (
                              <div className="gc-action-context">{item.context}</div>
                            )}
                            {item.calendarLink && (
                              <button
                                type="button"
                                className="gc-calendar-btn"
                                onClick={() => handleAddToCalendar(item.calendarLink)}
                              >
                                📅 Add to Calendar
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {actionItems.keyDecisions && actionItems.keyDecisions.length > 0 && (
                      <div className="gc-key-decisions">
                        <h4>💡 Key Decisions</h4>
                        <ul>
                          {actionItems.keyDecisions.map((decision, index) => (
                            <li key={index}>{decision}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {actionItems.nextSteps && actionItems.nextSteps.length > 0 && (
                      <div className="gc-next-steps">
                        <h4>➡️ Next Steps</h4>
                        <ul>
                          {actionItems.nextSteps.map((step, index) => (
                            <li key={index}>{step}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(!actionItems.actionItems || actionItems.actionItems.length === 0) && 
                     (!actionItems.keyDecisions || actionItems.keyDecisions.length === 0) && (
                      <p className="gc-transcript-note">No action items were identified in this meeting.</p>
                    )}
                  </div>
                )}

                {(transcript.status === "not_started" || transcript.status === "processing") && (
                  <p className="gc-transcript-note">
                    Transcript is being generated — check back shortly.
                  </p>
                )}

                {transcript.status === "failed" && (
                  <p className="gc-transcript-note gc-transcript-error">
                    Couldn't generate a transcript for this call.
                  </p>
                )}

                {transcript.missingParticipants?.length > 0 && (
                  <p className="gc-transcript-note">
                    No usable audio was captured for: {transcript.missingParticipants.join(", ")}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}