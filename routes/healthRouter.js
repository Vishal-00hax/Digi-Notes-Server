import express from "express";
import mongoose from "mongoose";
import { redisClient } from "../config/redisClient.js";

const healthRouter = express.Router();

const DB_STATES = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

/**
 * Liveness probe.
 * Answers as long as the Node process is alive and able to serve HTTP.
 * Deliberately does NOT depend on MongoDB/Redis so that platform health
 * checks and warm-up probes succeed immediately after a cold start instead
 * of waiting for the database handshake.
 */
healthRouter.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness probe.
 * Returns 200 only when the API can serve real traffic (MongoDB connected).
 * Redis is treated as optional because the app degrades gracefully to
 * MongoDB when the cache is unavailable. Load tests must poll this endpoint
 * until it returns 200 before starting the measured run, so that the
 * Render cold-start penalty never lands inside http_req_duration.
 */
healthRouter.get("/ready", (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbReady = dbState === 1;
  const redisReady = redisClient.isReady === true;

  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? "ready" : "starting",
    db: DB_STATES[dbState] ?? "unknown",
    redis: redisReady ? "connected" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

export default healthRouter;
