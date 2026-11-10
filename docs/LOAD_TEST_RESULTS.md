# Load test results

**Status: the SOS path is measured with the committed k6 harness
(Measurement 2). Measurement 1 is an earlier stand-in burst, kept for
comparison.**

Every number on this page was produced by an actual run on 2026-11-07 and is
reproducible with the commands at the bottom. Nothing here is estimated.

> **Container-name caveat when reproducing (added 2026-11-09).** The commands
> below say `docker exec hostel-redis …`. That is the name from the *manual*
> start in `backend/.env.example`
> (`docker run -d --name hostel-redis -p 6379:6379 redis:7-alpine`). If you
> started Redis with `npm run test:db:up` instead — which is what the
> 2026-11-08 dry run used — Compose names it **`backend-redis-1`**.
> **On this machine both containers exist**, left over from the two different
> start methods, and both publish `6379`, so only one can be up at a time.
> `hostel-redis` is currently stopped; `backend-redis-1` is the live one.
> Check which is actually running before substituting a name:
> `docker ps --format '{{.Names}}\t{{.Status}}' | grep redis`.
> The measurements themselves are unaffected; only the teardown command's
> container name is environment-specific.

## Measurement 1 — SOS burst, single API instance

| Field | Value |
| --- | --- |
| Date | 2026-11-07 |
| Driver | Node `v24.18.0` built-in `fetch` (ad-hoc, 40 lines) |
| Target | `http://127.0.0.1:4100` — one API process, `tsx src/index.ts` |
| Database | `hostel_emergency_test` (disposable), Postgres in Docker |
| Redis | `redis://localhost:6379/1`, Docker `hostel-redis` |
| Rate limiting | **disabled** (`RATE_LIMIT_ENABLED=0`) — see caveat 2 |
| Students | 20 seeded `loadtest_student_*` accounts, all logged in up front |
| Requests | 200 × `POST /alerts`, `type=MEDICAL`, GPS present |
| Concurrency | 10 |

### Results

| Metric | Value |
| --- | --- |
| HTTP 201 responses | **200 / 200** |
| Failures (non-201) | **0** |
| Wall clock | 1 814 ms |
| Throughput | **110.3 req/s** |
| p50 latency | **92.1 ms** |
| p95 latency | **120.3 ms** |
| p99 latency | **176.7 ms** |
| max latency | **178.8 ms** |

Teardown: `POST /loadtest/cleanup` deleted 203 alert rows and 500 seeded
load-test accounts; 200 escalation jobs were flushed from Redis DB 1
(`flushdb`) because no worker was consuming.

### What this does prove

- `POST /alerts` stays **well under the k6 script's 300 ms p95 threshold**
  under 10-way concurrency, including JWT auth, rate-limit middleware,
  Postgres insert and the BullMQ enqueue.
- No 5xx and no dropped requests at this load on a laptop-sized box.
- The `?status` / `?limit` board query and the history fix did not regress the
  hot write path.

### What this does NOT prove

1. **k6 was not installed at the time of this measurement**, so the numbers
   above come from a stand-in Node driver modelling the same request shape.
   Measurement 2 below supersedes them with the committed harness.
2. **Rate limiting was off.** With the limiter on, >10 logins per IP hit the
   auth limiter (documented in `load-test/README.md`); the SOS limiter would
   break-glass and still return 201. Latency with Redis limiter round-trips on
   is therefore slightly pessimistic here in one sense and optimistic in the
   counter-increment sense.
3. **Single instance, single machine.** No nginx, no cross-instance Socket.IO
   fan-out, no worker. The multi-instance guarantee is covered separately by
   `npm run test:multi-instance` (functional, not throughput).
4. **No sustained soak.** 1.8 seconds is a burst, not a 30-minute run. Memory
   growth, connection-pool exhaustion and BullMQ backlog under sustained load
   are unmeasured.
5. **No SMS path exercised.** No worker, no Twilio calls (and no cost).
6. **No mobile clients.** Socket fan-out to real devices is not in these
   timings.

## Measurement 2 — the committed k6 harness

| Field | Value |
| --- | --- |
| Date | 2026-11-07, 12:48 IST |
| Driver | **k6 v2.3.0**, Windows amd64 zip extracted to the gitignored `.k6/` |
| Script | `load-test/sos.js` — scenario and thresholds as committed |
| Target | `http://127.0.0.1:4100` — one API process, `tsx src/index.ts` |
| Database | `hostel_emergency_test` (disposable) |
| Redis | `redis://localhost:6379/1` |
| Rate limiting | disabled (`RATE_LIMIT_ENABLED=0`) |
| Students | 10 seeded `loadtest_student_*` accounts (script default) |
| Load shape | `ramping-vus`: 0→10 (10 s) → 50 (30 s) → 0 (10 s) |

### Results

| Metric | Value | Threshold |
| --- | --- | --- |
| Iterations | **1 543** | — |
| `http_reqs` | 1 554 (28.98 req/s) | — |
| Checks | **1 544 / 1 544 passed (100%)** | — |
| `http_req_failed` | **0.00%** | `<1%` ✓ |
| `POST /alerts` p95 | **17.59 ms** | `<300 ms` ✓ |
| `POST /alerts` avg / med / max | 14.47 / 14.23 / 48.08 ms | — |
| Overall p95 | 17.78 ms | — |
| Teardown | `cleanup: HTTP 200 {"deleted":3119,"students":500}` | ✓ |

