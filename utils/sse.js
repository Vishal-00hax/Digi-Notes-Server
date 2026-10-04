// sse.js
// Minimal Server-Sent Events helpers used by the streaming Ask-AI endpoint.
// Kept separate from the controller so the wire format can be unit tested.

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // `no-transform` stops proxies (and any compression layer) from buffering the
  // response, which would defeat streaming entirely.
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // nginx honours this and disables proxy buffering.
  "X-Accel-Buffering": "no",
};

export const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Serialises one SSE frame. `event` is the event name, `data` is JSON encoded.
 */
export const formatSSEEvent = (event, data) =>
  `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;

/**
 * Writes a frame unless the socket is already gone. Returns false when the
 * frame could not be delivered so callers can bail out early.
 */
export const writeSSEEvent = (res, event, data) => {
  if (!res || res.writableEnded || res.destroyed) return false;
  res.write(formatSSEEvent(event, data));
  return true;
};

/**
 * SSE comment frames. They keep idle connections (and the load balancers in
 * front of them) from dropping the request while the model is thinking.
 */
export const startSSEHeartbeat = (res, intervalMs = HEARTBEAT_INTERVAL_MS) => {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": ping\n\n");
  }, intervalMs);

  // Never let the heartbeat keep the process alive.
  timer.unref?.();

  return () => clearInterval(timer);
};