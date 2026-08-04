const express = require("express");
const User = require("../models/User");
const Contact = require("../models/Contact");
const Message = require("../models/Message");
const { protect } = require("../middleware/authMiddleware");

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

    const contacts = allPartnerIds
      .map((id) => {
        const user = usersById.get(id);
        if (!user) return null;
        return {
          ...user,
          lastMessage: lastMessageMap.get(id) || null,
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

module.exports = router;