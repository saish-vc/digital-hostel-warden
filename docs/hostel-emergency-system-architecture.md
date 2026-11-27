# Hostel Emergency Monitoring System

**Architecture, contracts, and delivery plan**

| Field | Value |
|---|---|
| Scope | 500 resident students, one hostel campus (multi-block), 24×7 warden desk |
| Deliverables in this document | Decisions, pinned stack, folder trees, schema, REST + Socket.IO contracts, flows, deployment topology, Phase 0–7 roadmap, risks |
| Out of scope (this document) | Application source code, UI visual design, procurement, DLT paperwork |
| Status | Design complete, awaiting sign-off. No code written. |
| Last revised | 2026-11-05 |

**How to read this document.** Section 1 records the decisions that everything else depends on. Sections 2–8 are the buildable specification. Section 10 is the schedule. Section 11 is the list of things that will page someone at 3 a.m. If you only read two sections, read 1 and 11.

### Contents

| Section | What it answers |
|---|---|
| [0. Executive summary](#0-executive-summary) | What the system does, in one page |
| [1. Architecture decision records](#1-architecture-decision-records) | Why it is built this way; the 15 load-bearing decisions |
| [2. Pinned stack](#2-pinned-stack) | Exact versions and the reason for each |
| [3. Repository structure](#3-repository-structure) | Folder trees for all four deployables |
| [4. Data model](#4-data-model) | SQL DDL, indexes, triggers, privileges, Prisma schema |
| [5. REST API contract](#5-rest-api-contract) | Endpoints, payloads, errors, rate limits |
| [6. Socket.IO contract](#6-socketio-contract) | Handshake, events, guarantees, resync |
| [7. End-to-end flows](#7-end-to-end-flows) | Sequence diagrams including the ack/escalation race |
| [8. Deployment topology](#8-deployment-topology) | Services, connection budget, env vars, releases |
| [9. Observability, security, privacy](#9-observability-security-and-privacy) | Metrics, alarms, controls, medical data |
| [10. Roadmap](#10-roadmap) | Phase 0–7, with Phase 1 as a shippable system |
| [11. Risks and failure modes](#11-risks-and-failure-modes) | 15 risks with detection and mitigation |
| [12. Capacity and performance budgets](#12-capacity-and-performance-budgets) | Load assumptions, latency targets, test plan |
| [13. Open questions](#13-open-questions) | What still needs a decision, and from whom |

---

## 0. Executive summary

A student in distress taps one button. Within roughly one second every on-duty warden's dashboard shows a full-screen alert with the student's name, room, block, blood group, allergies, emergency contacts, and a map pin. The alert is audible. A warden acknowledges it. If nobody acknowledges within 60 seconds, the system escalates automatically: the alert turns red, the escalation is re-pushed, and an SMS goes to the warden on call and the hostel office.

The system is deliberately small. One relational database, one cache/queue, two stateless Node processes, one static dashboard, one mobile app. It is sized so that two engineers can operate it, and so that a single laptop can run the entire stack for development.

Three properties matter more than any feature:

1. **An SOS is never lost.** The alert is committed to Postgres before anyone is notified. Realtime delivery, push, and SMS are all downstream of that commit and can fail independently without losing the alert.
2. **The escalation timer survives a crash.** It is a BullMQ delayed job backed by Redis persistence, with a database reconciler that reschedules anything Redis forgot.
3. **Exactly one state transition per event.** Acknowledge, escalate, resolve, and cancel are serialized with Postgres row locks and a version column, so a race between a warden tapping *Acknowledge* and the worker escalating produces one outcome, not two.

Everything else — the map, the filters, the history, the charts — is presentation over that core.

### Architecture at a glance

```
                     ┌──────────────────────┐
   Flutter app ──────▶│  API  (Node/Express) │──────┐
   (student, APK)     │  ×2 replicas         │      │
        │             └──────────┬───────────┘      │
        │  WebSocket             │ Prisma (pg)      │  SQL
        │                        ▼                  ▼
        │             ┌────────────────────┐   ┌──────────────┐
        └────────────▶│  PgBouncer         │──▶│ PostgreSQL 18│
                      │  transaction mode  │   │  primary     │
   Browser (warden)   └────────────────────┘   └──────────────┘
   React PWA  ───────────────┐                       ▲
        │                    │                       │
        │  WebSocket         ▼                       │
        │             ┌────────────────────┐          │
        └────────────▶│  Socket.IO + Redis │          │
                      │  adapter           │          │
                      └─────────┬──────────┘          │
                                │ pub/sub             │
                      ┌─────────▼──────────┐   ┌──────┴───────┐
                      │ Worker ×2          │──▶│ Redis 8      │
                      │ BullMQ + FCM + SMS │   │ AOF, noevict │
                      └────────────────────┘   └──────────────┘
                                │
                                ▼
                        FCM (warden PWA)  ·  Twilio → MSG91 (SMS)
```

---

## 1. Architecture decision records

Each record states the decision, the reason, and what we accept by choosing it. These are the load-bearing decisions; changing one invalidates whole sections.

### ADR-01 — PostgreSQL is the source of truth; realtime is an optimization

**Decision.** Every alert, acknowledgement, escalation, and resolution is a committed row in Postgres before any notification is attempted. Socket.IO and FCM are delivery mechanisms layered on top.

**Why.** Realtime transports lie. A socket can be "connected" while the tab is suspended, a phone can be in Doze, a load balancer can drop an idle connection. If the socket is the source of truth, the dashboard silently diverges from reality. With Postgres as the truth, the worst case is a stale screen that repairs itself on the next refetch.

**Consequences.** Every client refetches a REST snapshot on connect, on reconnect, and when the tab becomes visible. We accept one extra query per reconnect for correctness.

### ADR-02 — Escalation is a row-locked state machine, not a timer callback

**Decision.** The escalation worker does not "send an SMS because 60 seconds passed." It performs a conditional, lock-protected transition `PENDING → ESCALATED` and only the transaction that wins the transition is allowed to notify.

**Why.** Acknowledge and escalate will race. The warden's tap and the worker's timer are independent processes; both fire near t=60s routinely. Without serialization you get an alert that is acknowledged *and* escalated, or an SMS sent for an alert that was already handled. That erodes trust in the system faster than any outage.

**Consequences.** Use `SELECT ... FOR UPDATE` (or a single `UPDATE ... WHERE status = 'PENDING' RETURNING *`) inside a short transaction. The loser of the race must re-read and act on the actual state, not assume failure means "retry."

### ADR-03 — At most one active alert per student

**Decision.** A partial unique index on `(student_id) WHERE status IN ('PENDING','ACKNOWLEDGED','ESCALATED')` enforces a single live alert per student. Repeat taps during an active alert return the existing alert rather than creating a second one.

**Why.** A frightened student will tap five times. Five simultaneous alerts for one person are noise that hides the real emergency, and they break the one-alert-one-escalation invariant.

**Consequences.** The create endpoint is idempotent by student, not just by request ID. If a student genuinely has a second emergency while one is open, the warden resolves the first and the student can raise another. We accept that as an acceptable, documented limitation.

### ADR-04 — WebSocket-only transport; no sticky sessions

**Decision.** Socket.IO clients connect with `transports: ['websocket']` only. No HTTP long-polling fallback, no load-balancer cookie affinity.

**Why.** Long-polling requires every request from a session to reach the same backend instance. On Railway/Render that means either session affinity (fragile, provider-specific) or a shared session store *and* still leaves upgrade races. Disabling polling removes an entire class of "worked on my machine, dropped in production" bugs.

**Consequences.** We accept that a small number of restrictive networks block WebSocket. Those clients degrade to REST polling every 15 seconds while the tab is visible, which is an explicit fallback in the dashboard, not an accidental one.

### ADR-05 — BullMQ delayed jobs for escalation with a DB reconciler backstop

**Decision.** On alert creation, a delayed job `esc:{alertId}` is enqueued with a 60-second delay and a deterministic `jobId`. Redis runs with AOF and `noeviction`. A periodic worker task scans Postgres for `PENDING` alerts whose `escalation_due_at` has passed and whose job is missing, and re-enqueues an immediate job.

**Why.** Delayed jobs survive process restarts because the schedule lives in Redis, not in a `setTimeout`. But Redis is not durable in the way Postgres is: a managed Redis can be flushed, failed over to an empty replica, or evicted if misconfigured. The reconciler makes the database, not the queue, the canonical authority on "this alert is overdue."

**Consequences.** Duplicate job execution is possible and expected; the state machine in ADR-02 makes duplicates harmless. The reconciler must be cheap — a partial index on `escalation_due_at WHERE status = 'PENDING'` keeps it a small index scan.

### ADR-06 — API and worker are separate processes

**Decision.** `apps/api` serves HTTP and Socket.IO. `apps/worker` consumes BullMQ queues and owns FCM/SMS dispatch and the reconciler. They share a Prisma schema package but deploy independently.

**Why.** Escalation fan-out is bursty and can block. If it runs inside the API process, an FCM rate-limit backoff can starve HTTP handlers. Separate processes also let us scale the worker without scaling sockets, and let a worker crash-loop without taking down the dashboard.

**Consequences.** Two deployables, two health checks, two sets of logs. The worker exposes no HTTP API — only a metrics endpoint and a heartbeat table/Redis key.

### ADR-07 — All wardens receive all alerts

**Decision.** Every connected warden joins the room `wardens` and receives every alert. `hostel_block` is display and filtering metadata, not an authorization boundary.

**Why.** At 500 students and a handful of wardens, routing by block adds a delivery failure mode ("no warden was subscribed to that block") for a marginal noise reduction. Emergency response favors over-notification. Coverage is a staffing problem, not a routing problem.

**Conversely.** This is explicitly *not* the design for a multi-campus deployment. Beyond ~5,000 students or multiple sites, revisit with `warden:{block}` rooms and an explicit coverage map.

### ADR-08 — Mutations are REST; Socket.IO is server→client only

**Decision.** Acknowledge, resolve, cancel, and create are HTTP endpoints. There are no client→server business events over the socket. The socket carries fan-out and presence only.

**Why.** HTTP gives us status codes, idempotency keys, retries with clear semantics, audit middleware, and normal proxy behavior. Socket acknowledgements do not compose with offline retry the same way, and mixing the two makes the client's failure handling ambiguous. One mutation path is easier to secure and to test.

**Consequences.** A warden whose socket is down can still acknowledge via REST; they just do not see live updates until they reconnect and refetch.

### ADR-09 — Warden notifications use FCM Web Push; SMS is the escalation channel

**Decision.** The React dashboard is an installable PWA. Wardens opt in to Web Push via FCM. SMS (Twilio primary, MSG91 fallback) is reserved for escalation, not for the initial alert.

**Why.** At the time of this decision there was no native warden app. Web Push reaches a locked phone or a backgrounded browser without building and shipping a second mobile client. A native Android warden client now also ships (`warden_app/`); Web Push remains the dashboard's path and the fallback. SMS costs money per message and is slow to compose; using it for every alert at 500-student scale would be wasteful, but it is the right tool when a human has failed to respond.

**Consequences.** Web Push on iOS requires the PWA to be installed to the home screen and iOS 16.4+. We must document that and treat "warden has installed the PWA and granted notification permission" as an operational checklist item, not an assumption.

### ADR-10 — PgBouncer in transaction mode with a small per-process pool

**Decision.** All application traffic goes through PgBouncer (`pool_mode=transaction`, `default_pool_size=20`, `max_prepared_statements=100`). Each Node process caps its driver pool at 5. Migrations and `prisma migrate` use `DIRECT_URL` straight to Postgres.

**Why.** Two API replicas plus two worker replicas at a naive 10 connections each is 40 backends for a workload that needs maybe 8 at peak. Postgres on a small managed plan has a hard connection ceiling, and connection storms during a redeploy are a classic self-inflicted outage. Transaction pooling is safe here because we use no session-level state (no `SET`, no advisory locks held across statements, no cursors).

**Consequences.** `LISTEN/NOTIFY` and session-scoped features are unavailable through the pooler. We do not use them. Prisma 7's driver adapter exposes `max`, so the limit is enforced in code rather than by a URL parameter.

### ADR-11 — Client-generated idempotency key on alert creation

**Decision.** The Flutter app generates a UUID `clientRequestId` per SOS attempt and reuses it across retries. The server stores it with a unique constraint per student and returns the original alert on replay.

**Why.** Mobile networks drop responses. A student taps SOS, the request succeeds, the response is lost, the app retries. Without idempotency that is a second alert; with it, the retry is a no-op that returns the same alert ID.

**Consequences.** Requires the client to persist the pending request ID to secure storage before the first attempt, including across app restarts. That is a small amount of client complexity for a large correctness win.

### ADR-12 — Append-only audit log, separate from alert state

**Decision.** `alert_logs` records every state change and every notification attempt, with actor, timestamp, request ID, IP, and user agent. The application role has `INSERT` and `SELECT` on this table and no `UPDATE`/`DELETE`.

**Why.** Medical emergencies generate disputes and, in some jurisdictions, regulatory obligations. "Who saw this alert and when" must be answerable years later, and must not be editable by the same code path that serves requests. Separating the log from the mutable alert row also means a bad migration cannot rewrite history.

**Consequences.** Storage grows unbounded; partition or archive after 24 months. Redaction requests are handled by archiving rows to cold storage with the identifiers replaced, not by deleting audit rows silently.

### ADR-13 — Capture a position fix, do not stream location

**Decision.** The app obtains one location fix at SOS time (and a fresher one if the student moves the pin), sends it with the alert, and stops. There is no continuous tracking.

**Why.** Continuous tracking is a privacy liability, a battery drain, and an operational burden with little added value indoors where GPS is poor anyway. Wardens need "which building, which floor, roughly where," not a breadcrumb trail.

**Consequences.** Indoor accuracy will be poor (20–50 m). The UI must show an accuracy circle and never imply precision it does not have. A "last known location" fallback with a visible staleness timestamp is required.

### ADR-14 — Fail closed on auth, fail open on fan-out

**Decision.** If the token cannot be verified, the request is rejected. If Redis pub/sub or FCM is unavailable, the alert is still accepted, committed, and served by REST polling; delivery is retried.

**Why.** These two failure modes have opposite safe directions. Admitting an unauthenticated caller to medical data is unrecoverable. Dropping a notification is recoverable as long as the data is durable and a human eventually looks at a screen.

**Consequences.** The dashboard must show a visible "live updates degraded" banner when the socket is disconnected, so wardens know to refresh rather than trust a quiet screen.

### ADR-15 — Single region, single primary database, no sharding

**Decision.** One region close to the hostel. One Postgres primary, no read replicas initially. No sharding, no multi-region.

**Why.** 500 students produce a few hundred writes on a bad day. Sharding or multi-region would add operational surface with zero user-visible benefit. Latency to a single region is dominated by mobile network RTT, not by our database.

**Consequences.** A regional outage is a full outage. That is accepted and documented; the mitigation is a documented manual failover runbook and the fact that a phone call still works.

---

## 2. Pinned stack

Versions are pinned exactly. Pin the same values in `package.json`/`pubspec.yaml` and in CI; do not use caret ranges for server dependencies. Verify availability in your registry mirror at install time — a version that resolves on one machine and not in CI is a two-hour detour during a demo week.

### 2.1 Backend

| Component | Version | Why this, and not something else |
|---|---|---|
| Node.js | 26.13.0 (LTS) | Even-numbered LTS line with the longest support window at build time. Native `--env-file`, built-in test runner, and a stable `fetch` remove several dependencies. Avoid odd-numbered "current" lines for a system that must be patched at 2 a.m. |
| TypeScript | 7.0.2 | Native compiler port; materially faster type-checking on a monorepo, and the 7.x line is what current `@types/node` targets. Strict mode on. |
| Express | 5.2.x | Boring, ubiquitous, and every middleware we need exists. Express 5's native async error propagation removes the wrapper boilerplate that caused unhandled rejections in v4. |
| Socket.IO | 4.8.x | Rooms, reconnection with backoff, and a first-class Redis adapter. Raw `ws` would mean reimplementing reconnect, rooms, and acknowledgement semantics. |
| `@socket.io/redis-adapter` | 8.3.0 | The only supported adapter for Socket.IO 4.8 with Redis 6+. Uses `PUBLISH`/`PSUBSCRIBE`, which is what we want. |
| `redis` | 6.3.1 | Adapter client. Modern promise API, no callback shims. |
| `ioredis` | 6.0.0 | BullMQ's required client; BullMQ depends on its Lua scripting and blocking-command semantics. Two Redis clients is intentional — do not try to unify them. |
| BullMQ | 6.7.0 | Delayed jobs, deterministic job IDs, retries with backoff, and a repeatable-job API. A hand-rolled `setTimeout` + table is exactly the thing that breaks on restart. |
| Prisma | 7.10.1 | Typed schema, migrations, and a driver adapter that lets us control the pg pool. |
| `@prisma/adapter-pg` | 7.10.1 | Must match the Prisma minor exactly. Provides `PrismaPg({ max: 5 })`. |
| `pg` | 8.23.1 | Underlying driver for the adapter and for raw queries in the reconciler. |
| `zod` | 4.x | Runtime validation at the HTTP boundary. Types alone do not protect against a malformed body. |
| `pino` | 9.x | Structured JSON logs with low overhead; redaction of `authorization` and `password` configured centrally. |
| `helmet` | 8.x | Baseline security headers; HSTS, `nosniff`, frame denial. |
| `express-rate-limit` | 8.x | Per-route and per-identity limits, with a Redis store so limits hold across replicas. |
| `jsonwebtoken` | 9.x | Access and refresh token signing. Short-lived access tokens (15 min), rotating refresh tokens (30 days) stored hashed. |
| `bcrypt` | 6.x | Password hashing with a per-password cost tuned to ~250 ms on the target instance. |
| `firebase-admin` | 14.5.0 | FCM batch send and installation-ID handling. |
| `twilio` | 6.2.0 | Primary SMS provider. Thin official SDK; we call `messages.create` directly. |
| `prom-client` | 15.x | Prometheus metrics for HTTP, sockets, queue depth, and alert latency. |

### 2.2 Data and infrastructure

| Component | Version | Why |
|---|---|---|
| PostgreSQL | 18.6 | Current stable. Native `uuidv7()` gives time-ordered primary keys without an extension, which keeps B-tree inserts sequential. |
| PgBouncer | 1.26.1 | Connection multiplexing in transaction mode. Managed via Railway's template or a sidecar. |
| Redis | 8.10.3 | BullMQ backend and Socket.IO pub/sub. Configured with AOF `everysec`, `maxmemory-policy noeviction` (evicting queue keys would silently drop escalations), and a password. |
| Prometheus | 3.16.0 | Scrapes `/metrics` from API and worker. |
| Grafana | 13.3.0 | Dashboards for the metrics in §9. |
| Docker | 28.x | Local parity and the worker image. |

### 2.3 Dashboard

| Component | Version | Why |
|---|---|---|
| React | 19.3.1 | Concurrent rendering keeps the alert list responsive while a burst of updates arrives. |
| Vite | 8.3.6 | Fast dev server and a small production bundle; the dashboard is a static SPA on Vercel. |
| TypeScript | 7.0.2 | Shared config with the backend where practical. |
| React Router | 7.18.5 | Data-router patterns for the authenticated shell and nested routes. |
| TanStack Query | 5.106.1 | Server-state cache, background refetch, and the reconnect/visibility refetch hooks that implement ADR-01. |
| Zustand | 5.0.16 | Small client-state store for the audio-unlock flag, selected filters, and connection banner. |
| Leaflet | 1.9.4 | Map rendering without a paid SDK. |
| react-leaflet | 5.0.0 | React bindings compatible with Leaflet 1.9 and React 19. |
| Tailwind CSS | 4.3.4 | Utility styling with the v4 engine; no separate config file needed. |
| Firebase JS SDK | 13.2.0 | Web Push token acquisition for the PWA. |
| `vite-plugin-pwa` | latest compatible | Manifest, service worker, install prompt. Pin the resolved version in the lockfile. |

### 2.4 Student app

| Component | Version | Why |
|---|---|---|
| Flutter | 3.47.9 (stable) | Single codebase for Android and iOS; Android is the shipping target (sideloaded APK / App Distribution). |
| Dart | 3.13.7 | Ships with the pinned Flutter SDK. |
| `flutter_riverpod` | 3.4.3 | Explicit, testable state for the SOS flow and auth session. |
| `go_router` | 18.1.3 | Declarative routing with a redirect guard for unauthenticated state. |
| `dio` | 5.11.1 | Interceptors for auth refresh, retry with idempotency key, and request logging. |
| `socket_io_client` | 3.1.6 | Protocol-compatible with the server; matches Socket.IO 4.x. |
| `flutter_secure_storage` | 11.2.0 | Keychain/Keystore-backed storage for access and refresh tokens. Never `SharedPreferences`. |
| `geolocator` | 14.1.2 | One-shot position with permission handling and a timeout. |
| `firebase_messaging` | 17.0.1 | Push for warden-side updates and student-side "help is coming" confirmations. |
| `flutter_local_notifications` | latest compatible | Full-screen intent style notification on Android for the acknowledgement confirmation. Pin at install. |
| `connectivity_plus` | latest compatible | Distinguishes "no network" from "server rejected" in the SOS failure UI. |

### 2.5 Deliberately not chosen

| Option | Why not |
|---|---|
| Kafka / RabbitMQ | Operationally heavier than BullMQ for two queues and a few hundred jobs a day. Nobody on a two-person team should be paged for a Kafka partition. |
| Kubernetes | Four Deployments and a managed database do not justify a control plane. Railway services give us the same primitives with a fraction of the surface. |
| GraphQL | One client, one server, one shape. REST with typed zod schemas is simpler to secure and to cache. |
| MongoDB | The access patterns are relational (student → alerts → logs) and the escalation correctness argument depends on transactions and unique indexes. |
| Microservices | The domain has one bounded context. Splitting API and worker is an operational split, not a service-boundary claim. |
| Sticky sessions + polling | See ADR-04. |
| Continuous GPS tracking | See ADR-13. |
| Native warden app | Shipped for Android in `warden_app/` (FCM + full-screen alarm). The PWA remains the desktop/iOS path; see `docs/WARDEN_APP_RUNBOOK.md`. |

---

## 3. Repository structure

One repository, one lockfile per ecosystem, four deployables. The monorepo exists because the TypeScript projects share types and the Prisma schema; it does not imply a shared runtime.

```
hostel-emergency/
├── apps/
│   ├── api/                    # Node/Express + Socket.IO  (deployable 1)
│   ├── worker/                 # BullMQ consumers         (deployable 2)
│   ├── dashboard/              # React PWA → Vercel       (deployable 3)
│   └── student-app/            # Flutter → APK/IPA        (deployable 4)
├── packages/
│   ├── db/                     # Prisma schema, migrations, generated client
│   ├── contracts/              # zod schemas + shared TS types for REST/socket payloads
│   └── config/                 # eslint, tsconfig, prettier, tailwind preset
├── infra/
│   ├── docker-compose.yml      # local: postgres, redis, pgbouncer, prometheus, grafana
│   ├── pgbouncer/pgbouncer.ini
│   ├── prometheus/prometheus.yml
│   ├── grafana/dashboards/*.json
│   └── railway/                # service definitions, env templates, runbooks
├── docs/
│   ├── hostel-emergency-system-architecture.md   # this file
│   ├── adr/                    # one file per ADR once they start changing
│   ├── runbooks/
│   │   ├── escalation-not-firing.md
│   │   ├── redis-loss.md
│   │   └── database-failover.md
│   └── api/openapi.yaml
├── .github/workflows/
│   ├── ci.yml
│   ├── deploy-api.yml
│   ├── deploy-worker.yml
│   ├── deploy-dashboard.yml
│   └── release-apk.yml
├── package.json                # npm workspaces
├── package-lock.json
└── README.md
```

### 3.1 `apps/api`

```
apps/api/
├── src/
│   ├── index.ts                # bootstrap: env validation, db connect, http server, socket, shutdown
│   ├── app.ts                  # express app assembly (no listen) — importable by tests
│   ├── env.ts                  # zod-validated process.env; fails fast on missing secrets
│   ├── http/
│   │   ├── router.ts           # mounts /api/v1
│   │   ├── middleware/
│   │   │   ├── auth.ts         # verifies access JWT → req.auth = { id, role }
│   │   │   ├── requireRole.ts  # role guard, applied per-route (never globally assumed)
│   │   │   ├── validate.ts     # zod body/query/params → 400 VALIDATION_ERROR
│   │   │   ├── requestId.ts    # ULID per request, echoed in errors and logs
│   │   │   ├── rateLimit.ts    # Redis-backed limiters (auth, sos, read)
│   │   │   └── errorHandler.ts # single error envelope (§5.2)
│   │   ├── routes/
│   │   │   ├── auth.routes.ts
│   │   │   ├── students.routes.ts
│   │   │   ├── wardens.routes.ts
│   │   │   ├── alerts.routes.ts
│   │   │   ├── devices.routes.ts
│   │   │   └── health.routes.ts
│   │   └── presenters/         # row → API DTO (never leak password_hash / medical fields to students)
│   ├── services/
│   │   ├── auth.service.ts
│   │   ├── alert.service.ts    # create/ack/resolve/cancel; owns transactions
│   │   ├── escalation.service.ts # enqueue/cancel delayed jobs
│   │   ├── notification.service.ts # emit socket events + enqueue push job
│   │   └── token.service.ts
│   ├── realtime/
│   │   ├── io.ts               # Socket.IO server, redis adapter, auth middleware
│   │   ├── rooms.ts            # 'wardens', 'student:{id}'
│   │   └── events.ts           # typed emit helpers (§6)
│   ├── observability/
│   │   ├── logger.ts
│   │   └── metrics.ts          # prom-client registries + /metrics handler
│   └── types/express.d.ts      # req.auth augmentation
├── test/
│   ├── unit/
│   ├── integration/            # supertest against a real Postgres + Redis (testcontainers or compose)
│   └── fixtures/
├── Dockerfile
├── package.json
└── tsconfig.json
```

### 3.2 `apps/worker`

```
apps/worker/
├── src/
│   ├── index.ts                # boot queues, workers, schedulers, graceful shutdown
│   ├── env.ts
│   ├── queues.ts               # queue names, default job options, backoff policy
│   ├── processors/
│   │   ├── escalation.processor.ts   # the 60s timer → lock-protected transition
│   │   ├── push.processor.ts         # FCM fan-out with batching/backoff
│   │   └── sms.processor.ts          # Twilio → MSG91 fallback
│   ├── reconciler.ts           # scans overdue PENDING alerts, re-enqueues missing jobs
│   ├── heartbeat.ts            # writes worker liveness key + metric
│   └── metrics/server.ts       # :9091/metrics
├── test/
├── Dockerfile
└── package.json
```

### 3.3 `apps/dashboard`

```
apps/dashboard/
├── src/
│   ├── main.tsx
│   ├── App.tsx                 # router + providers (QueryClient, auth)
│   ├── routes/
│   │   ├── login.tsx
│   │   ├── alerts.tsx          # live board (default route)
│   │   ├── alert.$id.tsx       # detail drawer/page
│   │   ├── history.tsx         # filtered history
│   │   └── students.$id.tsx
│   ├── features/
│   │   ├── auth/               # useLogin, token store, refresh interceptor
│   │   ├── alerts/             # useAlerts, useAcknowledge, AlertCard, StatusPill, filters
│   │   ├── map/                # Leaflet map, accuracy circle, fallback tile handling
│   │   ├── audio/              # useAlarmAudio — unlock on first gesture, loop until ack
│   │   └── push/               # FCM registration, permission UX, token refresh
│   ├── lib/
│   │   ├── api.ts              # fetch wrapper: auth header, 401 refresh, error envelope
│   │   ├── socket.ts           # singleton socket, websocket-only, reconnect hooks
│   │   └── queryClient.ts      # staleTime, retry policy, refetchOnWindowFocus
│   ├── components/             # layout, banner, dialogs, skeletons
│   └── styles/
├── public/
│   ├── manifest.webmanifest
│   └── sw.ts                   # push handler, notificationclick deep link
├── vite.config.ts
└── package.json
```

### 3.4 `apps/student-app`

```
apps/student-app/
├── lib/
│   ├── main.dart
│   ├── app.dart                # MaterialApp.router + providers
│   ├── core/
│   │   ├── env.dart
│   │   ├── router.dart         # go_router with auth redirect
│   │   ├── dio_client.dart     # base URL, refresh interceptor, idempotency header
│   │   ├── secure_store.dart
│   │   └── result.dart         # typed success/failure, no raw exceptions in UI
│   ├── features/
│   │   ├── auth/               # login screen, session controller, token refresh
│   │   ├── sos/
│   │   │   ├── sos_button.dart
│   │   │   ├── sos_controller.dart   # fix → requestId → POST → retry → track
│   │   │   ├── confirm_sheet.dart    # type picker (medical/fire/security/…)
│   │   │   └── active_alert_view.dart
│   │   ├── location/           # permission flow, one-shot fix, accuracy handling
│   │   ├── push/               # FCM token registration + refresh
│   │   └── profile/            # room, blood group, allergies, contacts (read-only + edit request)
│   └── shared/widgets/
├── android/
│   └── app/src/main/AndroidManifest.xml   # location + notification permissions, foreground service if added later
├── ios/
├── test/
└── pubspec.yaml
```

### 3.5 `packages/db`

```
packages/db/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   │   ├── 0001_init/migration.sql
│   │   ├── 0002_indexes/migration.sql
│   │   ├── 0003_state_machine/migration.sql
│   │   └── 0004_log_privileges/migration.sql
│   └── seed.ts                 # 500 students, 6 wardens, 3 blocks, demo alerts
├── src/
│   ├── client.ts               # PrismaPg({ max: 5 }) singleton
│   ├── raw.ts                  # typed raw query helpers (reconciler, locks)
│   └── index.ts
└── package.json
```

### 3.6 `packages/contracts`

Single source of truth for payload shapes. The dashboard imports the types directly; the Flutter app mirrors them in `lib/core/dto/` with a contract test that asserts field names against a checked-in JSON fixture generated from zod.

```
packages/contracts/
├── src/
│   ├── auth.ts
│   ├── alerts.ts
│   ├── students.ts
│   ├── devices.ts
│   ├── socket-events.ts
│   ├── errors.ts               # error codes enum, shared with both clients
│   └── index.ts
└── package.json
```

---

## 4. Data model

### 4.1 Modelling notes

- **IDs.** `uuid` primary keys generated by Postgres 18's `uuidv7()`. Time-ordered, so index inserts stay at the right edge of the B-tree, and IDs are safe to expose in URLs (unlike sequential integers). Prisma declares `@default(dbgenerated("uuidv7()"))`.
- **Timestamps.** `timestamptz` everywhere, stored UTC. The server is the only clock that matters for state transitions; client timestamps are recorded as claims in metadata, never trusted for ordering.
- **Money/coordinates.** `double precision` for latitude/longitude is sufficient (≈1 cm at 7 decimal places) and avoids the `numeric`→JS-string friction in Prisma. Accuracy is in metres.
- **Soft vocabulary.** `status` is a Postgres enum so invalid states are unreachable at the storage layer, not merely discouraged in code.
- **Medical data.** `blood_group`, `allergies`, `conditions`, `emergency_contact_*` live on `students` and are returned only to `WARDEN`/`ADMIN` roles. Access is logged.
- **Deletion.** Students and wardens are deactivated (`is_active = false`), never hard-deleted, because alerts reference them. A GDPR-style erasure request is handled by pseudonymising PII columns and keeping the alert rows intact.

### 4.2 Enums

```sql
CREATE TYPE alert_type AS ENUM (
  'MEDICAL', 'FIRE', 'SECURITY', 'MENTAL_HEALTH', 'OTHER'
);

CREATE TYPE alert_status AS ENUM (
  'PENDING',        -- created, awaiting warden acknowledgement
  'ACKNOWLEDGED',   -- a warden has taken ownership
  'ESCALATED',      -- 60s elapsed without acknowledgement; SMS sent
  'RESOLVED',       -- response complete
  'CANCELLED'       -- student or warden cancelled (false alarm)
);

CREATE TYPE location_source AS ENUM (
  'GPS', 'NETWORK', 'LAST_KNOWN', 'MANUAL', 'UNKNOWN'
);

CREATE TYPE device_platform AS ENUM ('ANDROID', 'IOS', 'WEB');

CREATE TYPE fcm_target_kind AS ENUM (
  'REGISTRATION_TOKEN',  -- legacy FCM token
  'INSTALLATION_ID'      -- Firebase Installation ID (2026+ path)
);

CREATE TYPE alert_actor_type AS ENUM ('STUDENT', 'WARDEN', 'SYSTEM');

CREATE TYPE warden_role AS ENUM ('WARDEN', 'SUPERVISOR', 'ADMIN');
```

`MENTAL_HEALTH` is a first-class type rather than an `OTHER` + free-text tag because it changes the response protocol (trained responder, quieter UI, different SMS copy) and because free-text types cannot be filtered reliably.

### 4.3 Tables

```sql
-- ─────────────────────────────────────────────────────────────
-- People
-- ─────────────────────────────────────────────────────────────
CREATE TABLE students (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  roll_number         text NOT NULL UNIQUE,
  email               text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  full_name           text NOT NULL,
  phone               text,
  hostel_block        text NOT NULL,
  room_number         text NOT NULL,
  blood_group         text,
  allergies           text,
  conditions          text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  is_active           boolean NOT NULL DEFAULT true,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wardens (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  email               text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  full_name           text NOT NULL,
  phone               text,
  role                warden_role NOT NULL DEFAULT 'WARDEN',
  assigned_block      text,             -- display/coverage metadata only (ADR-07)
  is_on_duty          boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Refresh tokens (rotating, hashed at rest)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  token_hash          text NOT NULL UNIQUE,      -- sha256 of the opaque token
  subject_type        text NOT NULL CHECK (subject_type IN ('STUDENT','WARDEN')),
  student_id          uuid REFERENCES students(id) ON DELETE CASCADE,
  warden_id           uuid REFERENCES wardens(id) ON DELETE CASCADE,
  family_id           uuid NOT NULL,             -- rotation family for reuse detection
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  replaced_by_id      uuid REFERENCES refresh_tokens(id),
  user_agent          text,
  ip                  text,   -- validated in app; text avoids Prisma inet drift
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ( (student_id IS NOT NULL)::int + (warden_id IS NOT NULL)::int = 1 )
);

-- ─────────────────────────────────────────────────────────────
-- Alerts — the core table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE emergency_alerts (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  student_id             uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  type                   alert_type NOT NULL,
  status                 alert_status NOT NULL DEFAULT 'PENDING',

  -- idempotency (ADR-11)
  client_request_id      uuid NOT NULL,

  -- location snapshot (ADR-13)
  latitude               double precision,
  longitude              double precision,
  location_accuracy_m    double precision,
  location_source        location_source NOT NULL DEFAULT 'UNKNOWN',
  location_captured_at   timestamptz,

  -- free-text detail from the student (bounded)
  note                   text CHECK (char_length(note) <= 500),

  -- escalation bookkeeping (ADR-02, ADR-05)
  escalation_due_at      timestamptz,            -- created_at + 60s, nullable once acked
  escalation_enqueued_at timestamptz,
  escalation_claimed_at  timestamptz,            -- set by the winning transaction
  escalated_at           timestamptz,
  escalation_attempts    integer NOT NULL DEFAULT 0,

  -- acknowledgement
  acknowledged_by        uuid REFERENCES wardens(id) ON DELETE SET NULL,
  acknowledged_at        timestamptz,
  acknowledge_note       text,

  -- resolution
  resolved_by            uuid REFERENCES wardens(id) ON DELETE SET NULL,
  resolved_at            timestamptz,
  resolution_notes       text,

  -- cancellation
  cancelled_at           timestamptz,
  cancel_reason          text,

  -- SMS outcome (only meaningful when status reached ESCALATED)
  sms_sent_at            timestamptz,
  sms_provider           text,
  sms_provider_message_id text,

  -- optimistic concurrency / debugging
  version                integer NOT NULL DEFAULT 1,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  UNIQUE (student_id, client_request_id)
);

-- ADR-03: at most one live alert per student
CREATE UNIQUE INDEX one_active_alert_per_student
  ON emergency_alerts (student_id)
  WHERE status IN ('PENDING', 'ACKNOWLEDGED', 'ESCALATED');

-- Dashboard live board: newest first, filtered by status
CREATE INDEX alerts_status_created_idx
  ON emergency_alerts (status, created_at DESC);

CREATE INDEX alerts_student_idx
  ON emergency_alerts (student_id);

CREATE INDEX alerts_student_created_idx
  ON emergency_alerts (student_id, created_at DESC);

CREATE INDEX alerts_type_created_idx
  ON emergency_alerts (type, created_at DESC);

-- History range scans
CREATE INDEX alerts_created_idx
  ON emergency_alerts (created_at DESC);

-- Reconciler: only overdue, still-pending rows
CREATE INDEX alerts_escalation_due_idx
  ON emergency_alerts (escalation_due_at)
  WHERE status = 'PENDING';
```

```sql
-- ─────────────────────────────────────────────────────────────
-- Push targets (wardens' browsers/phones; students' devices)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE device_tokens (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  platform           device_platform NOT NULL,
  target_kind        fcm_target_kind NOT NULL,
  target             text NOT NULL,             -- registration token OR installation ID
  warden_id          uuid REFERENCES wardens(id) ON DELETE CASCADE,
  student_id         uuid REFERENCES students(id) ON DELETE CASCADE,
  device_label       text,
  user_agent         text,
  is_active          boolean NOT NULL DEFAULT true,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (target_kind, target),
  CHECK ( (warden_id IS NOT NULL)::int + (student_id IS NOT NULL)::int = 1 )
);

CREATE INDEX device_tokens_warden_idx
  ON device_tokens (warden_id)
  WHERE is_active AND warden_id IS NOT NULL;

CREATE INDEX device_tokens_student_idx
  ON device_tokens (student_id)
  WHERE is_active AND student_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- Append-only audit log (ADR-12)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE alert_logs (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  alert_id            uuid NOT NULL REFERENCES emergency_alerts(id) ON DELETE RESTRICT,
  event               text NOT NULL,            -- ALERT_CREATED, ALERT_ACKNOWLEDGED, ESCALATION_SMS_SENT, …
  from_status         alert_status,
  to_status           alert_status,
  actor_type          alert_actor_type NOT NULL,
  actor_student_id    uuid REFERENCES students(id) ON DELETE SET NULL,
  actor_warden_id     uuid REFERENCES wardens(id) ON DELETE SET NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id          text,
  ip                  text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CHECK ( (actor_student_id IS NOT NULL)::int + (actor_warden_id IS NOT NULL)::int <= 1 )
);

CREATE INDEX alert_logs_alert_created_idx
  ON alert_logs (alert_id, created_at);

CREATE INDEX alert_logs_created_idx
  ON alert_logs (created_at DESC);
```

### 4.4 State machine enforcement

Enforced twice, deliberately: a trigger (works even for raw SQL and psql sessions) and the service layer (gives a specific error code before hitting the database).

```sql
CREATE OR REPLACE FUNCTION enforce_alert_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'PENDING'      AND NEW.status IN ('ACKNOWLEDGED','ESCALATED','CANCELLED'))
    OR (OLD.status = 'ACKNOWLEDGED' AND NEW.status IN ('RESOLVED'))
    OR (OLD.status = 'ESCALATED'    AND NEW.status IN ('ACKNOWLEDGED','RESOLVED'))
  ) THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER alert_transition_guard
  BEFORE UPDATE ON emergency_alerts
  FOR EACH ROW EXECUTE FUNCTION enforce_alert_transition();
```

```sql
-- Reset escalation bookkeeping on acknowledgement, so a stale job is a no-op.
CREATE OR REPLACE FUNCTION clear_escalation_on_ack()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'ACKNOWLEDGED' AND OLD.status IN ('PENDING','ESCALATED') THEN
    NEW.escalation_due_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER alert_clear_escalation
  BEFORE UPDATE ON emergency_alerts
  FOR EACH ROW EXECUTE FUNCTION clear_escalation_on_ack();
```

Note the two triggers both run `BEFORE UPDATE`. Postgres fires them in name order (`alert_clear_escalation` before `alert_transition_guard`), and neither reads the other's fields, so the order is not load-bearing. Keep it that way.

The important consequence: **once acknowledged, `escalation_due_at` is NULL, so the reconciler can never pick the alert up again.** The in-flight BullMQ job will still fire, find the row is no longer `PENDING`, and exit without sending SMS. Belt and braces.

> There is a residual race worth stating plainly: the worker may have already won the `PENDING → ESCALATED` transition at t=59.998s when the warden's acknowledge lands at t=60.001s. In that case one SMS is sent for an alert that was acknowledged a millisecond later. This is accepted (see §11, R-05). The alternative — holding a lock across the SMS provider call — trades a rare duplicate for an unbounded lock hold on the hot row, which is worse.

### 4.5 Privileges

```sql
-- Application role: no destructive access to audit history.
-- Run via psql as a superuser (or a dedicated provisioning job), not through Prisma migrate:
-- Prisma has no model for roles/grants and will not manage these.
CREATE ROLE app_rw LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE hostel TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  students, wardens, emergency_alerts, device_tokens, refresh_tokens TO app_rw;
GRANT SELECT, INSERT ON alert_logs TO app_rw;   -- append-only: no UPDATE, no DELETE
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- Migration role (uses DIRECT_URL, bypasses PgBouncer).
CREATE ROLE app_migrator LOGIN PASSWORD :'migrator_password';
GRANT ALL ON SCHEMA public TO app_migrator;
GRANT ALL ON ALL TABLES IN SCHEMA public TO app_migrator;
```

`app_migrator` credentials exist only in CI and in the deploy pipeline's migration step. The API and worker never hold them.

### 4.6 Prisma schema

The Prisma schema mirrors the DDL. Where Prisma cannot express something (partial indexes, triggers, check constraints, privileges), it lives in hand-written migration SQL — Prisma will not drop objects it does not know about, but always inspect `prisma migrate diff` output before applying.

```prisma
// packages/db/prisma/schema.prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // points at PgBouncer
  directUrl = env("DIRECT_URL")     // points at Postgres, migrations only
}

enum AlertType {
  MEDICAL
  FIRE
  SECURITY
  MENTAL_HEALTH
  OTHER
}

enum AlertStatus {
  PENDING
  ACKNOWLEDGED
  ESCALATED
  RESOLVED
  CANCELLED
}

enum LocationSource {
  GPS
  NETWORK
  LAST_KNOWN
  MANUAL
  UNKNOWN
}

enum DevicePlatform {
  ANDROID
  IOS
  WEB
}

enum FcmTargetKind {
  REGISTRATION_TOKEN
  INSTALLATION_ID
}

enum AlertActorType {
  STUDENT
  WARDEN
  SYSTEM
}

enum WardenRole {
  WARDEN
  SUPERVISOR
  ADMIN
}

model Student {
  id                   String    @id @default(dbgenerated("uuidv7()")) @db.Uuid
  rollNumber           String    @unique @map("roll_number")
  email                String    @unique
  passwordHash         String    @map("password_hash")
  fullName             String    @map("full_name")
  phone                String?
  hostelBlock          String    @map("hostel_block")
  roomNumber           String    @map("room_number")
  bloodGroup           String?   @map("blood_group")
  allergies            String?
  conditions           String?
  emergencyContactName String?   @map("emergency_contact_name")
  emergencyContactPhone String?  @map("emergency_contact_phone")
  isActive             Boolean   @default(true) @map("is_active")
  lastLoginAt          DateTime? @map("last_login_at") @db.Timestamptz(6)
  createdAt            DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt            DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  alerts       EmergencyAlert[]
  deviceTokens DeviceToken[]
  refreshTokens RefreshToken[]

  @@map("students")
}

model Warden {
  id            String     @id @default(dbgenerated("uuidv7()")) @db.Uuid
  email         String     @unique
  passwordHash  String     @map("password_hash")
  fullName      String     @map("full_name")
  phone         String?
  role          WardenRole @default(WARDEN)
  assignedBlock String?    @map("assigned_block")
  isOnDuty      Boolean    @default(false) @map("is_on_duty")
  isActive      Boolean    @default(true) @map("is_active")
  lastLoginAt   DateTime?  @map("last_login_at") @db.Timestamptz(6)
  createdAt     DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime   @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  acknowledgedAlerts EmergencyAlert[] @relation("AcknowledgedBy")
  resolvedAlerts     EmergencyAlert[] @relation("ResolvedBy")
  deviceTokens       DeviceToken[]
  refreshTokens      RefreshToken[]

  @@map("wardens")
}

model EmergencyAlert {
  id                   String       @id @default(dbgenerated("uuidv7()")) @db.Uuid
  studentId            String       @map("student_id") @db.Uuid
  type                 AlertType
  status               AlertStatus  @default(PENDING)
  clientRequestId      String       @map("client_request_id") @db.Uuid

  latitude             Float?
  longitude            Float?
  locationAccuracyM    Float?       @map("location_accuracy_m")
  locationSource       LocationSource @default(UNKNOWN) @map("location_source")
  locationCapturedAt   DateTime?    @map("location_captured_at") @db.Timestamptz(6)
  note                 String?

  escalationDueAt      DateTime?    @map("escalation_due_at") @db.Timestamptz(6)
  escalationEnqueuedAt DateTime?    @map("escalation_enqueued_at") @db.Timestamptz(6)
  escalationClaimedAt  DateTime?    @map("escalation_claimed_at") @db.Timestamptz(6)
  escalatedAt          DateTime?    @map("escalated_at") @db.Timestamptz(6)
  escalationAttempts   Int          @default(0) @map("escalation_attempts")

  acknowledgedBy       String?      @map("acknowledged_by") @db.Uuid
  acknowledgedAt       DateTime?    @map("acknowledged_at") @db.Timestamptz(6)
  acknowledgeNote      String?      @map("acknowledge_note")

  resolvedBy           String?      @map("resolved_by") @db.Uuid
  resolvedAt           DateTime?    @map("resolved_at") @db.Timestamptz(6)
  resolutionNotes      String?      @map("resolution_notes")

  cancelledAt          DateTime?    @map("cancelled_at") @db.Timestamptz(6)
  cancelReason         String?      @map("cancel_reason")

  smsSentAt            DateTime?    @map("sms_sent_at") @db.Timestamptz(6)
  smsProvider          String?      @map("sms_provider")
  smsProviderMessageId String?      @map("sms_provider_message_id")

  version              Int          @default(1)
  createdAt            DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt            DateTime     @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  student        Student @relation(fields: [studentId], references: [id], onDelete: Restrict)
  acknowledgedByWarden Warden? @relation("AcknowledgedBy", fields: [acknowledgedBy], references: [id], onDelete: SetNull)
  resolvedByWarden     Warden? @relation("ResolvedBy", fields: [resolvedBy], references: [id], onDelete: SetNull)
  logs           AlertLog[]

  @@unique([studentId, clientRequestId])
  @@index([status, createdAt(sort: Desc)])
  @@index([studentId])
  @@index([studentId, createdAt(sort: Desc)])
  @@index([type, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
  @@map("emergency_alerts")
}

model DeviceToken {
  id          String         @id @default(dbgenerated("uuidv7()")) @db.Uuid
  platform    DevicePlatform
  targetKind  FcmTargetKind  @map("target_kind")
  target      String
  wardenId    String?        @map("warden_id") @db.Uuid
  studentId   String?        @map("student_id") @db.Uuid
  deviceLabel String?        @map("device_label")
  userAgent   String?        @map("user_agent")
  isActive    Boolean        @default(true) @map("is_active")
  lastSeenAt  DateTime       @default(now()) @map("last_seen_at") @db.Timestamptz(6)
  createdAt   DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)

  warden  Warden?  @relation(fields: [wardenId], references: [id], onDelete: Cascade)
  student Student? @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@unique([targetKind, target])
  @@map("device_tokens")
}

model AlertLog {
  id             String         @id @default(dbgenerated("uuidv7()")) @db.Uuid
  alertId        String         @map("alert_id") @db.Uuid
  event          String
  fromStatus     AlertStatus?   @map("from_status")
  toStatus       AlertStatus?   @map("to_status")
  actorType      AlertActorType @map("actor_type")
  actorStudentId String?        @map("actor_student_id") @db.Uuid
  actorWardenId  String?        @map("actor_warden_id") @db.Uuid
  metadata       Json           @default("{}")
  requestId      String?        @map("request_id")
  ip             String?
  userAgent      String?        @map("user_agent")
  createdAt      DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)

  alert EmergencyAlert @relation(fields: [alertId], references: [id], onDelete: Restrict)

  @@index([alertId, createdAt])
  @@index([createdAt(sort: Desc)])
  @@map("alert_logs")
}

model RefreshToken {
  id          String    @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tokenHash   String    @unique @map("token_hash")
  subjectType String    @map("subject_type")
  studentId   String?   @map("student_id") @db.Uuid
  wardenId    String?   @map("warden_id") @db.Uuid
  familyId    String    @map("family_id") @db.Uuid
  expiresAt   DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt   DateTime? @map("revoked_at") @db.Timestamptz(6)
  replacedById String?  @map("replaced_by_id") @db.Uuid
  userAgent   String?   @map("user_agent")
  ip          String?
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  student Student? @relation(fields: [studentId], references: [id], onDelete: Cascade)
  warden  Warden?  @relation(fields: [wardenId], references: [id], onDelete: Cascade)

  @@index([familyId])
  @@index([expiresAt])
  @@map("refresh_tokens")
}
```

**Client pooling.** Prisma 7's driver adapter takes the pool size at construction:

```ts
// packages/db/src/client.ts
import { PrismaPg } from '@prisma/adapter-pg';
// Prisma 7's `prisma-client` generator emits into the configured output dir.
// If you stay on the legacy `prisma-client-js` generator, import from '@prisma/client' instead.
import { PrismaClient } from './generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: 5,                        // hard cap per process (ADR-10)
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const prisma = new PrismaClient({ adapter });
```

The URL must also carry `?pgbouncer=true&connection_limit=1` (Prisma uses the flag to avoid prepared-statement caching assumptions); the adapter's `max` does the actual capping.

> **Known drift points.** Prisma does not model partial indexes, triggers, `CHECK` constraints, or grants, so `prisma migrate diff` will not see them. They live in hand-written migration SQL and are applied with `migrate deploy`. Before every migration, diff the live schema against `schema.prisma` and confirm the only differences are the intentional ones. Keeping `ip` as `text` rather than `inet` is deliberate for the same reason.

---

## 5. REST API contract

Base path: `/api/v1`. JSON in, JSON out. `Authorization: Bearer <accessToken>` on everything except login, refresh, and health.

### 5.1 Conventions

| Concern | Rule |
|---|---|
| Auth | JWT access token, 15-minute TTL, claims `{ sub, role, iat, exp, jti }` where `role ∈ {STUDENT, WARDEN, SUPERVISOR, ADMIN}` |
| Refresh | Opaque random 256-bit token, 30-day TTL, stored as SHA-256 hash, rotated on every use, family-revoked on reuse detection |
| Roles | Every route declares its allowed roles explicitly. There is no "authenticated by default" middleware on the router. |
| IDs | UUIDv7 strings |
| Time | ISO-8601 UTC with milliseconds (`2026-11-05T09:14:22.318Z`) |
| Pagination | Cursor-based: `?limit=20&cursor=<opaque>`; response `{ data, page: { nextCursor } }` |
| Idempotency | Alert creation requires `Idempotency-Key` header (a UUID) equal to the body's `clientRequestId` |
| Request ID | `X-Request-Id` accepted or generated (ULID); echoed in every response and error |
| Caching | `Cache-Control: no-store` on all authenticated responses |
| Content type | `application/json; charset=utf-8` |

### 5.2 Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "latitude must be between -90 and 90",
    "requestId": "01JCH3X8Z9K7Q2V5N4M6P8R0T2",
    "details": [{ "path": "latitude", "message": "out of range" }]
  }
}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Schema violation; `details[]` locates the field |
| 401 | `UNAUTHENTICATED` | Missing or malformed token |
| 401 | `TOKEN_EXPIRED` | Access token expired — client should refresh |
| 401 | `REFRESH_INVALID` | Refresh token unknown, revoked, or reused (family revoked) |
| 403 | `ROLE_FORBIDDEN` | Authenticated but wrong role |
| 404 | `ALERT_NOT_FOUND` / `STUDENT_NOT_FOUND` | Unknown or not visible to caller |
| 409 | `ALERT_ALREADY_ACTIVE` | Student already has a live alert; body includes `activeAlertId` |
| 409 | `INVALID_STATUS_TRANSITION` | e.g. resolving a `CANCELLED` alert |
| 409 | `VERSION_CONFLICT` | Optional `If-Match` version mismatch on mutations |
| 429 | `SOS_RATE_LIMITED` | More than 3 SOS creations per student per minute |
| 429 | `RATE_LIMITED` | Generic limiter, includes `Retry-After` |
| 503 | `DEPENDENCY_UNAVAILABLE` | Database or Redis unreachable; safe to retry with backoff |

Clients branch on `code`, never on `message`. The dashboard maps codes to copy; the Flutter app maps codes to recovery actions (refresh, retry, show offline state).

### 5.3 Auth

| Method | Path | Roles | Body / notes |
|---|---|---|---|
| POST | `/auth/login` | public | `{ email, password }` → `{ accessToken, refreshToken, expiresIn, user }`. Rate limit 5/min/IP + 10/hour/email. Constant-time compare even on unknown email. |
| POST | `/auth/refresh` | public | `{ refreshToken }` → new pair. Old token revoked atomically; reuse → `REFRESH_INVALID` and entire family revoked. |
| POST | `/auth/logout` | any | `{ refreshToken }` → `204`. Revokes that token and its family. |
| GET | `/auth/me` | any | Returns the caller's profile, shaped by role. |

`user` shape:

```json
{
  "id": "0192f3a4-...",
  "role": "WARDEN",
  "fullName": "Priya Nair",
  "email": "priya@hostel.example",
  "wardenRole": "SUPERVISOR",
  "isOnDuty": true
}
```

### 5.4 Students

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/students/me` | STUDENT | Own profile incl. medical fields and emergency contacts |
| PATCH | `/students/me` | STUDENT | Limited fields: `phone`, `emergencyContactName`, `emergencyContactPhone`, `allergies`, `conditions`, `roomNumber` (room change requires warden approval in Phase 4+) |
| GET | `/students/:id` | WARDEN, SUPERVISOR, ADMIN | Full profile incl. medical fields. Every access writes an `alert_logs`-adjacent audit row (`STUDENT_RECORD_VIEWED`). |
| GET | `/students` | WARDEN, SUPERVISOR, ADMIN | `?q=&block=&limit=&cursor=`; search by name, roll number, room. Returns non-medical fields only in list view. |

Students must never be able to read another student's record, including by guessing an ID. The presenter strips medical fields for `STUDENT` role and the route rejects non-self IDs before the query runs.

### 5.5 Wardens

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/wardens/me` | WARDEN, SUPERVISOR, ADMIN | Profile + `isOnDuty` |
| PATCH | `/wardens/me/duty` | WARDEN, SUPERVISOR, ADMIN | `{ isOnDuty: boolean }`; affects escalation SMS recipient selection in Phase 3+ |

### 5.6 Alerts — creation

```
POST /alerts
Authorization: Bearer <student token>
Idempotency-Key: 0192f3a4-8c21-7d3e-9f10-2b4c6d8e0a1c
```

```json
{
  "type": "MEDICAL",
  "clientRequestId": "0192f3a4-8c21-7d3e-9f10-2b4c6d8e0a1c",
  "latitude": 12.971598,
  "longitude": 77.594562,
  "locationAccuracyM": 18.4,
  "locationSource": "GPS",
  "locationCapturedAt": "2026-11-05T09:14:19.002Z",
  "note": "Asthma attack, can't breathe properly"
}
```

`201 Created` on first insert, `200 OK` on idempotent replay, both returning the full alert DTO. If the student already has an active alert, `409 ALERT_ALREADY_ACTIVE` with `details.activeAlertId` — the app should navigate to the existing active-alert screen rather than show an error.

Server behaviour, in order, inside one transaction where possible:

1. Validate body and that `Idempotency-Key == clientRequestId`.
2. Rate limit: 3 creations per student per rolling 60 s (`SOS_RATE_LIMITED`).
3. Insert the alert with `status = 'PENDING'` and `escalation_due_at = now() + interval '60 seconds'`.
4. On unique violation of `(student_id, client_request_id)` → return the existing row, `200`.
5. On unique violation of `one_active_alert_per_student` → return `409` with the active alert ID.
6. Insert `ALERT_CREATED` audit row.
7. Commit.
8. *After commit:* enqueue `push:{alertId}` and delayed `esc:{alertId}`; emit `alert:new` to room `wardens`. If any of these fail, log and rely on the reconciler — the request still returns success.

Step 8 is intentionally outside the transaction. A student must never see "SOS failed" because Redis hiccuped after the row was safely committed.

### 5.7 Alerts — reads

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/alerts/active` | WARDEN+ | All `PENDING`/`ACKNOWLEDGED`/`ESCALATED`, newest first, full student context. This is the dashboard's primary snapshot. |
| GET | `/alerts` | WARDEN+ | History: `?status=&type=&from=&to=&block=&studentId=&limit=&cursor=` |
| GET | `/alerts/:id` | WARDEN+ | Single alert incl. student context and last 50 log entries |
| GET | `/alerts/mine/active` | STUDENT | Own active alert or `204 No Content` |
| GET | `/alerts/mine` | STUDENT | Own history, `?limit=&cursor=` |
| GET | `/alerts/:id/logs` | WARDEN+ | Paginated audit trail |

Alert DTO:

```json
{
  "id": "0192f3b1-...",
  "type": "MEDICAL",
  "status": "PENDING",
  "createdAt": "2026-11-05T09:14:22.318Z",
  "escalationDueAt": "2026-11-05T09:15:22.318Z",
  "acknowledgedAt": null,
  "escalatedAt": null,
  "resolvedAt": null,
  "note": "Asthma attack, can't breathe properly",
  "location": {
    "latitude": 12.971598,
    "longitude": 77.594562,
    "accuracyM": 18.4,
    "source": "GPS",
    "capturedAt": "2026-11-05T09:14:19.002Z"
  },
  "student": {
    "id": "0192f3a4-...",
    "fullName": "Aarav Sharma",
    "rollNumber": "CS21B042",
    "hostelBlock": "B",
    "roomNumber": "B-314",
    "phone": "+9198xxxxxx21",
    "bloodGroup": "O+",
    "allergies": "Penicillin",
    "conditions": "Asthma",
    "emergencyContactName": "Meera Sharma",
    "emergencyContactPhone": "+9198xxxxxx07"
  },
  "acknowledgedBy": null,
  "version": 1
}
```

`escalationDueAt` is sent so the dashboard can render a live countdown without clock math against the server. Clients compute `remaining = max(0, escalationDueAt - serverNowOffset)` where `serverNowOffset` is derived from the `Date` response header on the last REST call — never from the device clock alone (see R-11).

### 5.8 Alerts — mutations

All mutations are `POST`, return the updated DTO, and require `WARDEN` (or `SUPERVISOR`/`ADMIN`).

| Method | Path | Body | Transition | Notes |
|---|---|---|---|---|
| POST | `/alerts/:id/acknowledge` | `{ note?: string }` | `PENDING → ACKNOWLEDGED` or `ESCALATED → ACKNOWLEDGED` | Sets `acknowledged_by/at`, clears `escalation_due_at`, removes delayed job. Idempotent: second call by the same warden returns `200` with the existing row. |
| POST | `/alerts/:id/resolve` | `{ resolutionNotes: string }` | `ACKNOWLEDGED → RESOLVED` or `ESCALATED → RESOLVED` | Requires non-empty notes (min 3 chars). Clears active-alert index slot. |
| POST | `/alerts/:id/cancel` | `{ reason: string }` | `PENDING → CANCELLED` | Wardens cancel false alarms. Students may cancel their own alert within 15 s of creation via `POST /alerts/:id/cancel` with `role = STUDENT` and self-check. |

Every mutation: `BEGIN; SELECT ... FOR UPDATE;` verify transition legality; `UPDATE`; insert audit row; `COMMIT`; then emit socket event and remove the BullMQ job. If the socket emit fails, the DB is already correct and clients converge on refetch.

### 5.9 Devices

| Method | Path | Roles | Body |
|---|---|---|---|
| POST | `/devices/tokens` | any | `{ platform, targetKind, target, deviceLabel? }` — upsert on `(targetKind, target)`, attach to caller |
| DELETE | `/devices/tokens` | any | `{ targetKind, target }` — soft-deactivate (`is_active = false`) |
| POST | `/devices/tokens/refresh` | any | Re-register after FCM rotation; same upsert path |

The server never returns raw tokens of other users. Warden dashboard registers `platform: "WEB"`, `targetKind: "INSTALLATION_ID"` on the 2026 FCM path (see R-08).

### 5.10 Health and metrics

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health/live` | none | Process is up. No dependency checks. Used by the platform's liveness probe. |
| GET | `/health/ready` | none | Checks Postgres (`SELECT 1`), Redis (`PING`), and that the Socket.IO adapter is connected. `503` on any failure. Used to gate traffic. |
| GET | `/metrics` | bearer `METRICS_TOKEN` | Prometheus exposition. Bound to the private network where possible. |

`/health/ready` must not run the full dependency check on every request under load — cache the result for 5 seconds.

### 5.11 Rate limits

| Scope | Limit | Store |
|---|---|---|
| Login per IP | 5 / min | Redis |
| Login per email | 10 / hour | Redis |
| SOS creation per student | 3 / min | Redis |
| Alert mutations per warden | 60 / min | Redis |
| Reads per user | 300 / min | Redis |

Limits are keyed by identity where authenticated, falling back to IP. All limiters use a Redis store so they hold across both API replicas. Failing open on Redis loss would let an attacker hammer login; failing closed would take down the dashboard during a Redis blip. Decision: **login fails closed, reads and mutations fail open**, both logged loudly.

---

## 6. Socket.IO contract

### 6.1 Connection

```ts
const socket = io(API_URL, {
  transports: ['websocket'],            // ADR-04
  auth: { token: accessToken },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 10_000,
  randomizationFactor: 0.5,             // jitter: prevents a 500-client thundering herd
  timeout: 10_000,
});
```

Server middleware validates the JWT during the handshake. Invalid or expired token → `connect_error` with `data.code = "UNAUTHENTICATED" | "TOKEN_EXPIRED"`. The client refreshes the access token over REST and reconnects with `socket.auth = { token: newToken }; socket.connect()`.

On connect the server joins the socket to exactly one room:

- `WARDEN`, `SUPERVISOR`, `ADMIN` → `wardens`
- `STUDENT` → `student:{id}`

A student socket can never join `wardens`, and no event payload is broadcast to a room the server did not put the socket in.

### 6.2 Server → client events

| Event | Room | Payload | When |
|---|---|---|---|
| `session:ready` | the socket | `{ socketId, role, serverTime, heartbeatIntervalMs }` | Immediately after connect. Client uses `serverTime` for countdown offset. |
| `alert:new` | `wardens` | full Alert DTO | Alert committed (post-commit emit) |
| `alert:updated` | `wardens` | full Alert DTO | Generic patch (note added, location refreshed) |
| `alert:acknowledged` | `wardens`, `student:{id}` | full Alert DTO | Warden acknowledged |
| `alert:escalated` | `wardens`, `student:{id}` | full Alert DTO + `{ smsSent: boolean }` | Worker won the escalation transition |
| `alert:resolved` | `wardens`, `student:{id}` | full Alert DTO | Warden resolved |
| `alert:cancelled` | `wardens`, `student:{id}` | full Alert DTO | Student or warden cancelled |
| `auth:expiring` | the socket | `{ expiresAt }` | 2 minutes before token expiry. Client refreshes over REST and reconnects if needed. |
| `server:drain` | all | `{ retryAfterMs }` | Instance is shutting down. Client should expect a disconnect and reconnect. |

Design notes:

- **Every payload is the full DTO**, not a diff. Diffs invite version skew between client and server; a few hundred bytes is nothing at this scale. The client replaces its cache entry keyed by `alert.id`.
- **Ordering is not guaranteed** across adapter instances (pub/sub has no total order). Every event carries a monotonically increasing `version` from the row, and the client discards an event whose `version` is not greater than the cached one.
- **No client → server business events.** Presence and scoped subscriptions are the only client → server messages (`subscribe:student` for a warden opening a detail view; optional, Phase 5).

### 6.3 Delivery guarantees

| Property | Guarantee |
|---|---|
| Transport | WebSocket only; no polling fallback server-side |
| Ordering | Best effort; `version` resolves conflicts |
| Delivery | At most once per socket connection. Missed events are recovered by REST snapshot (§6.4), not by replay |
| Durability | None. The socket is not a queue. Postgres is the record. |
| Backpressure | If `socket.conn.writeBuffer.length` exceeds ~1 MB, the server disconnects the socket; the client reconnects and refetches |

### 6.4 Client resync protocol

This is the mechanism that makes ADR-01 real. It runs on every reconnect, every `visibilitychange → visible`, and every manual refresh:

1. `GET /alerts/active` (wardens) or `GET /alerts/mine/active` (students).
2. Replace the entire active set in the TanStack Query cache keyed `['alerts','active']`.
3. If the previously focused alert is no longer in the set, fetch it individually (`GET /alerts/:id`) to learn its terminal status, then update the detail view.
4. Recompute the countdown offsets from the response `Date` header.

While the socket is disconnected, the dashboard also polls `GET /alerts/active` every 15 seconds (only when the tab is visible). The banner reads **"Live updates disconnected — showing last known state, refreshing every 15s."** A quiet screen must never be mistaken for a quiet hostel.

### 6.5 Scale notes

- 500 students + ~10 wardens ≈ 510 sockets sustained, with spikes at shift change.
- One Node process comfortably holds 5,000+ idle WebSockets; two replicas give headroom of an order of magnitude.
- The Redis adapter publishes every warden event to both instances; each instance delivers only to its locally connected sockets. At 10 wardens this is negligible traffic.
- Multi-instance correctness depends on `@socket.io/redis-adapter` 8.3.0 with *separate* pub and sub connections created via `duplicate()`. Reusing one connection for both is a known foot-gun that produces silent cross-instance delivery failures.

---

## 7. End-to-end flows

### 7.1 Happy path: SOS → acknowledgement → resolution

```mermaid
sequenceDiagram
    autonumber
    participant S as Student app
    participant API as API replica
    participant DB as PostgreSQL
    participant R as Redis
    participant W as Worker
    participant D as Warden dashboard
    participant F as FCM

    S->>S: Tap SOS, pick MEDICAL, one-shot GPS fix
    S->>S: Persist clientRequestId to secure storage
    S->>API: POST /alerts (Idempotency-Key)
    API->>API: Auth + rate limit + zod validate
    API->>DB: BEGIN; INSERT alert (PENDING, due=now+60s)
    API->>DB: INSERT alert_logs (ALERT_CREATED)
    API->>DB: COMMIT
    API-->>S: 201 + Alert DTO
    par post-commit fan-out (failures non-fatal)
        API->>R: enqueue push:{id}
        API->>R: enqueue esc:{id} delay 60s, jobId esc:{id}
        API->>D: socket alert:new
    end
    W->>F: send push to warden devices
    F-->>D: OS notification + alarm

    Note over D: Web Audio alarm loops until acknowledged

    D->>API: POST /alerts/{id}/acknowledge
    API->>DB: BEGIN; SELECT ... FOR UPDATE
    API->>DB: UPDATE status=ACKNOWLEDGED, acknowledged_by, escalation_due_at=NULL
    API->>DB: INSERT alert_logs (ALERT_ACKNOWLEDGED)
    API->>DB: COMMIT
    API->>R: remove job esc:{id}
    API->>D: socket alert:acknowledged (all wardens)
    API->>S: socket alert:acknowledged (student:{id})
    API-->>D: 200 + Alert DTO

    Note over S: App shows "Help is on the way — Priya Nair acknowledged"

    D->>API: POST /alerts/{id}/resolve { resolutionNotes }
    API->>DB: UPDATE status=RESOLVED (row lock, trigger bumps version)
    API->>D: socket alert:resolved
    API->>S: socket alert:resolved + push
    API-->>D: 200 + Alert DTO
```

### 7.2 The race: escalation timer vs. warden acknowledgement

This is the flow that determines whether the system is trustworthy. Both paths start from the same `PENDING` row.

```mermaid
sequenceDiagram
    autonumber
    participant Q as BullMQ (esc:{id})
    participant W as Worker
    participant DB as PostgreSQL
    participant A as API (ack request)
    participant D as Dashboard
    participant SMS as Twilio

    Note over Q,DB: t = 60.000s

    Q->>W: delayed job fires
    W->>DB: BEGIN
    W->>DB: SELECT * FROM emergency_alerts WHERE id=$1 FOR UPDATE

    alt Warden's request wins the lock first
        A->>DB: BEGIN; SELECT ... FOR UPDATE (waits)
        W->>DB: UPDATE ... SET status='ACKNOWLEDGED' WHERE id=$1
        W->>DB: COMMIT
        W-->>W: job sees status != PENDING → exit, no SMS
        A->>DB: lock acquired; re-read finds ACKNOWLEDGED
        A->>DB: UPDATE ... acknowledged_by, escalation_due_at=NULL
        A->>DB: COMMIT
        A->>D: 200 (idempotent-ish success)
    else Worker wins the lock first
        W->>DB: UPDATE ... SET status='ESCALATED', escalation_claimed_at=now() WHERE id=$1 AND status='PENDING' RETURNING *
        W->>DB: INSERT alert_logs (ALERT_ESCALATED)
        W->>DB: COMMIT
        W->>SMS: send escalation SMS
        SMS-->>W: message SID
        W->>DB: UPDATE sms_sent_at, sms_provider_message_id
        W->>D: socket alert:escalated
        A->>DB: lock acquired; re-read finds ESCALATED
        A->>DB: UPDATE ... ACKNOWLEDGED (legal: ESCALATED → ACKNOWLEDGED)
        A->>DB: COMMIT
        A->>D: 200 (alert acknowledged, after escalation)
    end
```

Two properties follow from `SELECT ... FOR UPDATE` plus the `status` predicate:

- **At most one transition out of `PENDING`.** The second writer sees the new status and either no-ops or takes a different legal edge.
- **Acknowledgement after escalation is legal and normal.** A warden who arrives 90 seconds late must still be able to take ownership; the dashboard shows "Escalated 30s ago · SMS sent" and the acknowledgement clears the alarm.

### 7.3 Worker escalation pipeline, including SMS fallback

```
esc:{alertId} job
  │
  ├─ load alert (no lock) → if status != PENDING: log NOOP, return
  │
  ├─ BEGIN
  │   UPDATE emergency_alerts
  │      SET status='ESCALATED', escalated_at=now(), escalation_claimed_at=now()
  │    WHERE id=$1 AND status='PENDING'
  │   RETURNING *
  │   (0 rows → lost race → COMMIT, return NOOP)
  │   INSERT alert_logs(event='ALERT_ESCALATED', actor_type='SYSTEM')
  │   COMMIT
  │
  ├─ emit socket alert:escalated to room 'wardens'
  │
  ├─ resolve recipients: on-duty wardens + hostel office number
  │
  ├─ try Twilio (timeout 8s)
  │    ├─ success → record sms_sent_at, provider='twilio'
  │    └─ failure/429/5xx → try MSG91 (timeout 8s)
  │         ├─ success → record provider='msg91'
  │         └─ failure → schedule retry (attempt n, exponential, max 3)
  │
  └─ if all retries exhausted: emit alert:escalated with smsSent=false,
     increment metric escalation_sms_failed_total, page the on-call operator
```

Key behaviours:

- **SMS provider calls happen after the transition commits.** The row says `ESCALATED` before the SMS exists. If the worker dies between commit and SMS, the retry job (and the operator dashboard) can see "escalated, no SMS" and repair it. The inverse — SMS sent, row still says PENDING — would be unrecoverable confusion.
- **`smsSent` is surfaced to the UI.** Wardens must know whether the fallback actually went out.
- **Retries are keyed to the alert, not the phone.** A retry never creates a second alert row.

### 7.4 Reconnect and resync

```mermaid
sequenceDiagram
    autonumber
    participant D as Dashboard
    participant API as API
    participant DB as PostgreSQL

    Note over D: socket.io reconnect attempt (jittered backoff)
    D->>API: WS handshake { auth: { token } }
    alt token expired
        API-->>D: connect_error TOKEN_EXPIRED
        D->>API: POST /auth/refresh
        API-->>D: new access token
        D->>API: WS handshake (retry with new token)
    end
    API-->>D: session:ready { serverTime, heartbeatIntervalMs }
    D->>API: GET /alerts/active
    API->>DB: SELECT ... WHERE status IN (PENDING,ACKNOWLEDGED,ESCALATED)
    API-->>D: snapshot
    D->>D: replace query cache wholesale; recompute countdowns
    Note over D: banner clears only after snapshot succeeds
```

The banner state machine is explicit: `connecting → degraded → live`. It never goes straight from `degraded` to `live` on socket connect alone; it requires a successful snapshot fetch. A socket that connects but cannot fetch is still degraded.

### 7.5 Alert creation with a dead network (student side)

```
tap SOS
  → acquire GPS with 6s timeout
      ├─ success → use fix
      ├─ permission denied → locationSource=UNKNOWN, show "location unavailable"
      └─ timeout → try last known (≤10 min old) → locationSource=LAST_KNOWN
  → generate clientRequestId, persist to secure storage
  → POST /alerts with 10s timeout, retry ×3 with backoff (reusing same requestId)
      ├─ 201/200 → success screen, subscribe to student:{id}
      ├─ 409 ALERT_ALREADY_ACTIVE → navigate to existing alert
      ├─ 429 → show "You've already sent several alerts" + existing alert link
      └─ network failure after 3 tries → queue an on-device banner:
         "Could not reach the hostel server. CALL THE WARDEN DESK: <number>"
         and surface a one-tap phone dial action
```

That last branch matters more than it looks. When the network is down, the app's job is to get the student to a phone call, not to apologize.

---

## 8. Deployment topology

### 8.1 Services

| Service | Platform | Instances | Notes |
|---|---|---|---|
| `api` | Railway | 2 (min), autoscale to 4 | Public HTTPS, WebSocket upgrade enabled, health check `/health/ready` |
| `worker` | Railway | 2 | No public HTTP; internal metrics port only |
| `postgres` | Railway managed | 1 primary | 18.6, daily backups, PITR if available on plan |
| `pgbouncer` | Railway (template or sidecar) | 1 | Transaction mode, `default_pool_size=20` |
| `redis` | Railway managed | 1 | 8.10.3, AOF `everysec`, `maxmemory-policy noeviction`, password auth |
| `prometheus` | Railway | 1 | Scrapes both services |
| `grafana` | Railway | 1 | Dashboards in `infra/grafana` |
| `dashboard` | Vercel | static | SPA rewrite to `index.html`, env-injected API URL |
| `student-app` | Firebase App Distribution | n/a | Signed APK per release; Play Store later if desired |

### 8.2 Topology

```
                          Internet
                             │
              ┌──────────────┴───────────────┐
              │                              │
        Vercel edge                     Railway edge
        (dashboard SPA)                 (TLS, WS upgrade)
              │                              │
              │                   ┌──────────┴──────────┐
              │                   │                     │
              │              api-1 (:8080)         api-2 (:8080)
              │                   │                     │
              │                   └────────┬────────────┘
              │                            │  pg protocol
              │                     ┌──────▼───────┐
              │                     │  PgBouncer   │  pool_mode=transaction
              │                     │  pool 20     │
              │                     └──────┬───────┘
              │                            │  20 backends max
              │                     ┌──────▼───────┐
              │                     │ PostgreSQL   │
              │                     │  18.6        │
              │                     └──────────────┘
              │
              │              ┌──────────────────────────┐
              └─────────────▶│ api-1/api-2 ◀──▶ Redis 8 │
                             │  socket.io adapter       │
                             └──────────┬───────────────┘
                                        │ BullMQ
                             ┌──────────▼───────────────┐
                             │ worker-1     worker-2    │
                             │ reconciler + FCM + SMS   │
                             └──────────────────────────┘
```

### 8.3 Connection budget

| Consumer | Processes | Pool per process | Backends |
|---|---|---|---|
| API | 2 | 5 | 10 |
| Worker | 2 | 5 | 10 |
| Migrations (transient) | 1 | 1 | 1 |
| Operator psql | — | — | 2 |
| **Total** | | | **23** |

PgBouncer's `default_pool_size=20` sits just under the total so it queues rather than opening more backends than Postgres will accept. On Railway's smallest Postgres plan (typically ~25–100 connections), there is headroom for a rolling deploy where old and new instances overlap briefly.

**Rolling deploy overlap is the real constraint.** During a deploy, Railway may run 3 API instances simultaneously. 3 × 5 = 15 application backends, still under 20. Do not raise the per-process pool above 5 without redoing this arithmetic.

### 8.4 Environment variables

```bash
# ── shared ───────────────────────────────────────────────
NODE_ENV=production
PORT=8080
LOG_LEVEL=info
APP_BASE_URL=https://api.hostel.example
DASHBOARD_ORIGIN=https://warden.hostel.example

# ── database ─────────────────────────────────────────────
# PgBouncer endpoint for runtime
DATABASE_URL=postgresql://app_rw:***@pgbouncer.internal:6432/hostel?pgbouncer=true&connection_limit=1
# Direct Postgres for migrations only (never in runtime env)
DIRECT_URL=postgresql://app_migrator:***@postgres.internal:5432/hostel

# ── auth ─────────────────────────────────────────────────
JWT_ACCESS_SECRET=<32+ random bytes, base64>
JWT_ACCESS_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
BCRYPT_COST=12

# ── redis / queue ────────────────────────────────────────
REDIS_URL=rediss://default:***@redis.internal:6379
BULLMQ_PREFIX=hostel
ESCALATION_DELAY_MS=60000
ESCALATION_MAX_ATTEMPTS=3

# ── notifications ────────────────────────────────────────
FIREBASE_PROJECT_ID=hostel-emergency
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=<placeholder: service-account key, never a real key>
TWILIO_ACCOUNT_SID=CHANGE-ME
TWILIO_AUTH_TOKEN=CHANGE-ME
TWILIO_FROM_NUMBER=+91...
MSG91_AUTH_KEY=...
MSG91_SENDER_ID=HOSTEL
MSG91_TEMPLATE_ID=...

# ── ops ──────────────────────────────────────────────────
METRICS_TOKEN=CHANGE-ME
SENTRY_DSN=...
```

Rules:

- The API never receives `DIRECT_URL`. Only the migration step does.
- `FIREBASE_PRIVATE_KEY` is stored with literal `\n` and unescaped at load time; this is the single most common misconfiguration in this stack.
- Secrets are injected by the platform, never committed. `.env.example` documents names only.

### 8.5 Queue configuration

| Queue | Job | Options |
|---|---|---|
| `push` | `push:{alertId}` | `attempts: 4`, exponential backoff starting 2 s, `removeOnComplete: 1000`, `removeOnFail: 5000` |
| `sms` | `sms:{alertId}` | `attempts: 3`, backoff 5 s, `removeOnComplete: 500` |
| `escalation` | `esc:{alertId}` | `delay: 60_000`, `jobId: esc:{alertId}`, `attempts: 2`, `removeOnComplete: 500` |

`jobId` is deterministic, so re-enqueueing the same alert replaces rather than duplicates the delayed job. That is what makes the reconciler safe to run aggressively.

Redis `noeviction` is non-negotiable. Under `allkeys-lru`, a memory spike could evict pending escalation jobs and silently disable the safety net. If Redis fills up, we want writes to fail and alert us — not to drop the queue.

### 8.6 Release process

1. CI: typecheck, lint, unit tests, integration tests against ephemeral Postgres/Redis.
2. Build API and worker images tagged with the commit SHA.
3. Run `prisma migrate deploy` with `DIRECT_URL` from a one-off job. Migrations are additive-first; destructive changes ship one release after the code that stops using the column.
4. Deploy worker first (it tolerates both schemas during the window), then API.
5. Deploy dashboard to Vercel.
6. Smoke test: `/health/ready`, login as demo warden, create a test alert in a `TEST` block, acknowledge it, verify the socket event arrives.
7. Tag the APK and upload to App Distribution.

Rollback is a redeploy of the previous image tag. Because migrations are additive-first, the previous API version keeps working against the newer schema.

### 8.7 Local development

`docker compose up` brings up Postgres 18.6, Redis 8.10.3, PgBouncer, Prometheus, and Grafana. The API and dashboard run on the host for fast reload. Seed data creates 500 students across three blocks, six wardens, and a handful of historical alerts so the history screen is not empty during a demo. A `make escalate-now` script enqueues an escalation with a 5-second delay so you do not have to wait a minute to test the red state.

---

## 9. Observability, security, and privacy

### 9.1 Metrics that matter

Instrument these before Phase 1 is called done. The first four are the ones that tell you the system is broken *now*; the rest are for capacity and tuning.

| Metric | Type | Why it exists | Alert threshold |
|---|---|---|---|
| `alerts_active` | gauge | How many people are currently in trouble | > 0 for > 15 min without resolution → page |
| `alert_ack_latency_seconds` | histogram | Time from creation to acknowledgement | p95 > 45 s → warn; p95 > 90 s → page |
| `escalations_total{outcome}` | counter | `noop`, `escalated`, `sms_sent`, `sms_failed` | `sms_failed` > 0 → page |
| `bullmq_jobs_overdue` | gauge | `PENDING` alerts past `escalation_due_at` | > 0 for > 30 s → page |
| `socket_connections{role}` | gauge | Live wardens | 0 wardens connected for > 5 min during duty hours → page |
| `socket_reconnects_total` | counter | Reconnect storm detection | rate > 50/min → warn |
| `fcm_send_total{result}` | counter | Push delivery health | failure ratio > 10% → warn |
| `sms_send_total{provider,result}` | counter | Provider health, fallback usage | failure ratio > 20% → warn |
| `http_request_duration_seconds` | histogram | API health | p95 > 500 ms → warn |
| `db_pool_in_use` / `db_pool_waiting` | gauge | Pool saturation | waiting > 0 sustained → warn |
| `redis_memory_used_bytes` | gauge | Runway before `noeviction` bites | > 75% maxmemory → warn |
| `worker_heartbeat_age_seconds` | gauge | Worker liveness | > 30 s → page |

The `bullmq_jobs_overdue` gauge is computed by the reconciler, not by asking BullMQ. Asking the queue "are you missing anything?" is exactly the question a lost queue cannot answer.

### 9.2 Logging and tracing

- Structured JSON logs via `pino`, with `requestId`, `alertId`, `studentId` (hashed where practical), `wardenId`, and `jobId` as first-class fields.
- Redaction list: `authorization`, `password`, `refreshToken`, `token`, `target` (push target), `note` (free text may contain health information).
- Every alert's lifecycle is reconstructible from `alert_logs` alone, without logs. Application logs are for debugging, not for audit.
- OpenTelemetry spans on HTTP handlers, Prisma queries, BullMQ job processing, and outbound FCM/SMS calls. Trace ID propagated from `X-Request-Id`.
- Sample 100% of alert-related traces (they are rare) and 5% of reads.

### 9.3 Dashboards

1. **Operations (wall display).** Active alerts, connection count, escalation status, last worker heartbeat. Designed to be readable from three metres away.
2. **Alert funnel.** Created → acknowledged → resolved, with latency percentiles and a histogram of time-of-day.
3. **Dependencies.** Postgres connections and slow queries, Redis memory and ops/sec, FCM and SMS success rates.
4. **Client health.** Dashboard version distribution, socket error codes, PWA install rate.

### 9.4 Alarms and on-call

| Condition | Severity | Route |
|---|---|---|
| Any alert `PENDING` > 2 min with no escalation attempt | Critical | Phone call to on-call engineer |
| `sms_failed` increments | Critical | Phone |
| Worker heartbeat stale > 30 s | Critical | Phone |
| No warden socket connected during 08:00–22:00 | High | SMS to hostel admin |
| `bullmq_jobs_overdue` > 0 for 30 s | High | Phone |
| Redis memory > 75% | Medium | Chat |
| API p95 latency > 500 ms for 10 min | Medium | Chat |

The on-call rotation must be staffed before Phase 6. A monitoring system with no one to answer the page is decoration.

### 9.5 Security controls

| Area | Control |
|---|---|
| Transport | HTTPS/WSS only; HSTS with `max-age=31536000; includeSubDomains`; no mixed content |
| Passwords | bcrypt cost 12; minimum 10 characters; breached-password check at registration (Phase 4) |
| Tokens | Access in memory (dashboard) / secure storage (app); refresh in `flutter_secure_storage` or `HttpOnly; Secure; SameSite=Strict` cookie if we move dashboard refresh server-side |
| RBAC | Explicit per-route role guard; integration test asserts every route has one |
| Input | zod on every body/query/param; Prisma parameterises all queries; raw SQL only in reviewed helpers |
| Rate limiting | Redis-backed, per identity and per IP (§5.11) |
| Headers | helmet defaults; explicit CSP for the dashboard allowing only self, FCM, and the map tile origin |
| Secrets | Platform-injected; rotated quarterly; `DIRECT_URL` limited to CI |
| Dependencies | `npm audit` / `flutter pub outdated` in CI; Dependabot with a 7-day cool-off for majors |
| Mobile | APK signed with a release keystore held offline; certificate pinning optional but recommended for Phase 5 |
| Database | No public network access; PgBouncer on the private network; `app_rw` cannot `UPDATE`/`DELETE` audit rows |
| Push | FCM server key never leaves the worker; device targets are never returned to other users |

### 9.6 Privacy and medical data

Medical information (blood group, allergies, conditions) is special-category data in most jurisdictions. The design keeps it:

- **Purpose-limited.** Returned only on warden-facing endpoints and only alongside an active or recently active alert, or when a warden explicitly opens a student record (which is logged).
- **Minimised in transit.** The dashboard fetches it once per alert, does not persist it to `localStorage`, and clears it on logout.
- **Audited.** Every `GET /students/:id` writes a `STUDENT_RECORD_VIEWED` row.
- **Retained deliberately.** Alerts are retained 24 months, then archived with PII pseudonymised. Audit logs are retained 36 months.
- **Consent.** Students are shown, at first login, what wardens will see during an emergency. This is a product requirement, not just legal cover — people disclose more when they know the audience.

A data protection note for the deployment country is an open item (§13). India's DPDP Act and similar regimes impose breach-notification duties; the runbook needs a named owner for that.

---

## 10. Roadmap

Phases are ordered so that **Phase 1 alone is a shippable emergency system**. Everything after it improves coverage, speed, or durability — none of it is required for the core promise "a student can call for help and a warden sees it."

Legend: **[D]** demo-critical, **[P]** production-hardening, **[O]** optional / later.

### Phase 0 — Foundations (3–4 days) [D]

Goal: an empty but real skeleton that deploys.

- Monorepo scaffold, workspace scripts, shared tsconfig/eslint.
- `docker-compose` with Postgres 18.6, Redis 8.10.3, PgBouncer.
- Prisma init, first migration creating enums and all six tables, seed script.
- API skeleton with `/health/live`, `/health/ready`, request-ID middleware, pino, error envelope, zod validation helper.
- CI: typecheck + lint + unit tests on PR.
- Railway project with api/worker/postgres/redis services; Vercel project for the dashboard.
- Env-var templates and `.env.example`.

Exit criteria: `curl /health/ready` returns 200 from the deployed API; migrations run in CI against a throwaway database.

### Phase 1 — The minimal SOS loop (7–10 days) [D]

**This is the phase that makes the system real.** Scope is deliberately narrow: a student can raise an alert, a warden sees it live, a warden acknowledges and resolves it. No escalation, no SMS, no push, no map.

- **Auth.** `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`. bcrypt, JWT `{ id, role }`, refresh rotation with reuse detection. Flutter stores tokens in `flutter_secure_storage`.
- **Alert creation.** `POST /alerts` with `clientRequestId` idempotency, rate limit (3/min), one-active-alert constraint, `alert_logs` write.
- **Alert reads.** `GET /alerts/active`, `GET /alerts/:id`, `GET /alerts/mine/active`.
- **Mutations.** `POST /alerts/:id/acknowledge`, `/resolve`, `/cancel`, each with a row-locked transition and audit row.
- **Socket.IO.** JWT handshake, `wardens` and `student:{id}` rooms, `alert:new`, `alert:acknowledged`, `alert:resolved`, `alert:cancelled`, `session:ready`. WebSocket-only.
- **Flutter.** Login, SOS button with type picker, success/failure states, active-alert screen that listens for acknowledgement.
- **Dashboard.** Login, live alert board, detail drawer with student/room/blood group/allergies, acknowledge and resolve, connection banner, REST resync on reconnect and `visibilitychange`.
- **Audible alarm.** Web Audio loop, unlocked on first user gesture, stops on acknowledgement.
- **Tests.** Integration tests for the ack/escalate-later race (escalation stubbed), idempotent create replay, role denial on every route.

Explicitly deferred to Phase 2+: escalation timer, SMS, FCM, map, history filters, student profile editing.

Exit criteria: two phones and a laptop demonstrate SOS → audible dashboard alert in under 2 seconds → acknowledge → student sees confirmation → resolve. Kill the API mid-demo, restart it, and the dashboard recovers via resync without a refresh.

### Phase 2 — Escalation and SMS fallback (5–7 days) [D]

- Worker process with BullMQ (`escalation`, `sms` queues).
- Delayed `esc:{alertId}` job at 60 s, deterministic `jobId`, removed on acknowledgement.
- Row-locked `PENDING → ESCALATED` transition and `alert:escalated` socket event.
- Twilio integration, MSG91 fallback, retry with backoff, `sms_sent_at`/provider recorded.
- Reconciler scanning `escalation_due_at` for overdue `PENDING` rows; re-enqueues missing jobs.
- Dashboard red state, countdown timer from `escalationDueAt` + server offset, "SMS sent" indicator.
- `make escalate-now` for testing; integration test for the timer-vs-ack race with two concurrent transactions.

Exit criteria: an unanswered alert turns red at 60 s, an SMS arrives on a real phone, and acknowledging at 62 s still produces a coherent, single record.

### Phase 3 — Push notifications and offline resilience (4–6 days) [D]

- Firebase project, service account, warden PWA registration (`device_tokens`, `INSTALLATION_ID`).
- `push` queue worker with batching (≤500 targets/call), exponential backoff + jitter on 429.
- Service worker `push` handler; notification click deep-links to `/alerts/:id`.
- Student-side push for acknowledgement and resolution.
- PWA install flow, iOS install instructions, permission-priming UI.
- Token refresh and dead-token cleanup (FCM `UNREGISTERED` → `is_active = false`).

Exit criteria: with the dashboard tab closed and the phone locked, an SOS produces an OS notification within ~5 seconds, and tapping it opens the right alert.

### Phase 4 — Context, map, and history (5–7 days) [D]

- One-shot geolocation in Flutter with permission, timeout, and `LAST_KNOWN` fallback; accuracy and staleness displayed.
- Leaflet map on the dashboard with accuracy circle, block/room label, and a "no location" state that is visually distinct from "location is zero-zero".
- History screen with filters (status, type, date range, block, student) and cursor pagination.
- Student profile editing (phone, contacts, allergies, conditions) with validation.
- `GET /students` search for wardens.
- CSV export of history for incident review (Phase 4 or 5).

Exit criteria: a warden can answer "where is this student" and "what happened last Tuesday" without leaving the dashboard.

### Phase 5 — Multi-instance correctness and hardening (4–6 days) [D]

The phase where the design's promises get tested rather than assumed.

- Socket.IO Redis adapter with `duplicate()` pub/sub connections; verify cross-instance delivery with two API replicas.
- Redis AOF, `noeviction`, password, and a documented restore drill.
- PgBouncer transaction mode in production; `PrismaPg({ max: 5 })`; connection-budget test under a simulated rolling deploy.
- Load test: 500 concurrent students creating alerts over 60 s, 10 wardens receiving; measure ack latency and p95 API latency.
- Reconnect storm test: kill one API replica under load; assert clients reconnect with jitter and resync.
- Graceful shutdown: `server:drain`, stop accepting new connections, finish in-flight jobs, exit within 25 s.
- Backup/restore rehearsal: restore Postgres to a point in time, verify alerts and logs survive.

Exit criteria: the load test meets the budgets in §12, and a killed replica causes no lost alerts and no stuck escalations.

### Phase 6 — Production operations (5–7 days) [P]

- Prometheus scraping and the four Grafana dashboards in §9.3.
- Alerts from §9.4 wired to the on-call channel; runbooks written and rehearsed.
- Structured log retention, Sentry, and trace sampling.
- Security review: CSP, header audit, dependency audit, secret rotation, pen-test checklist.
- Rate-limit tuning based on real traffic; login brute-force monitoring.
- Data retention job (archive + pseudonymise) and a documented erasure procedure.
- On-call rota, escalation policy for the *humans*, and a printed contact sheet at the warden desk for the day the internet is down.

Exit criteria: a deliberate worker kill and a deliberate Redis flush are both detected and paged within 2 minutes, and the runbook resolves each in under 15.

### Phase 7 — Extensions (ongoing) [O]

Pick based on what actually hurt, not on what sounds impressive.

- Warden shift handover notes and an on-duty roster driving SMS recipients.
- Block-scoped rooms and coverage maps, if the campus grows.
- Two-way chat between warden and student during an alert.
- Responder acknowledgement from a second device; "I'm responding" intermediate state.
- Analytics: response-time trends by block and shift, drill scheduling.
- iOS warden client / Critical Alerts (the Android client ships in `warden_app/`).
- Integration with campus security or ambulance dispatch.
- Multi-tenant support for additional hostels — this is a re-architecture, not a feature; budget accordingly.

### Phase summary

| Phase | Duration | Demo-critical | Ships |
|---|---|---|---|
| 0 Foundations | 3–4 d | yes | Deployed skeleton |
| 1 Minimal SOS loop | 7–10 d | yes | **Working emergency system** |
| 2 Escalation + SMS | 5–7 d | yes | Automatic fallback |
| 3 Push + PWA | 4–6 d | yes | Locked-phone coverage |
| 4 Map + history | 5–7 d | yes | Context and review |
| 5 Multi-instance | 4–6 d | yes | Proven at scale |
| 6 Operations | 5–7 d | no | Sustainable ops |
| 7 Extensions | ongoing | no | Nice-to-have |

Roughly 6–8 weeks for Phases 0–6 with two engineers, including buffer. Phase 1 is achievable in under two weeks by one engineer and is worth demoing on its own.

---

## 11. Risks and failure modes

Ordered by how much damage they do to the core promise. Each has a detection signal, because a risk you cannot see is a risk you cannot manage.

### R-01 — SMS throughput at 500 simultaneous alerts

**Scenario.** A fire alarm or a campus-wide event causes hundreds of students to press SOS within a minute. Each unanswered alert escalates 60 s later.

**Impact.** High. Twilio's default long-code throughput in India is on the order of a few messages per second; a burst of 500 will queue for minutes. SMS also costs money per message — 500 messages per event is a budget line.

**Mitigation.**
- Cap warden SMS at one per alert, going to a small recipient list (on-duty wardens + office), not every warden's phone.
- Use a Twilio Messaging Service with a pooled sender and short-code/sender-ID where available; confirm the account's actual MPS limit during Phase 2, not during an incident.
- Queue SMS at a controlled rate (e.g. 5/s) with a priority for `FIRE` and `SECURITY`, so the queue drains predictably instead of timing out.
- Deduplicate by alert: one SMS per alert regardless of retries.
- During a mass-casualty event, the correct behaviour is a broadcast, not 500 individual escalations. Phase 7 should add an operator-triggered broadcast path. Until then, document the manual drill in the runbook.

**Detection.** `sms_send_total{result="queued"}` vs `{result="sent"}` divergence; queue depth on the `sms` queue; provider 429 rate.

### R-02 — FCM 429 throttling and topic fan-out

**Scenario.** A burst of alerts triggers many sends at once; FCM returns 429 or 503.

**Impact.** Medium. Wardens miss the push but the socket event and dashboard still work if a tab is open.

**Mitigation.**
- Batch up to 500 targets per `sendEachForMulticast` call, with exponential backoff + full jitter (`base 2s`, `cap 30s`, `attempts 4`).
- Respect `Retry-After` when present.
- Never let the `push` worker retry synchronously in a loop; each retry is a new delayed job so a worker restart does not lose it.
- Treat FCM as best-effort and keep the socket + SMS paths independent.

**Detection.** `fcm_send_total{result="throttled"}` rate; p95 push latency.

### R-03 — Reconnect storm after a deploy or network blip

**Scenario.** A load balancer restarts, all 510 sockets drop at once, and every client reconnects at the same millisecond.

**Impact.** Medium. CPU spike, thundering herd on `/alerts/active`, possible cascading timeouts.

**Mitigation.** Infinite reconnect with exponential backoff (0.5 s → 10 s), `randomizationFactor: 0.5`, and the 15 s REST polling fallback while disconnected. Server-side, the handshake is cheap (JWT verify + room join) and `/alerts/active` is a single indexed query. Load-test this explicitly in Phase 5.

**Detection.** `socket_reconnects_total` rate spike; API CPU and p95 during deploys.

### R-04 — Redis loss or BullMQ data loss

**Scenario.** Managed Redis fails over to an empty replica, or is flushed by an operator, and every delayed escalation job disappears.

**Impact.** Critical. Silent loss of the safety net: alerts stay `PENDING` forever and no SMS is ever sent.

**Mitigation.**
- AOF `everysec` and a replica if the plan supports it.
- The reconciler (§7.3) scans `WHERE status = 'PENDING' AND escalation_due_at < now() - 5s` every 15 s and re-enqueues with `jobId esc:{id}`. Because the DB holds `escalation_due_at`, correctness survives Redis amnesia.
- `maxmemory-policy noeviction` so memory pressure produces errors instead of silent drops.
- A Redis restore drill in Phase 5, and a runbook section that starts with "do not flush; check the reconciler."

**Detection.** `bullmq_jobs_overdue > 0`; Redis `rdb_last_bgsave_status`; a synthetic canary alert created every 10 minutes in a `TEST` block that must escalate — if it doesn't, page.

The canary is worth calling out: it is the only signal that proves the *whole* escalation path works, end to end, without waiting for a real emergency.

### R-05 — Acknowledge/escalation race produces a duplicate or late SMS

**Scenario.** The warden taps at 59.9 s; the worker's job fires at 60.0 s. Or the reverse, by milliseconds.

**Impact.** Low. One unnecessary SMS to the on-duty warden. The record stays coherent because of the row lock.

**Mitigation.** Accept it. The state machine guarantees at most one transition out of `PENDING`; a duplicate SMS is the cheaper failure than a missed escalation. Do not hold the row lock across the provider call. Log `escalation_claimed_at - acknowledged_at` so the frequency is measurable, and if it is noisy, add a 2 s grace period before the worker sends (still bounded).

**Detection.** `alert_logs` rows where `ALERT_ESCALATED` and `ALERT_ACKNOWLEDGED` are within 3 s of each other; `escalations_total{outcome="sms_after_ack"}`.

### R-06 — PgBouncer or database connection exhaustion

**Scenario.** A rolling deploy runs three API instances plus two workers plus a migration, and every process opens its maximum.

**Impact.** High. Requests hang until `connectionTimeoutMillis`, then 503s; the dashboard appears frozen during exactly the moment you are trying to fix something.

**Mitigation.** Hard cap of 5 per process (ADR-10), `default_pool_size=20`, migrations on `DIRECT_URL` with a single connection, and a documented rule that the pool size changes only with the arithmetic in §8.3 redone. Add a `db_pool_waiting` metric and alert on sustained waits.

**Detection.** `db_pool_waiting > 0` for 60 s; Postgres `pg_stat_activity` count; 503 rate on `/health/ready`.

### R-07 — Browser audio is blocked until a user gesture

**Scenario.** A warden opens the dashboard, the browser blocks autoplay, and an alert arrives silently.

**Impact.** High. The single most important affordance — an audible alarm — fails silently.

**Mitigation.**
- An explicit "Enable alarm" button on login that plays a silent/short tone to unlock the AudioContext, with a persistent badge showing `Alarm: ON` / `Alarm: OFF`.
- Re-arm on every navigation and after the tab returns from background, since some browsers re-suspend the context.
- Visual fallback: full-screen red overlay, tab title flashing `🔴 SOS`, and a favicon change.
- The PWA notification itself is audible on most platforms even when Web Audio is blocked; that is a second independent path.

**Detection.** Client telemetry event `alarm_unlock_state` on connect; if a warden is connected with `alarm=off` for more than 5 minutes during duty hours, surface it on the operations dashboard.

### R-08 — FCM registration-token → installation-ID migration

**Scenario.** The 2026 FCM changes deprecate raw registration tokens in favour of Firebase Installation IDs. Code that stores a token and calls `send()` with it starts failing.

**Impact.** Medium. Push silently stops working for wardens.

**Mitigation.** Store `target_kind` on `device_tokens` and never assume the column's meaning. Abstract the send path behind `notification.provider.ts` so the swap is one file. Keep the legacy path working until the SDK version in use no longer supports it, and test with a real device each phase. Verify the current FCM contract against official docs at implementation time rather than trusting this document's summary.

**Detection.** `fcm_send_total{result="invalid_argument"}`; push success rate by app version.

### R-09 — GPS unavailable or wrong

**Scenario.** The student is indoors, denies permission, or the fix is 80 m off in a multi-storey building.

**Impact.** Medium. Wardens go to the wrong place — or worse, trust a pin that says "the middle of the road."

**Mitigation.** Show accuracy radius, not just a pin. Show `locationSource` and `capturedAt` so a stale `LAST_KNOWN` fix is visibly different from a fresh GPS fix. Always display block and room number prominently — that is the real locator; the map is supplementary. Never render `(0,0)` as a valid location.

**Detection.** Share of alerts with `location_source = 'UNKNOWN'`; median accuracy; warden feedback on incorrect pins.

### R-10 — Duplicate SOS from rapid tapping

**Scenario.** The student taps five times out of panic or because the UI felt unresponsive.

**Impact.** Medium if unhandled: five alerts, five escalation timers, five SMS.

**Mitigation.** `clientRequestId` idempotency plus the partial unique index (ADR-03). The app disables the button after the first tap and shows a spinner; the server independently enforces the invariant. On `409 ALERT_ALREADY_ACTIVE`, the app navigates to the existing alert instead of showing an error.

**Detection.** `409 ALERT_ALREADY_ACTIVE` rate; count of alerts per student per minute.

### R-11 — Client clock skew breaks the escalation countdown

**Scenario.** A warden's laptop is four minutes fast, so the countdown shows a negative number or a wrong urgency.

**Impact.** Low to medium. Erodes trust in the timer; could cause premature manual escalation.

**Mitigation.** `session:ready` and every REST response carry server time (`Date` header + `serverTime` field); the client keeps an offset and renders countdowns from server-relative time. Never use `Date.now()` alone for urgency.

**Detection.** Client telemetry of computed offset; alert if `|offset| > 60 s`.

### R-12 — Alert state diverges because a socket event is missed

**Scenario.** A client misses `alert:acknowledged` due to a transient adapter failure, and keeps showing a red pending alert.

**Impact.** Medium. A warden acts on stale information.

**Mitigation.** ADR-01 plus the version field: every event carries the row's `version`, the client discards out-of-order events, and the resync protocol (§6.4) runs on reconnect and on tab focus. The 15 s poll while disconnected bounds staleness during an outage.

**Detection.** Client-side assertion that the local `version` never exceeds the server's on the next snapshot; log a `STALE_STATE_DETECTED` event when it does.

### R-13 — Medical data exposure

**Scenario.** A student token is replayed, a warden account is shared, or a misconfigured route lets a student read another student's record.

**Impact.** Critical, and not just reputational — it is a legal exposure.

**Mitigation.** Per-route role guards with an automated test that enumerates the router and fails if any route lacks one. Presenters strip medical fields for the `STUDENT` role. `GET /students/:id` writes an audit row. Refresh-token rotation with reuse detection. TLS everywhere and no medical data in `localStorage`. A short-lived access token (15 min) limits the blast radius of a leaked token.

**Detection.** Anomalous access patterns (one warden reading hundreds of records); audit-log review; a pre-launch pen-test checklist.

### R-14 — Human on-call capacity

**Scenario.** The system works, but nobody is awake to answer the page at 3 a.m.

**Impact.** Critical — the failure mode the whole system exists to prevent.

**Mitigation.** This is a staffing problem, not an engineering one, and must be owned outside the dev team. Concrete requirements: a named on-call rota, a printed contact sheet at the warden desk, a test page during onboarding, and a weekly review of any alert that went unacknowledged for more than 2 minutes. The dashboard's `alerts_active` gauge on a wall screen is a cheap, effective backstop.

**Detection.** Unacknowledged-alert duration metric; weekly incident review.

### R-15 — Data loss on the primary database

**Scenario.** Disk failure, accidental `DELETE`, or a bad migration.

**Impact.** Critical. Losing the alert history destroys the audit trail and the ability to review what happened.

**Mitigation.** Daily automated backups with a tested restore (Phase 5 rehearsal), PITR if the plan offers it, and a migration review rule: destructive changes ship one release after the code stops using the column. `app_rw` has no `DELETE` on `alert_logs`. The `ON DELETE RESTRICT` on `emergency_alerts.student_id` prevents an accidental cascade from wiping history when a student is removed.

**Detection.** Backup success metric; a monthly restore-to-staging verification.

### Risk matrix (summary)

| ID | Risk | Likelihood | Impact | Priority |
|---|---|---|---|---|
| R-04 | Redis/BullMQ data loss | Medium | Critical | 1 |
| R-14 | No human on call | Medium | Critical | 1 |
| R-03 | Reconnect storm | Medium | Medium | 2 |
| R-07 | Blocked browser audio | High | High | 2 |
| R-01 | SMS burst throughput | Medium | High | 2 |
| R-06 | Connection exhaustion | Medium | High | 2 |
| R-13 | Medical data exposure | Low | Critical | 2 |
| R-15 | Database data loss | Low | Critical | 2 |
| R-02 | FCM throttling | Medium | Medium | 3 |
| R-05 | Duplicate SMS race | Medium | Low | 3 |
| R-09 | Bad GPS | High | Medium | 3 |
| R-12 | Missed socket event | Medium | Medium | 3 |
| R-10 | Duplicate SOS | High | Low | 4 |
| R-08 | FCM ID migration | Medium | Medium | 4 |
| R-11 | Clock skew | Medium | Low | 4 |

---

## 12. Capacity and performance budgets

### 12.1 Load assumptions

| Quantity | Design value | Peak |
|---|---|---|
| Registered students | 500 | 500 |
| Concurrent student sockets | 20 (app foregrounded) | 100 |
| Concurrent warden sockets | 8 | 15 |
| Alerts per day | 3 | 30 |
| Alerts in the worst 60 s | 1 | 500 (mass event, R-01) |
| Authenticated REST requests/min | 600 | 6,000 |
| DB writes/min | 40 | 2,500 |

An ordinary day is almost idle. The design is sized for the *bad* day and for the deploy that happens on it.

### 12.2 Latency targets

| Path | Target (p95) | Measured from |
|---|---|---|
| SOS tap → API 201 | 800 ms (excludes GPS time) | Tap |
| DB commit → warden socket event | 150 ms | Commit |
| DB commit → FCM delivery | 5 s | Commit |
| Alert creation → first warden acknowledgement | 30 s | Created_at |
| Dashboard initial load (cached) | 1.5 s | Navigation start |
| Dashboard resync after reconnect | 700 ms | Reconnect |
| `/alerts/active` query | 40 ms | Server |
| Escalation job scheduling accuracy | ±2 s | `escalation_due_at` |

The acknowledgement target is the one that matters clinically. Everything upstream of it exists to make it achievable.

### 12.3 Storage

Per alert: ~1 KB row + ~6 log rows × ~500 B ≈ 4 KB. At 30 alerts/day that is 120 KB/day, ~44 MB/year. Device tokens and refresh tokens are negligible. **Storage is a non-issue**; the 24-month retention policy is about privacy and clarity, not capacity.

### 12.4 Load test plan (Phase 5)

1. 500 students authenticate and open sockets over 60 s. Assert all connected, p95 handshake < 300 ms.
2. 500 alerts created within 60 s from 500 distinct students. Assert 500 rows, zero duplicate-active violations, p95 create < 1.5 s.
3. Wardens receive 500 `alert:new` events. Assert delivery to all connected warden sockets, no backpressure disconnects.
4. 60 s later, escalation jobs fire. Assert 500 SMS jobs enqueued, provider mock returns 429 for 30% and the retry succeeds.
5. Kill one API replica mid-test. Assert no lost alerts, clients reconnect within 30 s, resync completes.
6. Flush Redis after enqueuing, before the delay elapses. Assert the reconciler re-enqueues and every pending alert escalates.

Test 6 is the one that proves R-04's mitigation actually works. Run it. Do not just read the code.

---

## 13. Open questions

These need an answer before the corresponding phase, not before Phase 1. Listed with an owner type and a deadline.

| # | Question | Needed by | Owner |
|---|---|---|---|
| 1 | Which SMS provider contract and sender ID are approved for India, and is DLT template registration complete? Lead time can be weeks. | Phase 2 | Hostel admin / procurement |
| 2 | Is one warden on duty at night or two? Determines the SMS recipient list and the on-call rota. | Phase 2 | Hostel admin |
| 3 | What are the real escalation targets — on-duty warden only, plus supervisor after 3 min, plus campus security after 5 min? | Phase 2 | Hostel admin |
| 4 | Which map tile provider is acceptable (licensing, cost, and whether student coordinates may leave the country)? | Phase 4 | Engineering + legal |
| 5 | Retention period and erasure procedure under the applicable data-protection law. | Phase 6 | Legal |
| 6 | Who is on the engineering on-call rota, and what is the escalation path if they do not answer? | Phase 6 | Engineering lead |
| 7 | Is iOS a real target for students, or Android-only? Affects app-store work and push behaviour. | Phase 3 | Product |
| 8 | Do wardens have managed devices, or personal phones? Affects PWA install instructions and MDM. | Phase 3 | Hostel admin |
| 9 | Is there an existing student roster/ERP to sync from, or is CSV import enough? | Phase 1 | Hostel admin |
| 10 | What is the budget ceiling for SMS and FCM? A mass event can be expensive. | Phase 2 | Finance |

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| **SOS** | A student-initiated emergency alert |
| **Escalation** | The automatic transition to `ESCALATED` after 60 s without acknowledgement, triggering SMS |
| **Acknowledgement** | A warden taking ownership of an alert; stops the alarm and the escalation timer |
| **Resolution** | The terminal state after response is complete |
| **Reconciler** | Worker task that scans Postgres for overdue alerts and repairs missing queue jobs |
| **Snapshot / resync** | Full REST fetch of active alerts used to repair client state |
| **FID** | Firebase Installation ID, the 2026 replacement for raw FCM registration tokens |
| **PgBouncer transaction mode** | Connection pooling where a server connection is held only for the duration of a transaction |

## Appendix B — Definition of done for Phase 1

A reviewer should be able to check every box without reading the code:

- [ ] A student logs in on a physical Android device and the token is stored in secure storage (verified by inspecting app storage, not by assertion).
- [ ] Tapping SOS creates exactly one row, even when the button is tapped five times and the network drops one response.
- [ ] A second SOS while one is active returns `409` with the existing alert ID, and the app navigates to it.
- [ ] The warden dashboard shows the alert within 2 s, with name, room, block, blood group, and allergies.
- [ ] The alarm is audible after the warden clicks "Enable alarm"; the badge reflects the state.
- [ ] Acknowledging stops the alarm, updates the student's screen, and clears `escalation_due_at` in the database.
- [ ] Killing the API process and restarting it leaves the dashboard consistent after an automatic resync.
- [ ] A student token cannot read another student's record, and a student token cannot call a warden route (both verified by integration test).
- [ ] Every route in the router has an explicit role guard (verified by an automated enumeration test).
- [ ] `alert_logs` contains created/acknowledged/resolved rows with actor and request ID for the whole session.
- [ ] `/health/ready` returns 503 when Postgres is stopped and 200 when it returns.

If all eleven are true, the system is real. Everything in Phases 2–7 makes it more resilient, more convenient, or more observable — but not more real.

---

*End of document. Sections 1 and 11 are the ones to revisit when a decision is challenged. Section 10 is the plan; if reality disagrees with it, update the plan rather than the definition of done.*











