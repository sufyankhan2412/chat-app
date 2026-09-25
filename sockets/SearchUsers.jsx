import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { searchUsers, addContact } from "./api";
import { resolveAvatarUrl } from "./utils/avatar";

const dropdownVariants = {
  hidden: { 
    opacity: 0, 
    y: -10,
    scale: 0.95
  },
  visible: { 
    opacity: 1, 
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 300,
      damping: 25,
      staggerChildren: 0.05
    }
  },
  exit: { 
    opacity: 0, 
    y: -10,
    scale: 0.95,
    transition: { duration: 0.2 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: { 
    opacity: 1, 
    x: 0,
    transition: {
      type: "spring",
      stiffness: 300,
      damping: 25
    }
  }
};

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
      <motion.input
        type="text"
        placeholder="🔍 Search users to add..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => query && setOpen(true)}
        whileFocus={{ scale: 1.01 }}
        transition={{ type: "spring", stiffness: 300 }}
      />
      <AnimatePresence>
        {open && results.length > 0 && (
          <motion.div 
            className="search-dropdown"
            variants={dropdownVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {results.map((u) => (
              <motion.div 
                className="search-result-item" 
                key={u._id}
                variants={itemVariants}
                whileHover={{ 
                  x: 4,
                  backgroundColor: "#f0f2f5",
                  transition: { duration: 0.2 }
                }}
              >
                <motion.img 
                  src={resolveAvatarUrl(u.avatar)} 
                  alt={u.username} 
                  className="avatar-sm"
                  whileHover={{ scale: 1.1, rotate: 5 }}
                />
                <span className="search-username">{u.username}</span>
                <motion.button
                  className="add-btn"
                  disabled={addingId === u._id}
                  onClick={() => handleAdd(u)}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  {addingId === u._id ? "⏳" : "➕ Add"}
                </motion.button>
              </motion.div>
            ))}
          </motion.div>
        )}
        {open && query && results.length === 0 && (
          <motion.div 
            className="search-dropdown"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <div className="search-no-results">🔍 No users found</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}