import React, { useEffect, useRef, useState } from "react";
import { useProfileModal } from "../context/Profilemodalcontext";
import { useAuth } from "../context/Authcontext";
import { useSocket } from "../context/Socketcontext";
import {
  updateProfile,
  blockUser,
  unblockUser,
  muteUser,
  unmuteUser,
  setDisappearing,
  getMedia,
} from "../api";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatLastSeen } from "../utils/formatLastSeen";
import BlockedContacts from "./BlockedContacts";
import MediaGallery from "./MediaGallery";
import StarredMessages from "./StarredMessages";

// WhatsApp's disappearing-message presets, in milliseconds.
const DISAPPEARING_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "24 hours", value: 86400000 },
  { label: "7 days", value: 604800000 },
  { label: "90 days", value: 7776000000 },
];

export default function ProfileModal() {
  const { profileUser, isOwnProfile, closeProfile, updateProfileStatus } = useProfileModal();
  const { user: me, setUser } = useAuth();
  const socket = useSocket();

  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [about, setAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [muting, setMuting] = useState(false);
  const [savingDisappearing, setSavingDisappearing] = useState(false);
  const [showBlockedList, setShowBlockedList] = useState(false);
  const [showMediaGallery, setShowMediaGallery] = useState(false);
  const [showStarred, setShowStarred] = useState(false);
  const [showDisappearingChooser, setShowDisappearingChooser] = useState(false);

  // Small "3 items · 2 photos" style preview shown on the "Media, links
  // and docs" row before the person taps into the full gallery.
  const [mediaPreview, setMediaPreview] = useState({ loading: true, items: [], total: 0 });

  const fileInputRef = useRef(null);

  // Reset local edit state whenever a (possibly different) profile is opened
  useEffect(() => {
    if (profileUser) {
      setUsername(profileUser.username || "");
      setAbout(profileUser.about || "");
      setEditing(false);
      setError("");
      setAvatarPreview(null);
      setShowBlockedList(false);
      setShowMediaGallery(false);
      setShowStarred(false);
      setShowDisappearingChooser(false);
    }
  }, [profileUser]);

  // Fetch a small media preview for the "Media, links and docs" row.
  useEffect(() => {
    if (!profileUser || isOwnProfile) return;
    let isCurrent = true;
    setMediaPreview({ loading: true, items: [], total: 0 });
    getMedia(profileUser._id)
      .then((res) => {
        if (!isCurrent) return;
        const media = res.data.media || [];
        setMediaPreview({ loading: false, items: media.slice(0, 3), total: media.length });
      })
      .catch((err) => {
        console.error("Failed to load media preview:", err);
        if (isCurrent) setMediaPreview({ loading: false, items: [], total: 0 });
      });
    return () => {
      isCurrent = false;
    };
  }, [profileUser, isOwnProfile]);

  // Keep the block/mute/disappearing state live if it changes elsewhere
  // (another tab, or the other person changing disappearing messages).
  useEffect(() => {
    if (!socket || !profileUser || isOwnProfile) return;

    const handleBlocked = ({ userId }) => {
      updateProfileStatus(userId, { isBlocked: true });
    };
    const handleUnblocked = ({ userId }) => {
      updateProfileStatus(userId, { isBlocked: false });
    };
    const handleDisappearingChanged = ({ userId, duration }) => {
      updateProfileStatus(userId, { disappearingDuration: duration });
    };

    socket.on("contactBlocked", handleBlocked);
    socket.on("contactUnblocked", handleUnblocked);
    socket.on("disappearingChanged", handleDisappearingChanged);

    return () => {
      socket.off("contactBlocked", handleBlocked);
      socket.off("contactUnblocked", handleUnblocked);
      socket.off("disappearingChanged", handleDisappearingChanged);
    };
  }, [socket, profileUser, isOwnProfile, updateProfileStatus]);

  // Close on Escape
  useEffect(() => {
    if (!profileUser) return;
    const onKey = (e) => e.key === "Escape" && closeProfile();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileUser, closeProfile]);

  // Keep the open profile's online/offline status live, same as Sidebar/ChatWindow
  useEffect(() => {
    if (!socket || !profileUser || isOwnProfile) return;

    const handleOnline = ({ userId }) => {
      updateProfileStatus(userId, { isOnline: true });
    };

    const handleOffline = ({ userId, lastSeen }) => {
      updateProfileStatus(userId, { isOnline: false, lastSeen });
    };

    socket.on("userOnline", handleOnline);
    socket.on("userOffline", handleOffline);

    return () => {
      socket.off("userOnline", handleOnline);
      socket.off("userOffline", handleOffline);
    };
  }, [socket, profileUser, isOwnProfile, updateProfileStatus]);

  if (!profileUser) return null;

  const handleAvatarClick = () => {
    if (isOwnProfile) fileInputRef.current?.click();
  };

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const localPreview = URL.createObjectURL(file);
    setAvatarPreview(localPreview);
    setError("");

    const formData = new FormData();
    formData.append("avatar", file);

    try {
      setUploadingAvatar(true);
      const res = await updateProfile(formData);
      setUser(res.data.user);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to upload photo");
    } finally {
      setUploadingAvatar(false);
      URL.revokeObjectURL(localPreview);
      setAvatarPreview(null);
      e.target.value = "";
    }
  };

  const handleSave = async () => {
    if (!username.trim()) {
      setError("Name can't be empty");
      return;
    }
    setError("");

    const formData = new FormData();
    formData.append("username", username.trim());
    formData.append("about", about.trim());

    try {
      setSaving(true);
      const res = await updateProfile(formData);
      setUser(res.data.user);
      setEditing(false);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setUsername(profileUser.username || "");
    setAbout(profileUser.about || "");
    setError("");
    setEditing(false);
  };

  // Block/unblock the person whose profile is open. Works from a contact's
  // "Contact info" screen, any time — matches WhatsApp's block/unblock flow.
  const handleToggleBlock = async () => {
    if (!profileUser || isOwnProfile) return;
    setError("");
    setBlocking(true);
    try {
      if (profileUser.isBlocked) {
        await unblockUser(profileUser._id);
        updateProfileStatus(profileUser._id, { isBlocked: false });
      } else {
        await blockUser(profileUser._id);
        updateProfileStatus(profileUser._id, { isBlocked: true });
      }
    } catch (err) {
      setError(err.response?.data?.message || "Something went wrong");
    } finally {
      setBlocking(false);
    }
  };

  const handleToggleMute = async () => {
    if (!profileUser || isOwnProfile) return;
    setError("");
    setMuting(true);
    try {
      if (profileUser.isMuted) {
        await unmuteUser(profileUser._id);
        updateProfileStatus(profileUser._id, { isMuted: false });
      } else {
        await muteUser(profileUser._id);
        updateProfileStatus(profileUser._id, { isMuted: true });
      }
    } catch (err) {
      setError(err.response?.data?.message || "Something went wrong");
    } finally {
      setMuting(false);
    }
  };

  const handleChooseDisappearing = async (duration) => {
    if (!profileUser || isOwnProfile) return;
    setSavingDisappearing(true);
    try {
      await setDisappearing(profileUser._id, duration);
      updateProfileStatus(profileUser._id, { disappearingDuration: duration });
      setShowDisappearingChooser(false);
    } catch (err) {
      setError(err.response?.data?.message || "Couldn't update disappearing messages");
    } finally {
      setSavingDisappearing(false);
    }
  };

  const displayAvatar = avatarPreview || resolveAvatarUrl(profileUser.avatar);

  // WhatsApp shows a contact's presence (last seen / online) right under
  // their name, in the same spot it would show a phone number.
  const subtitle = isOwnProfile
    ? profileUser.email
    : profileUser.isBlocked
    ? "Blocked"
    : profileUser.isOnline
    ? "Online"
    : formatLastSeen(profileUser.lastSeen);

  const disappearingLabel =
    DISAPPEARING_OPTIONS.find((o) => o.value === (profileUser.disappearingDuration || 0))
      ?.label || "Off";

  // ---- Sub-screens (each one is its own back-navigable "page") ----

  if (isOwnProfile && showBlockedList) {
    return (
      <div className="modal-overlay" onClick={closeProfile}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="profile-modal-header">
            <button className="modal-back-btn" onClick={() => setShowBlockedList(false)} title="Back">
              ←
            </button>
            <span>Blocked contacts</span>
          </div>
          <BlockedContacts />
        </div>
      </div>
    );
  }

  if (!isOwnProfile && showMediaGallery) {
    return (
      <div className="modal-overlay" onClick={closeProfile}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="profile-modal-header">
            <button className="modal-back-btn" onClick={() => setShowMediaGallery(false)} title="Back">
              ←
            </button>
            <span>Media, links and docs</span>
          </div>
          <MediaGallery userId={profileUser._id} />
        </div>
      </div>
    );
  }

  if (!isOwnProfile && showStarred) {
    return (
      <div className="modal-overlay" onClick={closeProfile}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="profile-modal-header">
            <button className="modal-back-btn" onClick={() => setShowStarred(false)} title="Back">
              ←
            </button>
            <span>Starred messages</span>
          </div>
          <StarredMessages userId={profileUser._id} myId={me?._id} />
        </div>
      </div>
    );
  }

  if (!isOwnProfile && showDisappearingChooser) {
    return (
      <div className="modal-overlay" onClick={closeProfile}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="profile-modal-header">
            <button
              className="modal-back-btn"
              onClick={() => setShowDisappearingChooser(false)}
              title="Back"
            >
              ←
            </button>
            <span>Disappearing messages</span>
          </div>
          <div className="disappearing-chooser-body">
            <p className="disappearing-chooser-hint">
              New messages sent in this chat will disappear from it after the
              selected duration. Existing messages aren't affected.
            </p>
            {DISAPPEARING_OPTIONS.map((opt) => {
              const selected = (profileUser.disappearingDuration || 0) === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className="disappearing-option-row"
                  onClick={() => handleChooseDisappearing(opt.value)}
                  disabled={savingDisappearing}
                >
                  <span className="disappearing-option-label">{opt.label}</span>
                  {selected && <span className="disappearing-option-check">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ---- Main "Contact info" / "Profile" screen ----

  return (
    <div className="modal-overlay" onClick={closeProfile}>
      <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="profile-modal-header">
          <button className="modal-back-btn" onClick={closeProfile} title="Close">
            ←
          </button>
          <span>{isOwnProfile ? "Profile" : "Contact info"}</span>
        </div>

        <div className="profile-modal-body">
          <div
            className={`profile-avatar-wrapper ${isOwnProfile ? "editable" : ""}`}
            onClick={handleAvatarClick}
          >
            <img src={displayAvatar} alt={profileUser.username} className="profile-avatar-lg" />
            {isOwnProfile && (
              <div className="profile-avatar-overlay">
                {uploadingAvatar ? "Uploading..." : "📷 Change photo"}
              </div>
            )}
          </div>

          {isOwnProfile && (
            <input
              type="file"
              accept="image/png, image/jpeg, image/webp, image/gif"
              ref={fileInputRef}
              onChange={handleAvatarChange}
              style={{ display: "none" }}
            />
          )}

          {error && <div className="profile-error">{error}</div>}

          <div className="profile-identity">
            {isOwnProfile && editing ? (
              <input
                className="profile-name-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={20}
                autoFocus
              />
            ) : (
              <h2 className="profile-name">{profileUser.username}</h2>
            )}
            <p className="profile-subtitle">{subtitle}</p>
          </div>

          <div className="profile-divider" />

          <div className="profile-list-section">
            <div className="profile-list-row">
              <span className="profile-row-icon" aria-hidden="true">ⓘ</span>
              <div className="profile-row-content">
                <label>About</label>
                {isOwnProfile && editing ? (
                  <textarea
                    value={about}
                    onChange={(e) => setAbout(e.target.value)}
                    maxLength={140}
                    rows={2}
                  />
                ) : (
                  <p>{profileUser.about || "Hey there! I am using ChatApp"}</p>
                )}
              </div>
            </div>
          </div>

          <div className="profile-divider" />

          {isOwnProfile && (
            <div className="profile-list-section">
              {editing ? (
                <div className="profile-edit-actions">
                  <button className="profile-btn-secondary" onClick={handleCancel} disabled={saving}>
                    Cancel
                  </button>
                  <button className="profile-btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              ) : (
                <>
                  <button className="profile-list-row profile-row-button" onClick={() => setEditing(true)}>
                    <span className="profile-row-icon" aria-hidden="true">✎</span>
                    <span className="profile-row-label">Edit profile</span>
                  </button>
                  <button
                    className="profile-list-row profile-row-button"
                    onClick={() => setShowBlockedList(true)}
                  >
                    <span className="profile-row-icon" aria-hidden="true">⛔</span>
                    <span className="profile-row-label">Blocked contacts</span>
                    <span className="profile-row-chevron" aria-hidden="true">›</span>
                  </button>
                </>
              )}
            </div>
          )}

          {!isOwnProfile && (
            <>
              {/* Media, links and docs */}
              <button
                className="profile-list-row profile-row-button profile-media-row"
                onClick={() => setShowMediaGallery(true)}
              >
                <span className="profile-row-icon" aria-hidden="true">🖼️</span>
                <span className="profile-row-label">Media, links and docs</span>
                <span className="profile-row-trailing">
                  {!mediaPreview.loading && (
                    <span className="profile-row-count">
                      {mediaPreview.total}
                      {mediaPreview.total >= 60 ? "+" : ""}
                    </span>
                  )}
                  <span className="profile-row-chevron" aria-hidden="true">›</span>
                </span>
              </button>
              {mediaPreview.items.length > 0 && (
                <div className="profile-media-strip">
                  {mediaPreview.items.map((m) => (
                    <div key={m._id} className="profile-media-strip-thumb">
                      {m.type === "image" ? (
                        <img src={resolveAvatarUrl(m.attachment.url)} alt="" />
                      ) : m.type === "video" ? (
                        <video src={resolveAvatarUrl(m.attachment.url)} muted preload="metadata" />
                      ) : (
                        <span className="profile-media-strip-doc">📄</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="profile-divider" />

              {/* Starred messages */}
              <div className="profile-list-section">
                <button className="profile-list-row profile-row-button" onClick={() => setShowStarred(true)}>
                  <span className="profile-row-icon" aria-hidden="true">★</span>
                  <span className="profile-row-label">Starred messages</span>
                  <span className="profile-row-chevron" aria-hidden="true">›</span>
                </button>

                {/* Mute notifications */}
                <div className="profile-list-row">
                  <span className="profile-row-icon" aria-hidden="true">🔔</span>
                  <span className="profile-row-label">Mute notifications</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(profileUser.isMuted)}
                    className={`profile-toggle${profileUser.isMuted ? " on" : ""}`}
                    onClick={handleToggleMute}
                    disabled={muting}
                  >
                    <span className="profile-toggle-knob" />
                  </button>
                </div>

                {/* Disappearing messages */}
                <button
                  className="profile-list-row profile-row-button"
                  onClick={() => setShowDisappearingChooser(true)}
                >
                  <span className="profile-row-icon" aria-hidden="true">⏱️</span>
                  <span className="profile-row-label">Disappearing messages</span>
                  <span className="profile-row-trailing">
                    <span className="profile-row-count">{disappearingLabel}</span>
                    <span className="profile-row-chevron" aria-hidden="true">›</span>
                  </span>
                </button>
              </div>

              <div className="profile-divider" />

              <div className="profile-list-section">
                <button
                  className="profile-list-row profile-row-button profile-row-danger"
                  onClick={handleToggleBlock}
                  disabled={blocking}
                >
                  <span className="profile-row-icon" aria-hidden="true">⛔</span>
                  <span className="profile-row-label">
                    {blocking
                      ? "Please wait..."
                      : profileUser.isBlocked
                      ? `Unblock ${profileUser.username}`
                      : `Block ${profileUser.username}`}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}