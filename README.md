# HostelGuard — Hostel Emergency Response System

A three-client emergency system for hostel campuses: a **Flutter student app**
with one-tap SOS, a **React warden dashboard** for triage and resolution, and a
**Node/Express + Socket.IO backend** with a Redis-backed escalation worker that
sends SMS if a warden does not acknowledge in 60 seconds.

The core design principle: **the system, not the student, is responsible for
getting the alert to a human.** A student who presses SOS and then loses
consciousness must still be found.

---

## Architecture

```
   Flutter student app                    React warden dashboard
   (Android)                              (Vite, browser)
          |                                       |
          |  HTTP /auth/login, /alerts            |  HTTP + WebSocket
          |  WebSocket (websocket-only)           |
          +----------------+  +-------------------+
                           |  |
                    +------v--v------+
                    |  nginx :8080   |   round-robin, WebSocket upgrade
                    +------+---------+
                           |
          +----------------+----------------+
          |                |                |
     api :3001        api :3002        api :3003     (PM2 cluster)
          |                |                |
          +--------+-------+--------+-------+
                   |                |
          Redis (adapter pub/sub,    Postgres (Prisma)
          rate limiters, BullMQ)
                   |
            escalation worker (single fork process)
                   |
             Twilio SMS  +  FCM push
                   |
        Prometheus :9090 -> Alertmanager :9093 -> Grafana :3000
```

### Why this shape

- **Escalation timer lives in Redis (BullMQ), not JS memory** — it survives an
  API or worker restart. Verified: a job survived a 9.1 s outage and fired at
  `60.091 s`.
- **Worker runs in fork mode, `instances: 1`** — a clustered worker could fire
  the same SMS twice.
- **Idempotency guard first line after fetch** — `if (alert.status !== "PENDING") return;`
  so an SMS never fires after a warden acknowledged.
- **WebSocket-only clients** — each socket is one long-lived TCP connection
  pinned to an upstream at connect time, so nginx needs no sticky sessions.
- **SOS limiters fail open** — if Redis is unreachable, a stuck button must not
  block a real emergency. All three limiters use `passOnStoreError: true` and a
  50 ms fail-fast command ceiling.
- **Sorted out of the alert list, not out of the system** — the dashboard's
  Resolved filter shows a red banner when a new PENDING alert arrives, so a
  filter can never hide an emergency.

---

## Repository layout

| Path | What it is |
|---|---|
| `backend/` | Express + TypeScript API, Socket.IO, Prisma schema/migrations, BullMQ worker, Vitest suite |
| `backend/nginx.conf` | Front door config: `listen 8080`, round-robin over 3001–3003, WebSocket upgrade |
| `student_app/` | Flutter app (Android + web), one-tap SOS with optional GPS |
| `warden-dashboard/` | React + Vite dashboard for triage and resolution |
| `backend/monitoring/` | Prometheus scrape config, Grafana provisioning and the 9-panel dashboard JSON |
| `docs/` | Demo script, setup checklist, dry-run reports, security audit, load-test results |
| `load-test/` | k6 scenarios (500 students, 50 warden sockets, 100 SOS) |
| `HANDOFF.md` | Current state, locked architectural decisions, known traps |
| `progress.md` | Build log across phases |

---

## Quick start

### Prerequisites

- Node.js 20+ (built and tested on Node 24), npm
- Docker (Postgres + Redis), or your own instances
- Flutter 3.27+ with the Android SDK for the student app (built on Flutter 3.47 / Dart 3.13)
- Optional: nginx, Twilio account, Firebase project

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # then edit DATABASE_URL / REDIS_URL / JWT_SECRET

docker compose up -d      # Postgres + Redis
npm run db:migrate
npm run db:generate
npm run seed              # 500 students, 5 wardens, seed accounts

npm run dev               # API on :4000 (single instance)
npm run worker:dev        # escalation worker, second terminal
```

For the multi-instance demo topology, use PM2 with the API in cluster mode
(3 instances on :3001–:3003) plus one fork-mode worker, then put nginx in front:

```bash
$prefix = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" `
  -Directory -Filter 'nginxinc*' | Select-Object -First 1).FullName + '\nginx-1.31.8'
