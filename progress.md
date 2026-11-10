# Project progress — Hostel Emergency Monitoring System

> **Audience:** the next AI agent or engineer picking this repo up.
> **Last verified:** 2026-11-08 dry run (66 drills, `docs/DRY_RUN_REPORT.md`)
> plus the remediation that followed it. Claims corrected in Phase 6 of that
> remediation are marked where they changed.
> **Rule:** update this file whenever you change status. Do not mark something
> complete unless you ran the check yourself.

---

## 1. Completion snapshot

| Area | Status | Evidence / notes |
|---|---|---|
| Phase 1 SOS loop (student → DB → wardens) | ✅ Complete | HTTP + Socket.IO tests |
| One-shot GPS + dashboard map | ✅ Complete | Coordinates persisted, map pin + accuracy in dashboard |
| FCM web push | ✅ Complete | Mocked in tests; real-device delivery is a manual check |
| BullMQ escalation (60s → SMS) | ✅ Complete | Real Redis + real Worker in tests, Twilio mocked |
| Auth (JWT login) + role gates | ✅ Complete | Student/warden RBAC tested |
| Regression test suite | ✅ Complete | **10 files / 75 tests** (9 files + 74 tests run by default; `index.test.ts` is opt-in and skips). Last full run **75.61s** |
| CI workflow | ✅ Written | `.github/workflows/test.yml`; not yet observed running on GitHub |
| Redis Socket.IO adapter | ✅ Complete | Cross-instance test passes in **384ms** |
| Sticky sessions | 🟡 Documented | WebSocket-only is the default; nginx path is written but **not executed** |
| PgBouncer pooling | 🟡 Config/docs only | Schema `directUrl` + env examples; **no local PgBouncer container** |
| DB indexes | ✅ Complete | Migration `20261106044939_add_indexes` applied |
| PM2 process model | ✅ Complete | `ecosystem.config.js` **launched and observed**: `api` 3× cluster (3001-3003), `worker` 1× fork (metrics 4001) |
| `GET /health` | ✅ Complete | Per-instance identity + Redis/DB checks tested |
| Multi-instance acceptance test | ✅ Complete | Two real API processes on 3001/3002 |
| Monitoring (Prometheus/Grafana) | ✅ Complete | `docker-compose.monitoring.yml` run locally; `GET /metrics` token-gated; 2 dashboard variants, 5 alert rules. Dry-run **H1** |
| Rate limiting | ✅ Complete | 3 Redis-backed limiters + in-memory socket handshake limiter; SOS break-glass override. `tests/hardening.test.ts` |
| Resolve flow (ACKNOWLEDGED → RESOLVED) | ✅ Complete | `PATCH /alerts/:id/resolve` + dashboard Resolve dialog. Dry-run new finding #1 |
| Worker horizontal scaling | ⛔ Not started | Deliberately single instance |
| Deployed multi-instance verification | 🟡 Deferred | **Production-only** — no LB runs locally; F3/F4 reframed, see §8 |

**Overall:** the SOS loop, multi-instance fan-out, observability and rate
limiting are implemented and exercised locally. What remains unproven here is
*deployment* shape (nginx/TLS/failover) and the two notification channels
(Twilio SMS, FCM push), which need operator accounts — see
`docs/DEMO_SETUP.md`.

---

## 2. Repository map

