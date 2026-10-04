import { jest } from "@jest/globals";
import {
  SSE_HEADERS,
  formatSSEEvent,
  writeSSEEvent,
  startSSEHeartbeat,
} from "../utils/sse.js";

describe("SSE utilities", () => {
  describe("formatSSEEvent", () => {
    it("serialises a named event with JSON encoded data", () => {
      expect(formatSSEEvent("token", { token: "hi" })).toBe(
        'event: token\ndata: {"token":"hi"}\n\n',
      );
    });

    it("encodes an empty object when data is missing", () => {
      expect(formatSSEEvent("ping", undefined)).toBe(
        "event: ping\ndata: {}\n\n",
      );
    });

    it("escapes newlines inside data so they cannot split a frame", () => {
      const frame = formatSSEEvent("token", { token: "line1\nline2" });
      // Exactly one frame terminator, at the very end.
      expect(frame.match(/\n\n/g)).toHaveLength(1);
      expect(JSON.parse(frame.split("data: ")[1])).toEqual({
        token: "line1\nline2",
      });
    });
  });

  describe("SSE_HEADERS", () => {
    it("disables proxy buffering so tokens are not held back", () => {
      expect(SSE_HEADERS["Content-Type"]).toContain("text/event-stream");
      expect(SSE_HEADERS["Cache-Control"]).toContain("no-transform");
      expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
    });
  });

  describe("writeSSEEvent", () => {
    const mockRes = () => ({
      write: jest.fn().mockReturnValue(true),
      writableEnded: false,
      destroyed: false,
    });

    it("writes the frame and reports success", () => {
      const res = mockRes();
      expect(writeSSEEvent(res, "token", { token: "a" })).toBe(true);
      expect(res.write).toHaveBeenCalledWith(
        'event: token\ndata: {"token":"a"}\n\n',
      );
    });

    it("refuses to write to an ended response", () => {
      const res = mockRes();
      res.writableEnded = true;
      expect(writeSSEEvent(res, "token", { token: "a" })).toBe(false);
      expect(res.write).not.toHaveBeenCalled();
    });

    it("refuses to write to a destroyed socket", () => {
      const res = mockRes();
      res.destroyed = true;
      expect(writeSSEEvent(res, "token", { token: "a" })).toBe(false);
      expect(res.write).not.toHaveBeenCalled();
    });

    it("tolerates a missing response object", () => {
      expect(writeSSEEvent(null, "token", {})).toBe(false);
    });
  });

  describe("startSSEHeartbeat", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("emits a comment frame on every tick", () => {
      const res = { write: jest.fn(), writableEnded: false, destroyed: false };

      startSSEHeartbeat(res, 1000);
      jest.advanceTimersByTime(3000);

      expect(res.write).toHaveBeenCalledTimes(3);
      expect(res.write).toHaveBeenCalledWith(": ping\n\n");

      jest.useRealTimers();
    });

    it("stops emitting once the returned disposer is called", () => {
      const res = { write: jest.fn(), writableEnded: false, destroyed: false };

      const stop = startSSEHeartbeat(res, 1000);
      jest.advanceTimersByTime(1000);
      stop();
      jest.advanceTimersByTime(5000);

      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it("skips the write when the connection is already closed", () => {
      const res = { write: jest.fn(), writableEnded: true, destroyed: false };

      startSSEHeartbeat(res, 1000);
      jest.advanceTimersByTime(3000);

      expect(res.write).not.toHaveBeenCalled();
    });
  });
});