import React, { useEffect, useRef, useState } from "react";
import { useProfileModal } from "../context/Profilemodalcontext";
import { useAuth } from "../context/Authcontext";
import { useSocket } from "../context/Socketcontext";
import { updateProfile } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatLastSeen } from "../utils/formatLastSeen";

export default function ProfileModal() {
  const { profileUser, isOwnProfile, closeProfile, updateProfileStatus } = useProfileModal();
  const { setUser } = useAuth();
  const socket = useSocket();

  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [about, setAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef(null);

  // Reset local edit state whenever a (possibly different) profile is opened
  useEffect(() => {
    if (profileUser) {
      setUsername(profileUser.username || "");
      setAbout(profileUser.about || "");
      setEditing(false);
      setError("");
      setAvatarPreview(null);
    }
  }, [profileUser]);

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

  const displayAvatar = avatarPreview || resolveAvatarUrl(profileUser.avatar);

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
            <img
              src={displayAvatar}
              alt={profileUser.username}
              className="profile-avatar-lg"
            />
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

          <div className="profile-field">
            <label>Name</label>
            {isOwnProfile && editing ? (
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={20}
                autoFocus
              />
            ) : (
              <p>{profileUser.username}</p>
            )}
          </div>

          {isOwnProfile && (
            <div className="profile-field">
              <label>Email</label>
              <p className="profile-field-static">{profileUser.email}</p>
            </div>
          )}

          <div className="profile-field">
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

          {!isOwnProfile && (
            <div className="profile-field">
              <label>Status</label>
              <p>
                {profileUser.isOnline
                  ? "Online"
                  : formatLastSeen(profileUser.lastSeen)}
              </p>
            </div>
          )}

          {isOwnProfile && (
            <div className="profile-actions">
              {editing ? (
                <>
                  <button
                    className="profile-btn-secondary"
                    onClick={handleCancel}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    className="profile-btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </>
              ) : (
                <button
                  className="profile-btn-primary"
                  onClick={() => setEditing(true)}
                >
                  Edit Profile
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}