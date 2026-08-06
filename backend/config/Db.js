const mongoose = require("mongoose");
const User = require("../models/User");

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/socket-chat";

  try {
    const conn = await mongoose.connect(mongoUri);
    console.log(`MongoDB connected: ${conn.connection.host}`);

    // The server's in-memory "who's online" map (see socket/Socketmanager.js)
    // always starts empty on boot, but MongoDB's isOnline flags persist across
    // restarts. Without this, anyone who was online right before a restart
    // (e.g. nodemon reloading, a redeploy) stays stuck "online" forever, even
    // through a later logout, since there's no live socket left to catch a
    // disconnect for them. Resetting here keeps the two in sync: anyone still
    // genuinely connected re-marks themselves online the moment their socket
    // reconnects.
    await User.updateMany({ isOnline: true }, { isOnline: false });
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    console.warn("Continuing without a live MongoDB connection for local development.");
  }
};

module.exports = connectDB;