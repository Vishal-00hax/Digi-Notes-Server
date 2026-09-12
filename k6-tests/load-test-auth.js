import http from "k6/http";
import { check, sleep, group } from "k6";

// ============================================
// CONFIGURATION
// ============================================
const BASE_URL = __ENV.BASE_URL || "https://your-app-name.onrender.com";
const AUTH_PREFIX = "/api/auth";

const EMAIL = __ENV.TEST_EMAIL || "testuser@example.com";
const PASSWORD = __ENV.TEST_PASSWORD || "testpassword123";

// IMPORTANT: aapka accessToken sirf 15 min mein expire hota hai.
// Isliye test duration 15 min se kam rakho, warna beech mein
// 401 "Access token expired" milna start ho jayega aur refresh
// token flow alag se handle karna padega.

export const options = {
  // TEMPORARY: debugging ke liye sirf 1 VU, 1 iteration.
  // Jab issue fix ho jaaye, to upar wale stages wapas kar dena.
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_duration: ["p(95)<3000"],
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  // NOTE: k6 har VU ke liye apna khud ka cookie jar maintain karta hai
  // (real browser jaisa). Login response mein jo Set-Cookie aayega
  // (accessToken, refreshToken), wo automatically agli requests mein
  // bhej diya jayega -- humein manually kuch attach nahi karna.

  // ------------------------------------------
  // STEP 1: Homepage visit karo
  // ------------------------------------------
  group("1. Homepage", function () {
    const res = http.get(`${BASE_URL}/`);
    check(res, {
      "homepage status is 200": (r) => r.status === 200,
      "homepage loads fast": (r) => r.timings.duration < 3000,
    });
    sleep(2);
  });

  // ------------------------------------------
  // STEP 2: Login karo (cookies automatically set ho jayengi)
  // ------------------------------------------
  group("2. Login", function () {
    const payload = JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
    });

    const params = {
      headers: { "Content-Type": "application/json" },
    };

    const res = http.post(`${BASE_URL}${AUTH_PREFIX}/login`, payload, params);

    // DEBUG: agar login fail ho, to exact status + response body
    // print karo -- isse pata chalega CI mein exact kya error aa
    // raha hai (403 CORS block? 429 rate limit? 500 server error?)
    if (res.status !== 200) {
      console.log(
        `LOGIN FAILED - Status: ${res.status} | Body: ${res.body} | Headers: ${JSON.stringify(res.headers)}`,
      );
    }

    check(res, {
      "login status is 200": (r) => r.status === 200,
      "login returned user object": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.user !== undefined;
        } catch (e) {
          return false;
        }
      },
      "accessToken cookie set": (r) =>
        r.cookies.accessToken !== undefined && r.cookies.accessToken.length > 0,
    });

    sleep(1);
  });

  // ------------------------------------------
  // STEP 3: Profile fetch karo (cookie auto-attach hogi)
  // ------------------------------------------
  group("3. Get Profile", function () {
    const res = http.get(`${BASE_URL}${AUTH_PREFIX}/profile`);

    check(res, {
      "profile status is 200": (r) => r.status === 200,
      "profile has user data": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.user !== undefined;
        } catch (e) {
          return false;
        }
      },
    });

    sleep(2);
  });

  // ------------------------------------------
  // STEP 4: Notes list dekho (read-only -- safe, Redis cache
  // test bhi ho jayega, koi OpenAI/embedding call nahi hoti)
  // ------------------------------------------
  let firstNoteId = null;

  group("4. Get Notes List", function () {
    const res = http.get(`${BASE_URL}/api/notes`);

    check(res, {
      "notes list status is 200": (r) => r.status === 200,
    });

    try {
      const body = JSON.parse(res.body);
      if (body.notes && body.notes.length > 0) {
        firstNoteId = body.notes[0]._id;
      }
    } catch (e) {
      // ignore parse error
    }

    sleep(2);
  });

  // ------------------------------------------
  // STEP 5: Ek note ka detail dekho (agar koi note mila)
  // Baar-baar same ID call karne se Redis cache HIT hoga
  // -- ye dekhna interesting hoga ki cache se response
  // kitna fast aata hai vs DB se
  // ------------------------------------------
  group("5. Get Note Detail", function () {
    if (!firstNoteId) {
      // koi note nahi mila to skip -- pehle DB mein kam se kam
      // 1 note manually ya write-test se bana lo
      return;
    }

    const res = http.get(`${BASE_URL}/api/notes/${firstNoteId}`);

    check(res, {
      "note detail status is 200": (r) => r.status === 200,
    });

    sleep(1);
  });

  // ------------------------------------------
  // STEP 6: Logout karo (session cleanup)
  // ------------------------------------------
  group("6. Logout", function () {
    const res = http.post(`${BASE_URL}${AUTH_PREFIX}/logout`, null, {
      headers: { "Content-Type": "application/json" },
    });

    check(res, {
      "logout status is 200": (r) => r.status === 200,
    });

    sleep(1);
  });
}