```
.
├── backend/                     Node 22+ / Express 5 / Socket.IO 4 / Prisma 6
│   ├── src/
│   │   ├── index.ts             process bootstrap: port, Redis adapter, listen
│   │   ├── app.ts               Express + Socket.IO assembly (no listen)
│   │   ├── config/
│   │   │   ├── jwt.ts           JWT sign/verify, uppercase roles
│   │   │   ├── prisma.ts        PrismaClient singleton
│   │   │   ├── redis.ts         BullMQ + adapter + fail-fast limiter factories
│   │   │   ├── instance.ts      PORT / NODE_APP_INSTANCE → 3001/3002/3003
│   │   │   ├── metrics.ts       prom-client registry, gauges, queue polling
│   │   │   ├── logger.ts        pino + secret redaction
│   │   │   └── firebase.ts      FCM init (null when env missing)
│   │   ├── middleware/          auth.ts, rateLimiters.ts, requestId.ts,
│   │   │                        logContext.ts, httpsRedirect.ts
│   │   ├── routes/              auth, alerts, wardens, health, internal, loadtest
│   │   ├── queues/              BullMQ queue, deterministic job id
│   │   ├── workers/             escalation.worker.ts (bootstrap)
│   │   │                        escalation.processor.ts (testable handler)
│   │   ├── services/            push.service.ts, sms.service.ts
│   │   └── sockets/index.ts     Socket.IO singleton getter
│   ├── prisma/
│   │   ├── schema.prisma        directUrl + named indexes
│   │   ├── migrations/          5 migrations (init … add_indexes, add_resolved_at)
│   │   ├── seed.ts              demo seed (2 students, 1 warden)
│   │   ├── demo-reset.ts        rehearsal reset; ends with pm2 restart api worker
│   │   └── test-seed.ts         deterministic 10/3/0 test seed
│   ├── tests/                   11 files on disk / 76 declarations.
│   │                            `npm test` collects 10 files / 75 tests
│   │                            (multi-instance.test.ts excluded by vitest.config.ts);
│   │                            index.test.ts is opt-in and skips → 9 passed + 1 skipped
│   ├── scripts/                 perf-seed.ts (J4 EXPLAIN proof), explain-history.ts,
│   │                            secret-scan-check.cjs
│   ├── monitoring/              prometheus.yml, alertmanager.yml, rules/hostel.yml,
│   │                            grafana/dashboards/{hostel,hostel-configured}.json
│   ├── vitest.config.ts         coverage thresholds, multi-instance gating
│   ├── docker-compose.test.yml  Postgres 16 + Redis 7 → backend-postgres-1/redis-1
│   ├── docker-compose.monitoring.yml  Prometheus + Grafana + Alertmanager
│   ├── ecosystem.config.js      PM2: api ×3 cluster, worker ×1 fork
│   ├── nginx.conf               upstream, WebSocket proxy, passive health (NOT RUN)
│   ├── .env.example             pooled + direct DB URLs, Redis, instance, Twilio
│   └── .env.test.example        TEST_DATABASE_URL / TEST_REDIS_URL
├── warden-dashboard/            React 19 + Vite + Leaflet + Socket.IO client
├── student_app/                 Flutter student app (SOS + location + socket)
├── load-test/                   k6 SOS harness + README (see docs/LOAD_TEST_RESULTS.md)
├── docs/
│   ├── hostel-emergency-system-architecture.md
│   ├── DRY_RUN_REPORT.md        2026-11-08, 66 drills, NO-GO (historical V1)
│   ├── DEMO_SCRIPT.md           the 7-minute runbook, drill-tagged
│   ├── DEMO_SETUP.md            Twilio / FCM / emulator / git checklist
│   ├── AUDIT.md                 2026-11-07 checklist evidence + §5 re-verification
│   ├── FUTURE_WORK.md           deferred work, incl. §6 nginx decision
│   ├── LOAD_TEST_RESULTS.md     k6 measurements
│   └── MANUAL_TESTS.md          device/browser/carrier checklist
├── .husky/pre-commit            the real secret scanner (backend/.husky is a shim)
├── .github/workflows/test.yml
└── progress.md                  this file
```

The root `vitest.config.ts` was deliberately deleted: the backend is its own
npm project, and that stale file pointed at nonexistent setup files.

---

## 3. Runtime architecture (current)

```
Flutter / React
   │  WebSocket-only (no polling → no sticky-session requirement)
   ▼
nginx :8080  (DOCUMENTED, NOT RUNNING LOCALLY — see §8)
   │          hash $remote_addr consistent; only matters for polling
   ├── API :3001 ─┐
   ├── API :3002 ─┼─ shared Redis (adapter PUB/SUB + BullMQ)
   └── API :3003 ─┘        │
                           ├─ Worker ×1 (fork, NEVER cluster)
                           ▼
                    Twilio SMS (escalation)
   │
   └── Prisma → PgBouncer (pooled) → PostgreSQL
```

Request/alert flow:

1. `POST /alerts` authenticates the student JWT and commits the alert to
   Postgres first (source of truth).
