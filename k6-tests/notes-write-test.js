import http from "k6/http";
import { check, sleep, group } from "k6";

// ============================================
// ⚠️ WARNING: Ye endpoints OpenAI embedding API
// call karte hain (createEmbedding). Har request
// ki COST hai aur latency bhi zyada ho sakti hai.
// Isliye VUs bahut kam rakhe gaye hain.
//
// ⚠️ ADDITIONAL WARNING: BASE_URL Vercel domain hai
// jo backend ko proxy/rewrite karta hai. Vercel Hobby
// plan par serverless functions ka DEFAULT TIMEOUT
// ~10 seconds hota hai. Agar Render backend response
// dene mein 10 sec se zyada leta hai (jaise cold start
// ya heavy embedding call ke waqt), to Vercel khud hi
// 504 Gateway Timeout de dega -- chahe Render abhi bhi
// process kar raha ho. Ye Render ki galti nahi, Vercel
// ki proxy timeout limit hai.
// ============================================

const BASE_URL = __ENV.BASE_URL || "https://digi-notes-client.vercel.app";
const AUTH_PREFIX = "/api/auth";

const EMAIL = __ENV.TEST_EMAIL || "testuser@example.com";
const PASSWORD = __ENV.TEST_PASSWORD || "12345";

export const options = {
  // Sirf 2 VUs, 5 baar iterate -- total 10 notes create/update/delete
  vus: 2,
  iterations: 10,
  thresholds: {
    // Embedding calls ki wajah se response time zyada allow kiya hai
    http_req_duration: ["p(95)<8000"],
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  // Login pehle (cookie jar automatically maintain hoga)
  group("Login", function () {
    const payload = JSON.stringify({ email: EMAIL, password: PASSWORD });
    const res = http.post(`${BASE_URL}${AUTH_PREFIX}/login`, payload, {
      headers: { "Content-Type": "application/json" },
    });
    check(res, { "login status is 200": (r) => r.status === 200 });
  });

  let createdNoteId = null;

  // ------------------------------------------
  // CREATE - embedding call hoti hai yahan
  // ------------------------------------------
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

  // ------------------------------------------
  // UPDATE - ismein bhi embedding call hoti hai
  // ------------------------------------------
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

    check(res, {
      "update note status is 200": (r) => r.status === 200,
    });

    sleep(2);
  });

  // ------------------------------------------
  // DELETE - cleanup, taaki database mein junk
  // notes accumulate na hon
  // ------------------------------------------
  group("Delete Note", function () {
    if (!createdNoteId) return;

    const res = http.del(`${BASE_URL}/api/notes/delete/${createdNoteId}`);

    check(res, {
      "delete note status is 200": (r) => r.status === 200,
    });

    sleep(1);
  });
}
