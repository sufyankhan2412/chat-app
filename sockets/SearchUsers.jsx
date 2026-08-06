import React, { useState, useEffect, useRef } from "react";
import { searchUsers, addContact } from "./api";
import { resolveAvatarUrl } from "./utils/avatar";

export default function SearchUsers({ onContactAdded }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [addingId, setAddingId] = useState(null);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchUsers(query.trim());
        setResults(res.data.users);
        setOpen(true);
      } catch (err) {
        console.error(err);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleAdd = async (userToAdd) => {
    setAddingId(userToAdd._id);
    try {
      const res = await addContact(userToAdd._id);
      onContactAdded(res.data.contact);
      setQuery("");
      setResults([]);
      setOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setAddingId(null);
    }
  };

  return (
    <div className="search-users" ref={wrapperRef}>
      <input
        type="text"
        placeholder="Search users to add..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => query && setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((u) => (
            <div className="search-result-item" key={u._id}>
              <img src={resolveAvatarUrl(u.avatar)} alt={u.username} className="avatar-sm" />
              <span className="search-username">{u.username}</span>
              <button
                className="add-btn"
                disabled={addingId === u._id}
                onClick={() => handleAdd(u)}
              >
                {addingId === u._id ? "Adding..." : "Add"}
              </button>
            </div>
          ))}
        </div>
      )}
      {open && query && results.length === 0 && (
        <div className="search-dropdown">
          <div className="search-no-results">No users found</div>
        </div>
      )}
    </div>
  );
}