2. `io.to('wardens').emit('alert:new', alert)` — the Redis adapter fans this
   out to every API instance, so every connected warden receives it.
3. `sendAlertPush(alert)` runs fire-and-forget (FCM); failures are logged and
   never affect the HTTP response.
4. `enqueueEscalation(alert.id)` adds a delayed BullMQ job with a
   deterministic id. Failure to enqueue is logged; the SOS still returns 201.
5. At the deadline the single worker rereads the alert. **If status is not
   `PENDING`, no SMS is sent** (idempotency guard).
6. `PATCH /alerts/:id/acknowledge` cancels the delayed job before the
   conditional DB update, then emits `alert:updated` to `wardens` and
   `student:<id>`.

Redis connection budget:

- API ×1: BullMQ Queue + adapter PUB + adapter SUB + lazy `/health` ping = **4**
- Worker ×1: BullMQ Worker = **1**
- 3 APIs + worker = **13 connections** total

These clients are intentionally separate. The SUB client enters ioredis
subscriber mode (`psubscribe`), where normal commands no longer work; sharing
it with BullMQ deadlocks the queue.

---

## 4. Non-negotiable invariants — do not break these

1. **`io.adapter(...)` must run before `httpServer.listen(...)`** —
   `backend/src/index.ts` lines ~39/41. Attaching it later leaves already
   connected sockets on the in-memory adapter and cross-instance delivery
   silently stops working.
2. **BullMQ worker is one process, `exec_mode: "fork"`, `instances: 1`.**
   Clustering it produces duplicate escalation SMS. The warning is in
   `ecosystem.config.js` in uppercase on purpose.
3. **Never share Redis connections** between BullMQ, adapter PUB, and adapter
   SUB. See `src/config/redis.ts` for the budget.
4. **Postgres is the source of truth.** Sockets and FCM are delivery
   mechanisms; a delivery failure must not prevent the alert from being
   committed or the HTTP 201 from being returned.
5. **Acknowledge must win over escalation.** The worker guard
   (`alert.status !== 'PENDING'`) protects a job that raced the cancel.
6. **JWTs are stateless. There is no session store, and none is needed.** Do
   not add one.
7. **Clients are WebSocket-only.** If you ever enable long-polling, you must
   also enable LB affinity, or Socket.IO returns “Session ID unknown”.
8. **Alert types are a case-normalized whitelist**
   (`MEDICAL`, `FIRE`, `SECURITY`, `MENTAL_HEALTH`, `OTHER`). The Flutter app
   sends `"Medical"` and is normalized to `MEDICAL`.
9. **Acknowledging an already-acknowledged alert returns 409**, preserving
   the first acknowledger. This is a documented product choice, not a bug.
10. **Test safety rails:** `TEST_DATABASE_URL` must end in `_test`, Redis must
    not be DB 0, and `DIRECT_DATABASE_URL` is forced to the test DB. The suite
    TRUNCATEs and FLUSHDBs; never bypass these guards.

### The seven safety guarantees — what is actually proven

These are the promises the demo makes. Each is listed with the drill that
evidences it and its **real** status, because three of them are narrower than
they sound. Source: `docs/DRY_RUN_REPORT.md` (2026-11-08) plus the Phase 1
re-measurement after the E6 fix. Do not restate any of these more strongly than
the evidence column allows.

