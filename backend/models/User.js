const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    avatar: {
      type: String,
      default: function () {
        return `https://api.dicebear.com/7.x/initials/svg?seed=${this.username}`;
      },
    },
    about: {
      type: String,
      default: "Hey there! I am using ChatApp",
      maxlength: 140,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    // Users this account has blocked. One-directional (like WhatsApp): I stop
    // getting their messages and stop being able to send them mine, but it
    // doesn't affect their own contact list or blockedUsers array.
    blockedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: [],
      },
    ],

    // Contacts whose messages shouldn't trigger a notification for me.
    // One-directional and purely local to this account, like WhatsApp's
    // per-chat mute — it doesn't stop messages from arriving, just alerts.
    mutedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: [],
      },
    ],
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.toSafeObject = function () {
  return {
    _id: this._id,
    username: this.username,
    email: this.email,
    avatar: this.avatar,
    about: this.about,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
  };
};

module.exports = mongoose.model("User", userSchema);