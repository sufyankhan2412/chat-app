import React, { useEffect, useState } from "react";
import { getBlockedUsers, unblockUser } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";

// WhatsApp-style "Blocked contacts" list: shown from your own profile so you
// can unblock anyone, any time, without having to find them via search first.
export default function BlockedContacts() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unblockingId, setUnblockingId] = useState(null);

  useEffect(() => {
    let isCurrent = true;
    const fetchBlocked = async () => {
      try {
        const res = await getBlockedUsers();
        if (isCurrent) setUsers(res.data.users);
      } catch (err) {
        console.error("Failed to fetch blocked users:", err);
      } finally {
        if (isCurrent) setLoading(false);
      }
    };
    fetchBlocked();
    return () => {
      isCurrent = false;
    };
  }, []);

  const handleUnblock = async (id) => {
    setUnblockingId(id);
    try {
      await unblockUser(id);
      setUsers((prev) => prev.filter((u) => String(u._id) !== String(id)));
    } catch (err) {
      console.error("Failed to unblock:", err);
    } finally {
      setUnblockingId(null);
    }
  };

  return (
    <div className="blocked-contacts-body">
      {loading && (
        <div className="messages-loading">
          <div className="spinner" />
        </div>
      )}

      {!loading && users.length === 0 && (
        <div className="empty-state">You haven't blocked anyone</div>
      )}

      {!loading &&
        users.map((u) => (
          <div key={u._id} className="blocked-contact-row">
            <img src={resolveAvatarUrl(u.avatar)} alt={u.username} className="avatar-md" />
            <span className="blocked-contact-name">{u.username}</span>
            <button
              className="profile-btn-secondary"
              onClick={() => handleUnblock(u._id)}
              disabled={unblockingId === u._id}
            >
              {unblockingId === u._id ? "..." : "Unblock"}
            </button>
          </div>
        ))}
    </div>
  );
}