| # | Guarantee | Evidence | Status |
|---|---|---|---|
| 1 | **An acknowledged alert never fires SMS.** | E3 (ack at 5.48s → job removed, no send attempt), E4 (boundary ack at 9.604s → no send), E8 (ack after fire → no duplicate), B6 (one PATCH cancels one job). Two layers: `cancelEscalation()` removes the delayed job, and the worker re-reads status and bails unless `PENDING`. | **PROVEN** |
| 2 | **A worker restart does not lose a pending escalation.** | E5: job survived `pm2 stop worker` / `start worker` and fired **1.6s** after the worker came back. The delayed job lives in Redis, not in worker memory. | **PROVEN** |
| 3 | **A Redis outage degrades escalation and rate limiting, but SOS delivery still succeeds in <200ms.** | E6, re-measured **2026-11-08** after the fail-open fix: six SOS POSTs during `docker stop backend-redis-1`, all **HTTP 201**, `time_total` **0.031–0.151s** (31–151ms). `/health` correctly reports `degraded` / `redis:"down"` and `/health/ready` returns 503 — that is intended, and must not gate the SOS path. | **PROVEN for alert creation — see the scope note below** |
| 4 | **A student is never blocked from sending SOS by rate limiting.** | G2: the 6th SOS in 60s returned **201**, `sos_overrides_total` 0→1, and logged `sos_rate_limit_overridden`. The SOS limiter's `handler` calls `next()` — it never sends 429. `passOnStoreError: true` also fails open when Redis is gone. | **PROVEN** |
| 5 | **A warden on instance A receives an alert created on instance B within 500ms.** | F2: sockets on :3001 and :3002 both received `alert:new`, **140/144ms**. L2: `tests/multi-instance.test.ts` asserts <500ms and passed in 3.785s. | **PROVEN — with Redis up** |
| 6 | **A stale FCM token is deleted on the next send.** | `tests/push.test.ts` asserts the deletion against a mocked Firebase Admin SDK. **D4 was SKIP** in the dry run: `FIREBASE_SERVICE_ACCOUNT_B64` is unset, so no real registration or real stale-token rejection was ever exercised. | **UNIT-PROVEN ONLY** — real-device leg pending, `docs/DEMO_SETUP.md` §2.6 |
| 7 | **No secret appears in git history or in logs.** | I1 **PASS**: logs show `authorization:"[redacted]"`, zero hits for the metrics token, `password123`, or `Bearer eyJ`. I2/I3 **SKIP**: this tree is **not a git repository**, so there is no history to scan and no ignore rule in force. The root `.husky/pre-commit` scanner exists and its patterns were probe-tested, but it cannot fire until `git init` + `npm run hooks:install`. | **HALF-PROVEN** — logs yes, git history untestable. `docs/DEMO_SETUP.md` §4 |

**Scope note on guarantee #3 — read this before quoting it.** The remediation
brief asked for the sentence *"SOS delivery (alert creation + socket broadcast +
FCM push) still succeeds in <200ms."* Only the first of those three legs is
evidenced, so the parenthetical is **not** repeated here as a claim:

- **Alert creation:** 201 in 31–151ms with Redis down. Measured. ✅
- **Socket broadcast:** wardens connected to the **same instance** that created
  the alert got `alert:new` in **~16ms** (D3 evidence log, `09:39:04.026Z`
  created → `09:39:04.042Z` received). Wardens on a **different instance** did
  not get it until Redis returned — **77.159s late** (`09:40:21.185Z`, ~2s after
  `docker start`). This is inherent: the cross-instance transport *is* Redis
  pub/sub, and changing that topology is out of scope. Guarantees #3 and #5
  therefore cannot both hold during an outage.
- **FCM push:** architecturally independent of Redis (fire-and-forget, failures
  never affect the 201), but **never measured** — Firebase is unconfigured and
  the API logged `[push] FCM messaging not initialized — skipping push`.

Say on stage: *"With Redis down the SOS still lands in the database and reaches
every warden on that instance in well under 200ms. Cross-instance fan-out and
the SMS escalation resume when Redis returns."* Do not say "all three delivery
paths survive Redis" — two of them do not, and one was never tested.

---

