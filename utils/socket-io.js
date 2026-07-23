// utils/socket-io.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { allowedOrigins } from "../app.js";

let io;

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  io.use(authSocket);
  io.on("connection", handleConnection);

  return io;
};

// Cookie Parse function
const parseCookies = (rawCookie) => {
  return Object.fromEntries(
    rawCookie.split(";").map((pair) => {
      const [key, ...valueParts] = pair.trim().split("=");
      return [key, decodeURIComponent(valueParts.join("="))];
    }),
  );
};

const authSocket = (socket, next) => {
  try {
    const rawCookie = socket.handshake.headers.cookie;
    if (!rawCookie) {
      return next(new Error("Authentication required"));
    }

    const parsedCookie = parseCookies(rawCookie);
    const token = parsedCookie.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRATE);
    socket.userId = decoded._id;
    next();
  } catch (err) {
    console.error("JWT verify failed:", err.message);
    next(new Error("Invalid or expired token"));
  }
};

const handleConnection = (socket) => {
  socket.join(socket.userId.toString());
  console.log(`User ${socket.userId} connected: with socket id ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`User ${socket.userId} disconnected`);
  });
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized. Call initializeSocket first.");
  }
  return io;
};
