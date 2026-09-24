import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { 
  getCalendarStatus, 
  getCalendarConnectUrl, 
  disconnectCalendar 
} from "../api";
import { useAuth } from "../context/Authcontext";
import "./Settings.css";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  
  const [calendarStatus, setCalendarStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadCalendarStatus();
    
    // Check for OAuth callback messages
    const calendarParam = searchParams.get('calendar');
    if (calendarParam === 'connected') {
      setMessage({ type: 'success', text: 'Google Calendar connected successfully!' });
      setTimeout(() => setMessage(null), 5000);
      loadCalendarStatus();
    } else if (calendarParam === 'error') {
      setMessage({ type: 'error', text: 'Failed to connect Google Calendar. Please try again.' });
      setTimeout(() => setMessage(null), 5000);
    }
  }, [searchParams]);

  const loadCalendarStatus = async () => {
    setLoading(true);
    try {
      const { data } = await getCalendarStatus();
      setCalendarStatus(data);
    } catch (err) {
      console.error('Failed to load calendar status:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectCalendar = async () => {
    setConnecting(true);
    try {
      const { data } = await getCalendarConnectUrl();
      // Redirect to Google OAuth
      window.location.href = data.authUrl;
    } catch (err) {
      console.error('Failed to connect calendar:', err);
      setMessage({ 
        type: 'error', 
        text: err.response?.data?.message || 'Failed to initiate calendar connection' 
      });
      setTimeout(() => setMessage(null), 5000);
      setConnecting(false);
    }
  };

  const handleDisconnectCalendar = async () => {
    if (!confirm('Are you sure you want to disconnect Google Calendar? Action items will no longer sync automatically.')) {
      return;
    }

    setDisconnecting(true);
    try {
      await disconnectCalendar();
      setMessage({ type: 'success', text: 'Google Calendar disconnected' });
      setTimeout(() => setMessage(null), 5000);
      await loadCalendarStatus();
    } catch (err) {
      console.error('Failed to disconnect calendar:', err);
      setMessage({ type: 'error', text: 'Failed to disconnect calendar' });
      setTimeout(() => setMessage(null), 5000);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-panel">
        <div className="settings-header">
          <button
            type="button"
            className="icon-btn settings-back-btn"
            onClick={() => navigate("/chat")}
            title="Back to chats"
          >
            <BackIcon />
          </button>
          <span className="settings-title">Settings</span>
        </div>

        <div className="settings-body">
          {message && (
            <div className={`settings-message settings-message-${message.type}`}>
              {message.text}
            </div>
          )}

          <div className="settings-section">
            <h2 className="settings-section-title">
              <CalendarIcon />
              Google Calendar Integration
            </h2>
            <p className="settings-section-description">
              Connect your Google Calendar to automatically sync action items from meeting transcripts.
            </p>

            {loading && (
              <div className="settings-loading">
                <div className="spinner" />
              </div>
            )}

            {!loading && calendarStatus && (
              <div className="calendar-status">
                {calendarStatus.connected ? (
                  <div className="calendar-connected">
                    <div className="calendar-info">
                      <div className="calendar-status-badge calendar-status-connected">
                        ✓ Connected
                      </div>
                      <div className="calendar-email">{calendarStatus.email}</div>
                      <div className="calendar-connected-date">
                        Connected {new Date(calendarStatus.connectedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="settings-btn settings-btn-danger"
                      onClick={handleDisconnectCalendar}
                      disabled={disconnecting}
                    >
                      {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  </div>
                ) : (
                  <div className="calendar-disconnected">
                    <div className="calendar-info">
                      <div className="calendar-status-badge calendar-status-disconnected">
                        ○ Not connected
                      </div>
                      <p className="calendar-benefits">
                        When connected, action items from your calls will automatically sync to your Google Calendar after each meeting ends:
                      </p>
                      <ul className="calendar-features">
                        <li>📋 Auto-create events for each action item</li>
                        <li>⏰ Set reminders based on deadlines</li>
                        <li>🎨 Color-code by priority (High, Medium, Low)</li>
                        <li>👤 Include owner and context in event details</li>
                      </ul>
                    </div>
                    <button
                      type="button"
                      className="settings-btn settings-btn-primary"
                      onClick={handleConnectCalendar}
                      disabled={connecting}
                    >
                      {connecting ? 'Connecting...' : '📅 Connect Google Calendar'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Placeholder for future settings sections */}
          <div className="settings-section">
            <h2 className="settings-section-title">Account</h2>
            <div className="settings-item">
              <span>Username: {user?.username}</span>
            </div>
            <div className="settings-item">
              <span>Email: {user?.email}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