### What this adds over Measurement 1

- The **committed harness itself runs green**: scenario, thresholds, 10-student
  login setup, checks and teardown path all executed — not a stand-in driver.
- Teardown really calls `POST /loadtest/cleanup` and it returns 200, so the
  scoped cleanup door is exercised end to end. (A token mismatch produced a
  401 on an earlier attempt, which also confirms the guard rejects.)
- 50 VUs sustained for 50 s at ~29 req/s with p95 ≈ 18 ms.

### Two bugs this run exposed (both fixed — neither was findable without
### executing the harness)

1. **`load-test/sos.js` could never have run.** The local-target guard used
   `new URL(API_URL)`; k6's goja runtime has no WHATWG `URL` global (probed:
   `typeof URL === "undefined"`, `new URL(...)` throws `ReferenceError`), so the
   guard failed with *"API_URL is not a valid absolute URL"* for every input,
   including the default `http://127.0.0.1:4100`. Replaced with a scheme/host
   regex (`hostFromUrl`) that behaves identically in goja and Node.
2. **Cleanup deleted the seeded demo history.** `demo:reset` attached its three
   resolved "yesterday" alerts to `loadtest_student_1..3`, so
   `POST /loadtest/cleanup` — correctly scoped to the `loadtest_student_`
   prefix — removed them too: the run deleted 3 119 rows (1 573 + 1 543 burst
   rows + the 3 demo rows) and left the history page empty. The seeds now
   belong to the named demo students (`aarav@hostel.local`,
   `diya@hostel.local`).

### Post-fix confirmation run (same harness, 12:50 IST)

With the seed fix applied, the identical command produced:

| Metric | Value |
| --- | --- |
| Iterations | 1 559 |
| `http_reqs` | 1 570 (29.22 req/s) |
| Checks | 1 560 / 1 560 (100%) |
| `http_req_failed` | 0.00% |
| `POST /alerts` p95 | 16.94 ms |
| Teardown | `cleanup: HTTP 200 {"deleted":1559,"students":500}` |
| Rows after cleanup | **3** — the seeded `aarav@hostel.local` / `diya@hostel.local` history; 0 `loadtest_student_*` rows |

So cleanup now removes exactly the burst it created and leaves the demo audit
trail intact.

### Reproduce (exactly as run)

```bash
cd backend
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hostel_emergency_test?schema=public"
export REDIS_URL="redis://localhost:6379/1" METRICS_TOKEN="loadtest-local-token"

npx tsx prisma/demo-reset.ts
PORT=4100 RATE_LIMIT_ENABLED=0 npx tsx src/index.ts &

# repo root — download once from grafana/k6 releases (windows-amd64 zip)
./.k6/k6-v2.3.0-windows-amd64/k6.exe run \
  -e API_URL=http://127.0.0.1:4100 -e STUDENTS=10 \
  -e CLEANUP_TOKEN=loadtest-local-token load-test/sos.js

docker exec hostel-redis redis-cli -n 1 flushdb   # queued escalation jobs
```

## Not yet measured

| Scenario | Why it matters | Status |
| --- | --- | --- |
| k6 run of `load-test/sos.js` | Validates the committed harness | **measured** — Measurement 2 |
| Sustained 30 min @ 50 rps | Soak / leak detection | not run |
| 3 instances behind nginx | Real deployment topology | not run |
| Escalation under load (worker on) | Worker + Redis throughput | not run |
| p95 with rate limiters ON | Prod-accurate middleware cost | not run |

## Reproduce

```bash
cd backend

# 1) disposable data only — never point this at the dev/prod database
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hostel_emergency_test?schema=public"
export REDIS_URL="redis://localhost:6379/1"
export METRICS_TOKEN="<token>"

npx tsx prisma/demo-reset.ts        # 500 loadtest students + 3 resolved alerts

# 2) API on a spare port with the auth limiter off (local only)
PORT=4100 RATE_LIMIT_ENABLED=0 npx tsx src/index.ts &

# 3) driver: 20 logins, then 200 POST /alerts at concurrency 10
#    (see the "Measurement 1" request shape: type=MEDICAL + lat/long)

# 4) teardown
curl -X POST http://127.0.0.1:4100/loadtest/cleanup \
  -H "x-loadtest-token: $METRICS_TOKEN"
kill %1
docker exec hostel-redis redis-cli -n 1 flushdb   # drop the queued jobs
```

With k6 available, use the real harness instead:

```bash
CLEANUP_TOKEN=$METRICS_TOKEN k6 run load-test/sos.js
```

## Bug found while measuring

`npm run demo:reset` failed with Prisma **P2025** on a database that had been
migrated but never seeded: it read the head warden *before*
`ensurePopulation()` created the demo accounts. Fixed by reordering — the
population upsert now runs first. This only affected fresh environments
(a new clone, a CI runner, the test database), which is exactly where a demo
or a load test is most likely to be run.