## 5. API surface

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/login` | public | `{ email, password, role: "STUDENT"\|"WARDEN" }` → `{ token, user }` |
| POST | `/alerts` | STUDENT | `{ type, latitude?, longitude?, locationAccuracy? }` → 201 |
| GET | `/alerts` | WARDEN | Live board only: newest **500** by default, `?limit=` clamped to **1–1000**; `?status=` is a comma-separated list validated against `ALERT_STATUSES` (400 on a bad value), `ALL`/omitted = no filter. Includes student details. Not an audit trail — that is `/alerts/history` |
| PATCH | `/alerts/:id/acknowledge` | WARDEN | 200, 404, or 409 if already acknowledged |
| PATCH | `/alerts/:id/resolve` | WARDEN | ACKNOWLEDGED → RESOLVED. `resolutionNote` **10–500 chars** (trimmed), 400 if shorter, 409 `invalid_transition` from PENDING, idempotent on a double resolve |
| GET | `/alerts/history` | WARDEN | Paginated audit trail; status / date-range / name filters |
| GET | `/alerts/history.csv` | WARDEN | Same filters, 8 audit columns incl. the resolution note |
| GET | `/alerts/:id/escalation-status` | WARDEN | BullMQ job state (no automated test; probed manually in the dry run) |
| POST | `/wardens/fcm-token` | WARDEN | Upsert by token; identity from JWT only |
| DELETE | `/wardens/fcm-token` | WARDEN | Deletes only the caller’s token |
| GET | `/health` | public | `{ status, instanceId, redis, db }`; **200 `degraded`** when Redis is down |
| GET | `/health/ready` | public | **503** when degraded — readiness, not liveness. Never gate SOS on this |
| GET | `/metrics` | `METRICS_TOKEN` | Prometheus text format; 401 without the token |
| POST | `/internal/escalation-result` | `x-internal-token` | The worker's relay into the socket layer; emits `alert:escalated` / `alert:escalation-failed`. Requires `INTERNAL_API_URL` to be set |
| POST | `/loadtest/cleanup` | — | Deletes alerts belonging to `loadtest_student_*` only |

Socket events (server → client only):

- `connected` — `{ id, role, socketId }`
- `alert:new` — to room `wardens`
- `alert:updated` — to `wardens` + `student:<id>` (acknowledge **and** resolve)
- `alert:escalated` — to `wardens`; the worker **confirmed** the SMS. This is the
  only thing that makes the dashboard render the red "SMS sent" pill.
- `alert:escalation-failed` — to `wardens`; the worker's send **failed**. Renders
  "⚠️ Escalation failed". Both are socket-only state: there is no DB column, so a
  page reload loses them and the pill falls back to the elapsed-time states.

Roles are **uppercase** (`STUDENT`/`WARDEN`) in the request body, JWT payload,
and DB-facing code.

---

## 6. Testing

### Commands

```bash
cd backend
npm run test:db:up          # Postgres 16 + Redis 7 (compose) -> backend-postgres-1 / backend-redis-1
npm test                    # 10 files / 75 tests; multi-instance excluded, index.test.ts skips
npm run test:coverage       # thresholds: 70/70/70/70
npm run test:multi-instance # 1 test, spawns API :3001 and :3002 — PORTS MUST BE FREE (stop PM2)
npm test -- tests/multi-instance.test.ts   # equivalent standalone command
RUN_INDEX_TEST=true npm test -- tests/index.test.ts   # opt-in J4 index proof (seeds 5k rows)
npm run test:demo           # resolve flow + history/CSV contract only
npm run test:db:down        # stop + wipe
```

### Last verified results

| Command | Result |
|---|---|
| `npm test` | **9 files passed + 1 skipped (10)**, **74 tests passed + 1 skipped (75)**, **75.61s**. The skip is `index.test.ts` (opt-in). |
| `npm run test:multi-instance` | 1/1 passed; cross-instance events in **384ms**. Requires ports 3001/3002 free — it fails while PM2 holds them (dry-run **L2**, observation N-9). |
| `npm run test:coverage` | 82.53% lines, 75.11% branches, 92.3% functions — **stale**: measured before `hardening`, `demo` and `index` landed. Re-measure before quoting. |
| `npx tsc --noEmit` | pass |
| `npm run build` | pass (`dist/` includes index, instance, health, worker) |

### Test layout

| File | Covers |
|---|---|
| `tests/auth.test.ts` | login, JWT payload/expiry/malformed, role gates |
| `tests/alerts.test.ts` | SOS, GPS optional, ack, 404/409, type validation, board |
| `tests/sockets.test.ts` | warden fan-out, student isolation, handshake auth, listener leaks |
| `tests/escalation.test.ts` | 500ms delay, cancel race, worker guard, Redis-down 201, job id, SMS failure modes |
| `tests/push.test.ts` | multicast batching, string-only FCM data, stale token deletion, push failure |
| `tests/authz.test.ts` | cross-student ack, warden create, FCM identity/ownership |
| `tests/health.test.ts` | `/health` shape + port resolution |
| `tests/hardening.test.ts` | `/metrics` 401 without token, limiter budgets, **SOS break-glass 6th → 201**, 10kb body limit → 413, `/health` stays open |
| `tests/demo.test.ts` | resolve contract: 409 from PENDING, 200 + `resolvedAt`, idempotent double-resolve, student room gets RESOLVED, history filters/pagination, CSV 8 columns |
| `tests/index.test.ts` | **opt-in** (`RUN_INDEX_TEST=true`): seeds 5,000 rows, ANALYZE + EXPLAIN, proves `idx_alerts_status_created` serves the history query. Removes its rows in `afterAll`. |
| `tests/multi-instance.test.ts` | real Redis adapter across two real processes |

### How the suite is wired

- `tests/helpers/env.ts` (setup file) loads `.env.test` and maps TEST_* onto
  the app vars **before any src module is imported**.
- `tests/globalSetup.ts` runs `prisma migrate deploy` once per run.
- `tests/helpers/db.ts` truncates + flushes + optionally runs
  `prisma/test-seed.ts` (10 students, 3 wardens, 0 alerts, bcrypt cost 4).
- Tests create their own rows with unique emails (`factories.ts`), so order
  does not matter within a file.
- Files run **sequentially** (`fileParallelism: false`) because they share one
  test DB. Do not “fix” this by enabling parallel files without giving each
  file its own schema/Redis index.
- Twilio and Firebase are mocked. Prisma is never mocked — tests use real
  Postgres.
- Escalation tests run a real BullMQ Worker in `beforeAll`; `waitUntilReady()`
  makes them fail loudly if Redis/worker is unavailable.
- `ESCALATION_DELAY_MS` is forced to **500** in tests.
- The “ack just before the deadline” test uses **400ms**, not 490ms, because
  490ms leaves ~10ms for HTTP + DB commit and is not deterministic.
- Coverage excludes the two process entrypoints (`src/index.ts`,
  `src/workers/escalation.worker.ts`); the processor is fully covered.

### Known test/CI caveats

- `npm test` excludes `multi-instance.test.ts` via an argv check in
  `vitest.config.ts`. Both `npm run test:multi-instance` and
  `npm test -- tests/multi-instance.test.ts` re-enable it and raise timeouts.
- On Windows, one intermediate coverage run exited 139 and one exited 127
  (runner/spawn failures, empty output). Clean reruns passed. If it recurs,
  rerun once before debugging; switching `pool` to `'forks'` is the fallback
  (about +25s runtime).
- CI (`.github/workflows/test.yml`) uses Node 22, Postgres 16, Redis 7 and
  runs `npm test -- --coverage`. It has **not** been observed running on
  GitHub from this host.

---

## 7. Local development

```bash
# Backend
cd backend
cp .env.example .env                      # set JWT_SECRET + DB URLs
npm install
npx prisma migrate deploy
npm run seed                              # demo users, password123
npm run dev                               # API on :4000
npm run worker                            # second terminal, escalation worker

