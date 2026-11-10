/**
 * k6 load test — SOS path.
 *
 *   k6 run load-test/sos.js
 *   k6 run -e STUDENTS=20 -e CLEANUP_TOKEN=$METRICS_TOKEN load-test/sos.js
 *
 * WHAT IT MEASURES: POST /alerts under a realistic burst — the endpoint the
 * whole system's promise hangs on. Each VU logs in as its own seeded
 * load-test student (demo:reset creates loadtest_student_1..500) and raises
 * SOS alerts with GPS.
 *
 * GUARD: refuses to run against anything that is not a local address unless
 * ALLOW_NON_LOCAL=true. A load test against a shared/production host is a
 * self-inflicted outage, and this script is one typo away from one.
 *
 * SELF-CLEANUP: teardown calls POST /loadtest/cleanup with the shared
 * CLEANUP_TOKEN (METRICS_TOKEN). That endpoint only deletes alerts belonging
 * to loadtest_student_* accounts and refuses to run in production unless
 * ALLOW_LOADTEST_CLEANUP=true. Without CLEANUP_TOKEN the run leaves its rows
 * behind and says so — never silently.
 *
 * AUTH LIMITER NOTE: POST /auth/login is capped at 10 attempts / 15 min / IP.
 * setup() logs in once per student from this one IP, so STUDENTS above 10
 * needs RATE_LIMIT_ENABLED=0 on the target API (documented in the README).
 * The SOS limiter itself is not a blocker: over-limit SOSes take the
 * break-glass path and still return 201.
 */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const API_URL = __ENV.API_URL || 'http://localhost:4000';
const ALLOW_NON_LOCAL = __ENV.ALLOW_NON_LOCAL === 'true';
const STUDENTS = Number(__ENV.STUDENTS || 10);
const CLEANUP_TOKEN = __ENV.CLEANUP_TOKEN || '';
const LOADTEST_PASSWORD = __ENV.LOADTEST_PASSWORD || 'LoadTest123!';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '10.0.2.2']);

/**
 * Host of an absolute http(s) URL.
 *
 * WHY NOT `new URL()`: k6's goja runtime has no WHATWG URL constructor, so
 * `new URL(API_URL)` threw for EVERY input and the local-target guard rejected
 * even `http://127.0.0.1:4100` — the harness failed at init, before sending a
 * single request. This regex covers exactly what the guard needs (scheme +
 * host, IPv6 in brackets, optional port) and behaves the same in goja and Node.
 */
function hostFromUrl(value) {
  const match = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(value);
  return match ? match[1].replace(/^\[|\]$/g, '') : null;
}

function assertLocalTarget(url) {
  const host = hostFromUrl(url);

  if (host === null) {
    fail(`API_URL is not a valid absolute http(s) URL: ${url}`);
  }

  if (!LOCAL_HOSTS.has(host) && !ALLOW_NON_LOCAL) {
    fail(
      `refusing to load-test non-local host "${host}". ` +
        'Set ALLOW_NON_LOCAL=true only if you own the target and it is disposable.',
    );
  }
}

assertLocalTarget(API_URL);

export const options = {
  scenarios: {
    sos_flood: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    // The SOS contract: almost every request succeeds, and a p95 under 300ms
    // keeps the API comfortably inside the "under 100ms when Redis is down"
    // claim for the non-blocking escalation enqueue.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:POST /alerts}': ['p(95)<300'],
  },
};

export function setup() {
  const tokens = [];

  for (let i = 1; i <= STUDENTS; i += 1) {
    const email = `loadtest_student_${i}@demo.hostel`;
    const response = http.post(
      `${API_URL}/auth/login`,
      JSON.stringify({ email, password: LOADTEST_PASSWORD, role: 'STUDENT' }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (response.status === 200) {
      tokens.push(response.json('token'));
    } else if (response.status === 429) {
      fail(
        'login rate limit hit during setup — lower STUDENTS to <= 10 or start ' +
          'the API with RATE_LIMIT_ENABLED=0 for the load run',
      );
    }
  }

  if (tokens.length === 0) {
    fail('no load-test students could log in — run `npm run demo:reset` first');
  }

  console.log(`setup: ${tokens.length}/${STUDENTS} students authenticated`);
  return { tokens };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];

  const response = http.post(
    `${API_URL}/alerts`,
    JSON.stringify({
      type: 'MEDICAL',
      latitude: 12.9716,
      longitude: 77.5946,
      locationAccuracy: 12,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'POST /alerts' },
    },
  );

  check(response, {
    'SOS accepted (201)': (result) => result.status === 201,
  });

  sleep(Math.random() * 1.5);
}

export function teardown() {
  if (!CLEANUP_TOKEN) {
    console.log(
      'cleanup SKIPPED: CLEANUP_TOKEN is unset. Remove this run\'s rows with ' +
        '`npm run demo:reset` (repo: backend/).',
    );
    return;
  }

  const response = http.post(`${API_URL}/loadtest/cleanup`, null, {
    headers: { 'x-loadtest-token': CLEANUP_TOKEN },
  });

  console.log(`cleanup: HTTP ${response.status} ${response.body}`);
  check(response, {
    'cleanup accepted': (result) => result.status === 200,
  });
}
