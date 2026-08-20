require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");

const connectDB = require("./config/Db");
const { initSocket } = require("./socket/Socketmanager");

const authRoutes = require("./routes/Authroutes");
const userRoutes = require("./routes/Userroutes");
const messageRoutes = require("./routes/Messageroutes");
const callRoutes = require("./routes/Callroutes");

const app = express();
const server = http.createServer(app);

// Allowed frontend URLs
const allowedOrigins = [
  "http://localhost:5173",
  "https://2x7n90c5-5173.asse.devtunnels.ms",
  "http://192.168.18.79:5173",
];
// Socket.IO
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json());

// Give REST routes access to the Socket.IO instance
// (used by block/unblock routes to notify the user's
// other open tabs/devices).
app.set("io", io);

// Serve locally-stored avatar uploads
// backend/uploads/avatars/*
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/calls", callRoutes);

app.get("/", (req, res) => {
  res.send("MERN Chat API is running");
});

// Socket.IO
initSocket(io);

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});