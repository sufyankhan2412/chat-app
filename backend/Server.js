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
const aiAgentRoutes = require("./routes/AIAgentRoutes");
const calendarRoutes = require("./routes/CalendarRoutes");

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  "http://localhost:5173",
  "https://2x7n90c5-5173.asse.devtunnels.ms",
  "http://192.168.18.79:5173",
  process.env.FRONTEND_URL,
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json());

app.set("io", io);

app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/ai-agent", aiAgentRoutes);
app.use("/api/calendar", calendarRoutes);

app.get("/", (req, res) => {
  res.send("MERN Chat API is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Backend is running",
  });
});

initSocket(io);

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database connection failed:", error);
    process.exit(1);
  });