# Dashboard
cd warden-dashboard && npm install && npm run dev    # :5173
```

Single-instance default port is **4000**. Multi-instance ports are **3001–3003**
(`PORT` or `3001 + NODE_APP_INSTANCE`). The dashboard uses build-time
`VITE_API_URL` (default `http://localhost:4000`); there is no runtime
`?apiUrl=` override.

Flutter: `student_app/`, `flutter run`; API URL via
`--dart-define=API_URL=http://<host>:4000`. Android emulator uses
`10.0.2.2:4000` by default.

---

## 8. Multi-instance / deployment state

- **PM2:** `backend/ecosystem.config.js` — `api` 3× cluster, `worker` 1× fork.
  Ports derive in `src/config/instance.ts`.
- **nginx:** `backend/nginx.conf` — upstream 3001/3002/3003, WebSocket
  upgrade, `proxy_buffering off`, 3600s read timeout, passive health
  (`max_fails=3 fail_timeout=10s`); active `health_check` is nginx Plus only.
  **Documented but NOT run locally, by decision.** No nginx process and no TLS
  terminator exist in this environment. Instance failover is therefore a
  production deployment verification step, not a local dry-run step: dry-run
  drills **F3** (dashboard stays `Disconnected` when its pinned instance is
  killed) and **F4** (POST to the dead port → HTTP 000, no failover) are
  **DEFERRED — production-only**, not system faults. What is proven locally is
  cross-instance broadcast via the Redis adapter (**F1/F2 PASS**,
  `tests/multi-instance.test.ts` asserts <500ms). Do not kill an API instance
  during a demo; see `docs/DEMO_SCRIPT.md` §5:45 and `docs/FUTURE_WORK.md` §6.
