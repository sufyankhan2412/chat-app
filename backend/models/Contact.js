const mongoose = require("mongoose");

// Each document represents "user" having "contact" in their chat list.
// We create one document per direction (mutual) when a contact is added,
// so each user's contact list is a simple, independent query.
const contactSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Prevent the same contact being added twice for the same user
contactSchema.index({ user: 1, contact: 1 }, { unique: true });

module.exports = mongoose.model("Contact", contactSchema);