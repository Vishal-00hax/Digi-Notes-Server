import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const isProduction = redisUrl.startsWith("rediss://");

export const redisClient = createClient({
  url: redisUrl,
  socket: {
    tls: isProduction,
    keepAlive: 10000, // send TCP keep-alive packets every 10s to prevent idle drop
    reconnectStrategy: (retries) => {
      if (retries > 20) {
        console.error("Redis: exceeded max reconnect attempts. Giving up.");
        return new Error("Redis unavailable");
      }
      // Exponential backoff capped at 5s
      return Math.min(retries * 200, 5000);
    },
  },
  pingInterval: 30000, // send a PING every 30s to keep the connection alive and detect dead sockets early
});

let hasLoggedError = false;

redisClient.on("error", (err) => {
  // Avoid flooding logs with repeated identical errors
  if (!hasLoggedError) {
    console.error("Redis Client Error:", err.message);
    hasLoggedError = true;
    setTimeout(() => {
      hasLoggedError = false;
    }, 30000); // allow logging again after 30s
  }
});

redisClient.on("connect", () => {
  console.log("Redis connected successfully");
  hasLoggedError = false;
});

redisClient.on("reconnecting", () => {
  console.log("Redis reconnecting...");
});

export const connectRedis = async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
  } catch (err) {
    console.error("Redis initial connection failed:", err.message);
    // Don't throw — let the app run without cache, reconnectStrategy will keep retrying in background
  }
};
