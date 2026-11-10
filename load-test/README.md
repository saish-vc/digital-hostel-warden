# Load test — SOS path (k6)

`load-test/sos.js` drives the one endpoint the system's promise depends on:
`POST /alerts`. It is a **destructive-ish** test (it creates hundreds of
alerts), so every safety rail is documented here.

## Prerequisites

1. **k6** installed (`k6 version`). Not an npm package — see
   <https://grafana.com/docs/k6/latest/set-up/install-k6/>.
2. **Postgres + Redis** up, and the API running:
   ```bash
   cd backend
   npm run dev            # single instance on :4000
   # or: npm run build && pm2 start ecosystem.config.js   # 3 instances :3001-3003
   ```
3. **Seeded load-test population** (500 `loadtest_student_*` accounts):
   ```bash
   cd backend && npm run demo:reset
   ```
   The script logs into those accounts only — it never touches a real student.

## Run

```bash
# From the repository root. 10 students is the default because of the auth
# limiter (see below).
CLEANUP_TOKEN=$METRICS_TOKEN k6 run load-test/sos.js

# Point at a non-default API:
API_URL=http://localhost:3001 CLEANUP_TOKEN=... k6 run load-test/sos.js
```

Useful knobs (all `-e KEY=value`):

| Env | Default | Meaning |
| --- | --- | --- |
| `API_URL` | `http://localhost:4000` | Target base URL |
| `STUDENTS` | `10` | How many seeded students to log in during setup |
| `CLEANUP_TOKEN` | *(unset)* | `METRICS_TOKEN` value; enables the teardown cleanup |
| `LOADTEST_PASSWORD` | `LoadTest123!` | Password `demo:reset` assigns |
| `ALLOW_NON_LOCAL` | `false` | Required to target a non-local host |

## Guards

- **Non-local refusal.** The script `fail()`s at init unless the host is
  `localhost`, `127.0.0.1`, `::1` or `10.0.2.2`, or `ALLOW_NON_LOCAL=true` is
  set explicitly.
- **Scoped cleanup.** `teardown()` calls `POST /loadtest/cleanup` with
  `x-loadtest-token`. That endpoint:
  - 401s without the token (timing-safe compare against `METRICS_TOKEN`),
  - 403s when `NODE_ENV=production` unless `ALLOW_LOADTEST_CLEANUP=true`,
  - only deletes alerts whose student email starts with `loadtest_student_`.
- **No token = loud skip.** Without `CLEANUP_TOKEN` the run still executes but
  teardown prints that cleanup was skipped and tells you to run
  `npm run demo:reset`.

## Auth-limiter caveat (read before scaling VUs)

`POST /auth/login` is limited to **10 attempts / 15 min / IP**, and `setup()`
logs in every student from one IP. So:

- `STUDENTS<=10` — works with the limiter on.
- `STUDENTS>10` — start the API with `RATE_LIMIT_ENABLED=0` (local only!) or
  the 11th login returns 429 and setup fails with a clear message.

The SOS limiter is *not* a blocker: past 5 SOS/60s per student the
break-glass override logs `sos_rate_limit_overridden` and still returns 201,
which is exactly the behaviour under test.

## Reading the output

- `http_req_failed` — should stay under 1%.
- `http_req_duration{name:POST /alerts}` — p95 threshold is 300ms.
- `http_reqs` — total SOS throughput for the run.

Results of recorded runs live in [`../docs/LOAD_TEST_RESULTS.md`](../docs/LOAD_TEST_RESULTS.md).
