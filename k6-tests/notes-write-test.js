import http from "k6/http";
import { check, sleep, group } from "k6";

let rawBaseUrl = __ENV.BASE_URL || "https://digi-notes-client.vercel.app";
rawBaseUrl = rawBaseUrl.replace(/[\[\]"'<>\s]/g, "").replace(/\/+$/, "");

if (!/^https?:\/\//i.test(rawBaseUrl)) {
  rawBaseUrl = `https://${rawBaseUrl}`;
}

const BASE_URL = rawBaseUrl;
const AUTH_PREFIX = "/api/auth";

const EMAIL = (__ENV.TEST_EMAIL || "testuser@example.com").trim();
const PASSWORD = (__ENV.TEST_PASSWORD || "12345").trim();

export const options = {
  vus: 2,
  iterations: 10,
  thresholds: {
    // Fail if more than 5% of requests fail
    http_req_failed: ["rate<0.05"],

    // Group-specific thresholds (adjust ms as per actual expected latency)
    "http_req_duration{group:::Login}": ["p(95)<3000"],
    "http_req_duration{group:::Create Note}": ["p(95)<10000"], // Embedding call allowed up to 10s
    "http_req_duration{group:::Update Note}": ["p(95)<10000"],
    "http_req_duration{group:::Delete Note}": ["p(95)<3000"],
  },
};

// WARM-UP PHASE: Absorbs the cold start penalty outside of the main test metrics
export function setup() {
  console.log("Waking up the backend server...");
  const res = http.get(`${BASE_URL}`, { timeout: "60s" });
  if (res.status !== 200) {
    console.warn(
      "Warm-up request did not return 200, backend might still be starting.",
    );
  }
}

export default function () {
  group("Login", function () {
    const payload = JSON.stringify({ email: EMAIL, password: PASSWORD });
    const res = http.post(`${BASE_URL}${AUTH_PREFIX}/login`, payload, {
      headers: { "Content-Type": "application/json" },
    });
    check(res, { "login status is 200": (r) => r.status === 200 });
  });

  let createdNoteId = null;

  group("Create Note", function () {
    const payload = JSON.stringify({
      title: `Load Test Note ${Date.now()}`,
      text: "Ye ek load test ke dauraan banaya gaya note hai.",
    });

    const res = http.post(`${BASE_URL}/api/notes/create`, payload, {
      headers: { "Content-Type": "application/json" },
    });

    const success = check(res, {
      "create note status is 201": (r) => r.status === 201,
    });

    if (success) {
      try {
        const body = JSON.parse(res.body);
        createdNoteId = body.data;
      } catch (e) {
        // ignore
      }
    }
    sleep(2);
  });

  group("Update Note", function () {
    if (!createdNoteId) return;

    const payload = JSON.stringify({
      notesId: createdNoteId,
      title: "Updated Load Test Note",
      text: "Updated content during load test.",
    });

    const res = http.patch(`${BASE_URL}/api/notes/update`, payload, {
      headers: { "Content-Type": "application/json" },
    });

    check(res, { "update note status is 200": (r) => r.status === 200 });
    sleep(2);
  });

  group("Delete Note", function () {
    if (!createdNoteId) return;

    const res = http.del(`${BASE_URL}/api/notes/delete/${createdNoteId}`);
    check(res, { "delete note status is 200": (r) => r.status === 200 });
    sleep(1);
  });
}