- **Sticky sessions:** WebSocket-only clients make affinity unnecessary. If
  polling is enabled, use `hash $remote_addr consistent` or cookie affinity
  (`@socket.io/sticky`). Caveat: all wardens behind one NAT hash to one
  instance, so WebSocket-only is strongly preferred for this deployment.
- **PgBouncer:** documented in `.env.example` and via
  `directUrl = env("DIRECT_DATABASE_URL")`. No local PgBouncer service is
  provisioned; local dev/tests point both URLs at the same direct database.
- **Executed here:** PM2 launch (`api` 3× cluster on 3001-3003, `worker` 1×
  fork), Prometheus + Grafana + Alertmanager via
  `docker-compose.monitoring.yml`. `npm run demo:reset` restarts `api` and
  `worker` through PM2 as its last step, which is what zeroes the in-process
  Prometheus counters.
- **Not executed here:** nginx config, TLS termination, deployed
  kill/reconnect test (F3/F4). These are production deployment checks, not
  automated, and are recorded as DEFERRED rather than FAIL.

Manual verification caveat: two dashboard tabs on one laptop share an IP, so
`hash $remote_addr` may put both on the same instance. To visibly split
instances in a browser, use two devices, or build the dashboard twice with
`VITE_API_URL=http://localhost:3001` and `:3002`. The automated
multi-instance test is the authoritative cross-instance proof.

---

## 9. Known gaps vs. the architecture document

These are deliberately not implemented yet; do not assume they exist:

| Gap | Impact |
|---|---|
| Escalation reconciler (ADR-05) | A job lost while Redis is down is not re-enqueued from Postgres |
| One active alert per student (ADR-03) | No partial unique index; repeat SOS creates another alert |
| Client request idempotency (ADR-11) | No `clientRequestId`; a retried POST can duplicate an alert |
| Append-only audit log (ADR-12) | No `alert_logs`; who-saw-what is only in app logs |
| Cancel / withdraw endpoint | No way back to PENDING and no student-side withdrawal. The only transitions are PENDING → ACKNOWLEDGED → RESOLVED |
| `status` enum | Stored as `String`; invalid values are prevented only in the route |
| Escalation status transition | Worker sends SMS but leaves the alert `PENDING` (by design in Phase 1) |
| Worker scaling | Single worker only; requires distributed locking |
| Deployed failover test (F3/F4) | **DEFERRED — production-only.** No LB runs locally, so killing an instance cannot fail over. Requires nginx; see §8 and `docs/FUTURE_WORK.md` §6 |
| Real-device checks | See `docs/MANUAL_TESTS.md` |

### Rows removed from this table — they were false

The 2026-11-08 dry run found three "not implemented" rows that contradicted the
code. They are deleted above, not softened. What actually exists:

| Claim that was here | Reality (verified) |
|---|---|
| "Resolve / cancel endpoints — only PENDING → ACKNOWLEDGED exists" | `PATCH /alerts/:id/resolve` (`alert.routes.ts:367`) moves ACKNOWLEDGED → RESOLVED, requires a 10–500 char `resolutionNote`, is idempotent on a double resolve, and returns 409 `invalid_transition` from PENDING. The dashboard has a **Resolve** button + note dialog (`AlertDetail.tsx:141`, `ResolveDialog.tsx`). There is still **no cancel/withdraw endpoint** — that part of the old row was true and is now the "Cancel" gap above. |
| "Monitoring / metrics — no Prometheus, Grafana, or `/metrics`" | `GET /metrics` is token-gated by `METRICS_TOKEN`; `docker-compose.monitoring.yml` runs Prometheus + Grafana + Alertmanager and was observed with 4/4 targets `up`; 5 alert rules in `monitoring/rules/hostel.yml`; two provisioned dashboards (`hostel-emergency`, `hostel-emergency-configured`). |
| "Rate limiting — none" | `src/middleware/rateLimiters.ts`: SOS 5/60s **per student** (break-glass: over-limit is allowed through, logged `sos_rate_limit_overridden`, counted in `sos_overrides_total` — never a 429), auth 10/15min per IP, global 100/60s per IP (`/health`, `/health/ready`, `/metrics` exempt), plus an in-memory socket handshake limiter. `RATE_LIMIT_ENABLED=0` disables all of them for tests. |

