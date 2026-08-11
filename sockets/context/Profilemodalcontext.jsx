import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import { getUserProfile } from "../api";

const ProfileModalContext = createContext();

export const useProfileModal = () => useContext(ProfileModalContext);

export const ProfileModalProvider = ({ children }) => {
  // profileUser: the user object currently shown in the modal, or null when closed
  const [profileUser, setProfileUser] = useState(null);
  const [isOwnProfile, setIsOwnProfile] = useState(false);
  const [loading, setLoading] = useState(false);

  // Open the logged-in user's own (editable) profile
  const openOwnProfile = useCallback((user) => {
    setIsOwnProfile(true);
    setProfileUser(user);
  }, []);

  // Open someone else's (read-only) profile. Accepts either a full user
  // object (for an instant preview) or just an id, then fetches the latest
  // details from the server.
  const openUserProfile = useCallback(async (userOrId) => {
    setIsOwnProfile(false);
    const id = typeof userOrId === "object" ? userOrId._id : userOrId;

    if (typeof userOrId === "object") {
      setProfileUser(userOrId);
    }

    try {
      setLoading(true);
      const res = await getUserProfile(id);
      setProfileUser(res.data.user);
    } catch (err) {
      console.error("Failed to load profile:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const closeProfile = useCallback(() => {
    setProfileUser(null);
    setIsOwnProfile(false);
  }, []);

  // Patch just the online/offline status of whichever profile is currently
  // open, without refetching. No-ops if that profile isn't the one open.
  const updateProfileStatus = useCallback((userId, status) => {
    setProfileUser((prev) => {
      if (!prev || String(prev._id) !== String(userId)) return prev;
      return { ...prev, ...status };
    });
  }, []);

  // Memoized so that toggling something inside the modal (mute, block,
  // disappearing messages, etc.) doesn't hand every other consumer of this
  // context — Sidebar, ChatWindow — a brand-new object reference and force
  // them to re-render too. That extra churn is what produced the visible
  // "jerk" elsewhere in the app whenever a button was clicked in Contact info.
  const value = useMemo(
    () => ({
      profileUser,
      isOwnProfile,
      loading,
      openOwnProfile,
      openUserProfile,
      closeProfile,
      updateProfileStatus,
    }),
    [profileUser, isOwnProfile, loading, openOwnProfile, openUserProfile, closeProfile, updateProfileStatus]
  );

  return (
    <ProfileModalContext.Provider value={value}>
      {children}
    </ProfileModalContext.Provider>
  );
};