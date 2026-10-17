import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import express from "express";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import "dotenv/config";
import cookieParser from "cookie-parser";
import authRouter from "./routes/authRouter.js";
import notesRouter from "./routes/notesRouter.js";
import healthRouter from "./routes/healthRouter.js";
import cors from "cors";
import http from "http";
import { initializeSocket } from "./utils/socket-io.js";
import { connectRedis } from "./config/redisClient.js";

const app = express();

app.use(express.json());
app.use(cookieParser());

export const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4000",
  "https://vishaldevtribe.com",
  "https://digi-notes-server.onrender.com/api",
  "https://digi-notes-server.onrender.com",
  "https://ai-resume-builder.vishaldevtribe.com",
  "https://digi-notes-client.vercel.app", //
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin
      if (!origin) return callback(null, true);

      // check if origin is in allowedOrigins
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log("Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    optionsSuccessStatus: 200,
  }),
);

app.use("/health", healthRouter);
app.use("/api/health", healthRouter);

app.use("/api/auth/", authRouter);
app.use("/api/notes", notesRouter);

const PORT = process.env.PORT || 7777;

const server = http.createServer(app);
initializeSocket(server);

// Start accepting connections immediately: platform health checks and load-test
// warm-up probes can then succeed while MongoDB is still connecting. This keeps
// the Render cold-start penalty out of the first user-facing request instead of
// blocking `listen` on the database handshake.
server.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});

// Connect dependencies after the HTTP server is up. Both are resilient: a
// failure is logged and the process stays alive, with /health/ready reporting
// the actual state.
connectDB();
connectRedis();

// Graceful shutdown so deploys drain in-flight requests and close the DB pool.
const shutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    try {
      await mongoose.connection.close();
    } catch (err) {
      console.error("Error closing MongoDB connection:", err.message);
    }
    process.exit(0);
  });

  // Force-exit if connections do not drain in time (e.g. stuck keep-alive).
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