nginx -p $prefix -c "$PWD\backend\nginx.conf" -g "daemon off;"
```

```bash
1..6 | % { (curl.exe -s localhost:8080/health | ConvertFrom-Json).instanceId }
# 3001 3002 3003 3001 3002 3003  <- round-robin is working
```

### 2. Warden dashboard

```bash
cd warden-dashboard
npm install
cp .env.example .env       # VITE_API_URL must point at the API (or nginx :8080)
npm run dev                # http://localhost:5173
```

### 3. Student app (Flutter)

The API base URL is a compile-time define, so the device must be able to reach
the value you build with.

```bash
cd student_app
flutter pub get
```

| Target | Command |
|---|---|
| Android emulator | `flutter run` (defaults to `http://10.0.2.2:4000`) |
| Physical phone, via nginx | `flutter build apk --release --dart-define=API_URL=http://<PC-LAN-IP>:8080` |
| Web / desktop preview | `flutter run -d chrome --dart-define=API_URL=http://localhost:8080` |

The phone and the PC must be on the same network, and the PC firewall must allow
inbound TCP 8080. The app declares `usesCleartextTraffic="true"` for plain-HTTP
LAN demos; a production deployment should use TLS.

Seed login: `aarav@hostel.local` / `password123`.

### 4. Monitoring (optional)

Prometheus scrapes all four targets (3 API + worker); Grafana ships a 9-panel
dashboard. See `docs/DEMO_SETUP.md` for the scrape config and the
`METRICS_TOKEN` requirement.

---

## Tests

```bash
cd backend
npm test                    # 74 passed, 1 skipped (opt-in index test)
npm run test:multi-instance # needs PM2 stopped; proves cross-instance fan-out
RUN_INDEX_TEST=true npm test -- tests/index.test.ts
node scripts/secret-scan-check.cjs   # CLEAN — 0 hits
```

Latest full dry run: **56 PASS / 0 FAIL / 9 SKIP / 1 N/A → GO**
(`docs/DRY_RUN_REPORT_V2.md`). The 9 SKIPs are environment-limited only — no
Android emulator, and no Twilio/FCM credentials on the demo machine — not code
failures. The escalation path reports that honestly rather than faking success:
the dashboard pill reads `SMS is not configured` when Twilio is absent.

---

## Safety guarantees

| Guarantee | Status |
|---|---|
| Acknowledged alert never fires SMS | Verified (job removed, no worker line after 70 s) |
| Worker restart does not lose a pending escalation | Verified (fired 60.091 s after creation across a 9.1 s outage) |
| Redis outage does not break SOS delivery | Verified, scoped — creation/persistence/receipt in 44.7–73.3 ms (API side); cross-instance fan-out and escalation pause until Redis returns |
| Rate limiting never blocks a real SOS | Verified (break-glass override + fail-open limiters) |
| Cross-instance broadcast < 500 ms | Verified (4–55 ms measured; asserted in tests) |
| Stale FCM token removed on next send | Unit-proven with a mock (no physical device available) |
| No secret in git history or logs | Verified (gitleaks staged 0, full history 0) |

---

## Documentation

| Document | Contents |
|---|---|
| `HANDOFF.md` | Current state, locked decisions, known traps, viva cheat sheet |
| `docs/DEMO_SCRIPT.md` | Presenter runbook with expected timings |
| `docs/DEMO_SETUP.md` | Twilio / FCM / Android / nginx setup checklist |
| `docs/DRY_RUN_REPORT_V2.md` | Authoritative per-drill results (GO) |
| `docs/AUDIT.md` | Security review |
| `docs/LOAD_TEST_RESULTS.md` | k6 results |
| `docs/hostel-emergency-system-architecture.md` | Full design document |

---

## Status

Feature-complete and demo-ready. Not deployed to production: Twilio, FCM and an
Android emulator are unconfigured on the build machine, and HTTPS termination
plus token refresh are documented next steps rather than implemented ones.
