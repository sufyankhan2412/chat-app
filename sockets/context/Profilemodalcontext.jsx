import React, { createContext, useContext, useState, useCallback } from "react";
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

  return (
    <ProfileModalContext.Provider
      value={{
        profileUser,
        isOwnProfile,
        loading,
        openOwnProfile,
        openUserProfile,
        closeProfile,
      }}
    >
      {children}
    </ProfileModalContext.Provider>
  );
};