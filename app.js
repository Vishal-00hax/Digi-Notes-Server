import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import express from "express";
import connectDB from "./config/db.js";
import "dotenv/config";
import cookieParser from "cookie-parser";
import authRouter from "./routes/authRouter.js";
import notesRouter from "./routes/notesRouter.js";
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

app.use("/api/auth/", authRouter);
app.use("/api/notes", notesRouter);

const PORT = process.env.PORT || 7777;

const server = http.createServer(app);
initializeSocket(server);

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server is running at ${PORT}`);
    });
  })
  .catch((err) => {
    console.log(`Data-Base connection error : ${err}`);
  });

// Connect Redis independently — don't block server startup on it
connectRedis();
