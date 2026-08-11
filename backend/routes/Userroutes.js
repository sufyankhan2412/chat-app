const express = require("express");
const fs = require("fs");
const path = require("path");
const User = require("../models/User");
const Contact = require("../models/Contact");
const Message = require("../models/Message");
const { protect } = require("../middleware/Authmiddleware");
const { uploadAvatar, avatarsDir } = require("../middleware/upload");

const router = express.Router();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// @route  GET /api/users/search?q=term
// Search all users by username or email (excluding self), used by the search bar
router.get("/search", protect, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ users: [] });

    const regex = new RegExp(escapeRegex(q), "i");
    const users = await User.find({
      _id: { $ne: req.user._id },
      $or: [{ username: regex }, { email: regex }],
    })
      .select("username email avatar isOnline lastSeen")
      .limit(20);

    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/users/contacts/:id
// Add a user (found via search) to my contact/chat list.
// Creates a Contact doc in both directions so both users see the thread.
router.post("/contacts/:id", protect, async (req, res) => {
  try {
    const targetId = req.params.id;
    const myId = req.user._id;

    if (targetId === String(myId)) {
      return res.status(400).json({ message: "You cannot add yourself" });
    }

    const targetUser = await User.findById(targetId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // upsert both directions, ignoring duplicates via unique index
    await Contact.findOneAndUpdate(
      { user: myId, contact: targetId },
      { user: myId, contact: targetId },
      { upsert: true, new: true }
    );
    await Contact.findOneAndUpdate(
      { user: targetId, contact: myId },
      { user: targetId, contact: myId },
      { upsert: true, new: true }
    );

    res.json({ contact: targetUser.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/users/contacts
// List my existing chat contacts and recent chat partners
router.get("/contacts", protect, async (req, res) => {
  try {
    const contactDocs = await Contact.find({ user: req.user._id }).populate(
      "contact",
      "username email avatar isOnline lastSeen"
    );

    const contactIds = contactDocs.map((c) => String(c.contact._id));

    const messages = await Message.find({
      $or: [
        { sender: req.user._id },
        { receiver: req.user._id },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();

    const lastMessageMap = new Map();
    const messagePartnerIds = new Set(contactIds);

    messages.forEach((msg) => {
      const otherId = String(msg.sender) === String(req.user._id)
        ? String(msg.receiver)
        : String(msg.sender);

      messagePartnerIds.add(otherId);
      if (!lastMessageMap.has(otherId)) {
        lastMessageMap.set(otherId, msg);
      }
    });

    const allPartnerIds = Array.from(messagePartnerIds);
    const users = await User.find({ _id: { $in: allPartnerIds } })
      .select("username email avatar isOnline lastSeen")
      .lean();

    const usersById = new Map(users.map((u) => [String(u._id), u]));
    const blockedIds = new Set(
      (req.user.blockedUsers || []).map((id) => String(id))
    );

    const contacts = allPartnerIds
      .map((id) => {
        const user = usersById.get(id);
        if (!user) return null;
        return {
          ...user,
          lastMessage: lastMessageMap.get(id) || null,
          isBlocked: blockedIds.has(id),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aDate = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt) : new Date(0);
        const bDate = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt) : new Date(0);
        return bDate - aDate;
      });

    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  PUT /api/users/profile
// Update my own profile: username, "about" text, and/or a locally-uploaded avatar
router.put(
  "/profile",
  protect,
  (req, res, next) => {
    uploadAvatar.single("avatar")(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const { username, about } = req.body;

      if (typeof username === "string" && username.trim()) {
        const trimmed = username.trim();
        if (trimmed !== user.username) {
          const taken = await User.findOne({
            username: trimmed,
            _id: { $ne: user._id },
          });
          if (taken) {
            return res.status(400).json({ message: "Username already taken" });
          }
          user.username = trimmed;
        }
      }

      if (typeof about === "string") {
        user.about = about.slice(0, 140);
      }

      if (req.file) {
        // Clean up the old avatar file, but only if it was a local upload
        // (skip the auto-generated dicebear URL new users start with)
        if (user.avatar && user.avatar.startsWith("/uploads/avatars/")) {
          const oldPath = path.join(avatarsDir, path.basename(user.avatar));
          fs.unlink(oldPath, () => {});
        }
        user.avatar = `/uploads/avatars/${req.file.filename}`;
      }

      await user.save();
      res.json({ user: user.toSafeObject() });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @route  POST /api/users/block/:id
// Block a user, WhatsApp-style: I stop receiving their messages and can't
// send them mine, but their contact list/blocked list is untouched.
router.post("/block/:id", protect, async (req, res) => {
  try {
    const targetId = req.params.id;

    if (targetId === String(req.user._id)) {
      return res.status(400).json({ message: "You cannot block yourself" });
    }

    const targetUser = await User.findById(targetId).select(
      "username email avatar isOnline lastSeen"
    );
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { blockedUsers: targetId },
    });

    // Let this user's other open tabs/devices know instantly
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.user._id}`).emit("contactBlocked", { userId: targetId });
    }

    res.json({ user: targetUser, isBlocked: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/users/unblock/:id
// Reverse of the above — can be done any time from the contact's profile
// or from the "Blocked contacts" list.
router.post("/unblock/:id", protect, async (req, res) => {
  try {
    const targetId = req.params.id;

    const targetUser = await User.findById(targetId).select(
      "username email avatar isOnline lastSeen"
    );
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    await User.findByIdAndUpdate(req.user._id, {
      $pull: { blockedUsers: targetId },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.user._id}`).emit("contactUnblocked", { userId: targetId });
    }

    res.json({ user: targetUser, isBlocked: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/users/blocked
// List everyone I've blocked, for the "Blocked contacts" screen.
router.get("/blocked", protect, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).populate(
      "blockedUsers",
      "username email avatar isOnline lastSeen"
    );
    res.json({ users: me?.blockedUsers || [] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/users/mute/:id
// Mute a contact's notifications. Purely local to my account — the other
// person is never told and their messages still arrive as normal.
router.post("/mute/:id", protect, async (req, res) => {
  try {
    const targetId = req.params.id;

    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { mutedUsers: targetId },
    });

    res.json({ isMuted: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  POST /api/users/unmute/:id
router.post("/unmute/:id", protect, async (req, res) => {
  try {
    const targetId = req.params.id;

    await User.findByIdAndUpdate(req.user._id, {
      $pull: { mutedUsers: targetId },
    });

    res.json({ isMuted: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Allowed "disappearing messages" durations, in milliseconds (WhatsApp's
// own preset list: 24 hours / 7 days / 90 days, or 0 for off).
const DISAPPEARING_DURATIONS = [0, 86400000, 604800000, 7776000000];

// @route  PUT /api/users/contacts/:id/disappearing
// Turn disappearing messages on/off for this chat. Shared like WhatsApp:
// written to both directions' Contact docs so either person sees the same
// setting, and the other person's open tab is notified live.
router.put("/contacts/:id/disappearing", protect, async (req, res) => {
  try {
    const targetId = req.params.id;
    const duration = Number(req.body.duration);

    if (!DISAPPEARING_DURATIONS.includes(duration)) {
      return res.status(400).json({ message: "Invalid duration" });
    }

    await Contact.findOneAndUpdate(
      { user: req.user._id, contact: targetId },
      { user: req.user._id, contact: targetId, disappearingDuration: duration },
      { upsert: true }
    );
    await Contact.findOneAndUpdate(
      { user: targetId, contact: req.user._id },
      { user: targetId, contact: req.user._id, disappearingDuration: duration },
      { upsert: true }
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`user_${targetId}`).emit("disappearingChanged", {
        userId: String(req.user._id),
        duration,
      });
    }

    res.json({ duration });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route  GET /api/users/:id
// View another user's public profile (e.g. tapping their name/avatar in a chat)
// NOTE: keep this registered last so it doesn't swallow the routes above
router.get("/:id", protect, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.id).select(
      "username avatar about isOnline lastSeen"
    );
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const isBlocked = (req.user.blockedUsers || []).some(
      (id) => String(id) === String(targetUser._id)
    );
    const isMuted = (req.user.mutedUsers || []).some(
      (id) => String(id) === String(targetUser._id)
    );

    const contactDoc = await Contact.findOne({
      user: req.user._id,
      contact: targetUser._id,
    }).select("disappearingDuration");

    res.json({
      user: {
        ...targetUser.toObject(),
        isBlocked,
        isMuted,
        disappearingDuration: contactDoc?.disappearingDuration || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;