### Known traps — things that look like bugs and are not (or are, and bite)

| Symptom | Cause / what to check |
|---|---|
| **"SOS hangs when Redis is down"** | Three independent fail-closed paths, all of which must stay open: (1) `enqueueEscalation` awaited in the request handler instead of fire-and-forget; (2) a rate limiter whose Redis store blocks or throws without `passOnStoreError: true`; (3) `/health` returning 503 and a client or probe treating that as "do not send". The current code fails **open** on all three — `rateLimiters.ts:144` sets `passOnStoreError: true`, the store uses a fail-fast connection with a 50ms race, and the escalation enqueue failure is logged while the SOS still returns 201. If SOS latency regresses under a Redis outage, check these three in that order. Measured in drill **E6**. |
| **"Grafana counters don't reset after `demo:reset`"** | prom-client counters live in the **process**, not the database. Deleting alert rows cannot zero `alerts_created_total`. `prisma/demo-reset.ts` therefore ends with `restartMetricsProcesses()` → `pm2 restart api worker --update-env`, which boots fresh registries. It is **best-effort**: under `npm run dev` (no PM2) it prints a warning and you must restart by hand, or the panels keep their pre-reset values. Start PM2 **before** running the reset, not after. |
| **"Seq Scan on `emergency_alerts` at small row counts"** | The planner's choice, not a missing index. At demo size (~23 rows) a 2-page table is cheaper to read sequentially than to descend an index. `idx_alerts_status_created` **is** usable: `SET LOCAL enable_seqscan = off` produces `Index Scan using idx_alerts_status_created`, and at 5,023 rows the planner picks it unforced (`Incremental Sort`, `Presorted Key: a."createdAt"`, rows=26 read to serve LIMIT 25). Reproduce with `npx tsx scripts/perf-seed.ts` (it deletes what it seeds) or the opt-in `tests/index.test.ts`. Measured plans are quoted in `alert.routes.ts:475-533`. Do **not** claim "index scan, not a table scan" on stage at demo size — drill **J4**. |
| **A labelled counter shows "No data" instead of 0** | prom-client emits no child series for a labelled counter until the first `.inc()`, so Prometheus returns `[]`. Every panel that must read 0 when idle uses `or vector(0)`. Drill **H1**. |

Coverage gaps inside the current suite: `GET /alerts/:id/escalation-status`,
push retry/backoff branches, `/health` degraded (Redis/DB down) paths, and
`getIO()` before initialization.

---

## 10. Guidance for the next agent

1. Read `docs/hostel-emergency-system-architecture.md` and this file before
   changing behavior. Several choices are deliberate (409 ack, uppercase
   roles, WebSocket-only, PENDING after escalation).
2. Run `npm test` before and after changes. Never weaken or skip a test to get
   green; fix the cause. The suite is the regression contract.
3. Use the real test Postgres and Redis. Do not mock Prisma.
4. Keep the three Redis roles separate, keep the worker single, and keep
   `io.adapter` before `listen`.
5. Do not add a session store, worker clustering, Kubernetes, or client polling
   unless the user explicitly moves to that phase. Monitoring and rate limiting
   **already exist** (§1, §9) — extend them, do not re-introduce them.
6. When adding an endpoint or changing a contract, update the relevant test
   file header and this progress file.
7. For deployment changes, remember the manual checks: kill an instance and
   confirm reconnect, verify `/health` identity per port, and confirm exactly
   one SMS per escalation.

Production changes introduced for testability (so you do not “simplify” them
away):

- `src/app.ts` — app assembly separated from `src/index.ts` so tests can bind
  the real server to port 0.
- `src/workers/escalation.processor.ts` — handler extracted so the
  already-acknowledged guard can be unit-tested.
- Alert type whitelist in `alert.routes.ts` — added so injection-shaped types
  return 400; Flutter’s `"Medical"` is normalized.
