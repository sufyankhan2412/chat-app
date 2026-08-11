import React, { useEffect, useRef, useState } from "react";
import { useProfileModal } from "../context/Profilemodalcontext";
import { useAuth } from "../context/Authcontext";
import { useSocket } from "../context/Socketcontext";
import { updateProfile, blockUser, unblockUser } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatLastSeen } from "../utils/formatLastSeen";
import BlockedContacts from "./BlockedContacts";

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
  const [blocking, setBlocking] = useState(false);
  const [showBlockedList, setShowBlockedList] = useState(false);
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
    }
  }, [profileUser]);

  // Keep the block state live if it changes elsewhere (e.g. unblocked from
  // the "Blocked contacts" list while this same profile happens to be open).
  useEffect(() => {
    if (!socket || !profileUser || isOwnProfile) return;

    const handleBlocked = ({ userId }) => {
      updateProfileStatus(userId, { isBlocked: true });
    };
    const handleUnblocked = ({ userId }) => {
      updateProfileStatus(userId, { isBlocked: false });
    };

    socket.on("contactBlocked", handleBlocked);
    socket.on("contactUnblocked", handleUnblocked);

    return () => {
      socket.off("contactBlocked", handleBlocked);
      socket.off("contactUnblocked", handleUnblocked);
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

  const displayAvatar = avatarPreview || resolveAvatarUrl(profileUser.avatar);

  if (isOwnProfile && showBlockedList) {
    return (
      <div className="modal-overlay" onClick={closeProfile}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="profile-modal-header">
            <button
              className="modal-back-btn"
              onClick={() => setShowBlockedList(false)}
              title="Back"
            >
              ←
            </button>
            <span>Blocked contacts</span>
          </div>
          <BlockedContacts />
        </div>
      </div>
    );
  }

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
                {profileUser.isBlocked
                  ? "Blocked"
                  : profileUser.isOnline
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
                <>
                  <button
                    className="profile-btn-secondary"
                    onClick={() => setShowBlockedList(true)}
                  >
                    Blocked contacts
                  </button>
                  <button
                    className="profile-btn-primary"
                    onClick={() => setEditing(true)}
                  >
                    Edit Profile
                  </button>
                </>
              )}
            </div>
          )}

          {!isOwnProfile && (
            <div className="profile-actions">
              <button
                className={profileUser.isBlocked ? "profile-btn-secondary" : "profile-btn-danger"}
                onClick={handleToggleBlock}
                disabled={blocking}
              >
                {blocking
                  ? "Please wait..."
                  : profileUser.isBlocked
                  ? `Unblock ${profileUser.username}`
                  : `Block ${profileUser.username}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}