# HostelGuard — Handoff V3 (Post-Fix)

> [!IMPORTANT]
> **MASTER TASK LIST & ROADMAP:** See **[`PROJECT_ROADMAP.md`](file:///c:/Users/saish/OneDrive/Documents/Default%20Project/PROJECT_ROADMAP.md)** for the prioritized task breakdown of what has been built and what remains to be built for commercial production.

> **Purpose:** continue the build without losing context. This supersedes the
> pre-fix handoff. Every claim below was measured on this machine; the drill
> evidence lives in `docs/DRY_RUN_REPORT_V2.md` and the raw console output is
> quoted there.
>
> **Status: GO for the demo as scripted**, subject to the environment-limited
> SKIPs in §2 and the guarantee-#3 scope note in §7.

---

## 1. Where We Are — In One Paragraph

HostelGuard (Flutter student SOS app + React warden dashboard + Node/Express/
Socket.IO backend + Postgres/Prisma + Redis/BullMQ + FCM + Twilio + Prometheus/
Grafana) is **feature-complete and passes 80/81 automated tests** (1 opt-in
index test skipped by default). V1 was a 66-drill dry run with **47 PASS /
7 FAIL / 11 SKIP / 1 N/A → NO-GO**. All 7 FAILs and all 4 new findings have
since been fixed and verified: E6 fail-open SOS path, Resolve UI, new-alert
banner, server-driven escalation pill, J4 index claim, H1 Grafana panels,
Grafana metric reset, and F3/F4 via a real nginx front door. V2 is
**56 PASS / 0 FAIL / 9 SKIP / 1 N/A → GO**, with the caveats in §7 and §8.

---

## 2. Dry-Run Results

### V1 → V2

| | V1 (2026-11-08) | V2 (2026-11-10) |
|---|---|---|
| PASS | 47 | **56** |
| FAIL | 7 | **0** |
| SKIP | 11 | **9** |
| N/A | 1 | 1 |
| Total | 66 | 66 |
| Verdict | **NO-GO** | **GO** |

Full per-drill tables, actual outputs and the `Delta from V1` column:
`docs/DRY_RUN_REPORT_V2.md`. V1 is preserved unchanged at
`docs/DRY_RUN_REPORT.md`.

### The 7 V1 FAILs — now fixed

| ID | V1 symptom | Fix | V2 evidence |
|---|---|---|---|
| **E6** | Redis down → SOS hung, HTTP 000 after 5/10 s | Limiters `passOnStoreError: true` + 50 ms fail-fast store command; fire-and-forget enqueue; `/health` 200 `degraded` | Redis stopped: 6× `POST /alerts` → **201 in 44.7–73.3 ms** (API side; 150–211 ms browser round trip); `/health` 200 `{"status":"degraded","redis":"down","db":"ok"}`; `/health/ready` 503; recovery in **2.4–3.2 s**, no API restart |
| **K6** | Demo script could not be performed as written | Real Resolve UI, new-alert banner, server-driven pill, honest Redis/index wording | Full script run: every step performed as written; pill never said "SMS sent" on a failed worker send |
| **K7** | Same script, second run | Same | Second full run: same steps, same verdicts |
| **F3** | No LB; dashboard stayed `Disconnected` when its instance died | nginx 1.31.8 front door on **:8080**, round-robin over 3001/3002/3003, WebSocket upgrade | Two instances stopped: dashboard stayed `Live`; sockets moved to the survivor (`3003=2`) |
| **F4** | POST to a dead instance → HTTP 000, no failover | Same nginx upstream + `proxy_next_upstream` | With two instances down: `POST /alerts` through :8080 → **201**, LB `/health` → 200 |
| **H1** | SMS/FCM panels showed "No data" | Static "not configured" text panel in variant A; `or vector(0)` in variant B | 9 panels, 0 in "No data"; variant B shows 0/0 counters |
| **J4** | Code comment claimed an Index Scan that did not happen | Comment replaced with three measured plans | At 5,003 rows: **3× `Index Scan using idx_alerts_status_created`** (one per UNION branch), 0.607 ms; forced plan caveat documented |

### The 4 new findings — all fixed

1. **No Resolve UI.** Resolve button (ACKNOWLEDGED only) opens a dialog;
   *Submit resolution* stays disabled until the trimmed note is ≥3 chars
   (max 500). Verified end-to-end in the UI: `Case resolved`, note in the
   detail pane and in Postgres.
2. **Resolved filter hid a new PENDING SOS.** Red banner
   `🔔 1 new pending` with **View** and **✕** on any non-Active tab;
   alarm still beeps. Measured **88 ms** from POST to banner in V2, **121 ms**
   in the Phase 2 re-check.
3. **Grafana metrics did not reset on `demo:reset`.** Reset restarts api +
   worker via PM2, which zeroes the in-process counters. Post-reset panels:
   failed jobs 0, overrides 0, SOS rate 0, fired 0, cancelled 0.
4. **"SMS sent" pill was a client-side timer that lied.** The worker now
   writes `escalatedAt` only after the provider confirms, then relays the
   outcome to `POST /internal/escalation-result`; the API emits
   `alert:escalated` / `alert:escalation_failed`; the pill renders **only**
   from `escalatedAt`. Verified both branches: success → `SMS SENT HH:MM:SS`
   and `escalatedAt` set; real 60 s worker failure (`SMS is not configured`)
   → **no pill**, `escalatedAt` NULL, and an "Escalation SMS failed" toast.

### The 9 SKIPs (environment-limited, reasoned) + 1 N/A

- **No Android emulator:** C4/C5 (permission states).
- **FCM unconfigured:** D1–D4, D6 (push drills).
- **Twilio unconfigured:** E2 delivery leg, E9 (SMS arrival).
- **HTTPS redirect disabled:** I5 (N/A by design, documented).
- **Git/secret scans:** I2/I3 were SKIP in V1; now **PASS** (see §5).

No SKIP hides a code failure. Every one needs an external account, device or
deployment target — `docs/DEMO_SETUP.md` is the checklist.

---

## 3. State After the Fixes

- `ESCALATION_DELAY_MS=60000`; Alertmanager rule `rate(...[5m]) > 0.1 for 10m`.
- Prometheus **5/5 targets up** (api ×3 + worker + leave-worker); Alertmanager clear.
- PM2: `api` ×3 cluster (:3001/:3002/:3003) + `worker` ×1 fork (metrics :4001)
  + `leave-worker` ×1 fork (metrics :4002).
- nginx **2 workers**, listening on **:8080** (see §4), with a Cloudflare quick
  tunnel in front for clients on other networks.
- DB: **3 RESOLVED / 0 active**; 502 students (500 loadtest + 2 seed);
  5 wardens; escalation queue empty.
- Dashboard: Vite on **:5173**, `VITE_API_URL` pointing at :8080 (or at the
  tunnel URL for cross-network demos), connection indicator `Live`.
- Git: HEAD `f3fb785`, 230 tracked files, `core.hooksPath=.husky`,
  `gitleaks 8.30.1`, staged + full-history scans **0 findings**, pre-commit
  probe **blocked** (exit 1).
- Flutter: no Android emulator (Windows/Chrome/Edge only); `adb` still absent.

---

## 4. Infrastructure State

| Component | Status | Notes |
|---|---|---|
| PM2 | Online | api ×3 cluster + worker ×1 fork (:4001) + leave-worker ×1 fork (:4002) |
| Postgres | Online | Docker `backend-postgres-1`, DB `hostel_emergency`, 7 migrations applied |
| Redis | Online | Docker `backend-redis-1`, DB 0 app / DB 1 tests |
| Prometheus | Online | :9090, scrapes all 5 targets every 15 s |
| Alertmanager | Online | :9093 |
| Grafana | Online | :3000, admin/admin, 9-panel default dashboard + configured variant |
| nginx | Online | 1.31.8 via `winget` (`nginxinc.nginx`), :8080, round-robin + WS upgrade |
| Cloudflare tunnel | Online | quick tunnel → `http://localhost:8080`; URL lives in `.env` only, never in git (`docs/TUNNEL_SETUP.md`) |
| Warden dashboard | Online | Vite :5173, `VITE_API_URL` required (fails fast if unset) |
| Twilio | **Not configured** | Escalation fails honestly with `SMS is not configured`; `SMS_PROVIDER=mock` covers the dev path |
| FCM | **Not configured** | Push skipped; socket path is primary |
| Android emulator | **Not installed** | C4/C5 remain SKIP |

Both `backend/.env` and `.env.example` set `ENABLE_HTTPS_REDIRECT=false`: TLS
terminates at Cloudflare/nginx, the nginx→API hop is plain HTTP, and an enabled
redirect would 308 every request (`docs/DEMO_SETUP.md` §6 — drill I5 is N/A).

**nginx start command.** `nginx` on PATH is a winget shim. The config is
`backend/nginx.conf`. Keep it in its own terminal; daemon mode dies with the
shell on this host:

```powershell
$prefix = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'nginxinc*' | Select-Object -First 1).FullName + '\nginx-1.31.8'
nginx -p $prefix -c "$PWD\backend\nginx.conf" -g "daemon off;"
```

Verify: `1..6 | % { (curl.exe -s localhost:8080/health | ConvertFrom-Json).instanceId }`
should repeat 3001/3002/3003.

**Public endpoint (cross-network).** For a phone on cellular or another Wi-Fi,
run a Cloudflare tunnel to the proxy — never to a single instance, or F3/F4 stop
holding:

```bash
./.tools/cloudflared.exe tunnel --no-autoupdate --url http://localhost:8080
```

The URL changes on every quick-tunnel start and belongs in `.env` files only
(`docs/TUNNEL_SETUP.md`; the named-tunnel variant gives a stable hostname).

**Which Redis/Postgres?** This machine has two sets. The demo database lives in
`backend-postgres-1`; the queue lives in `backend-redis-1`. `hostel-redis` /
`hostel-pg` are the manual `docker run` names from `.env.example` and are not
the ones in use.

---

## 5. Completed Work

| Phase | Scope | Status |
|---|---|---|
| 0 | Diagnose E6 | COMPLETE |
| 1 | Fix E6 (fail-open limiters, fire-and-forget enqueue, degraded `/health`) | VERIFIED |
| 2 | Resolve UI + banner + server-driven pill | VERIFIED |
| 3 | H1 panels + J4 comment + metrics reset | VERIFIED |
| 4 | F3/F4 — **Option A: nginx installed** | VERIFIED |
| 5 | Env checklist + git init + secret scan | VERIFIED |
| 6 | `HANDOFF.md` + `DEMO_SCRIPT.md` corrected | VERIFIED |
| 7 | All 66 drills re-run → `DRY_RUN_REPORT_V2.md` | COMPLETE |

Verification highlights (actual output, this machine):

```
npm test                                 80 passed, 1 skipped (81 total)
npm test -- tests/multi-instance.test.ts 1 passed (~4.8 s)
gitleaks git --staged --config .gitleaks.toml   no leaks found
gitleaks git --config .gitleaks.toml            no leaks found (11 commits)
node backend/scripts/secret-scan-check.cjs      CLEAN — 0 hits
```

---

## 6. Architectural Decisions — Locked (Do Not Revert)

Carried forward from the pre-fix handoff; the fixes did not break any of these:

1. `io.adapter(createAdapter(pub, sub))` called **before** `server.listen()`.
2. BullMQ worker in **fork mode, `instances: 1`** — never clustered (duplicate
   SMS risk).
3. `maxRetriesPerRequest: null` on the BullMQ Redis connection.
4. **Separate Redis connections**: BullMQ, adapter pub, adapter sub, and the
   rate-limiter client.
5. Worker idempotency guard: `if (alert.status !== "PENDING") return;` — first
   line after fetch.
6. Deterministic `jobId: \`escalation:${alertId}\``.
7. `cancelEscalation` **before** the DB update in the acknowledge handler.
8. `POST /alerts` fire-and-forget enqueue, **<100 ms even if Redis is down**.
9. SOS rate limiter has a **break-glass override**; all limiters fail **open**
   with a 50 ms command ceiling.
10. `transports: ["websocket"]` on both clients (nginx round-robin needs no
    sticky sessions for WebSocket-only clients).
11. Rate limiters are **Redis-backed** (`rate-limit-redis`) with
    `passOnStoreError: true`.
12. `directUrl` for migrations, pooled `DATABASE_URL` for the app.
13. pino redaction covers `passwordHash`, `password`, `token`, `authorization`,
    `TWILIO_AUTH_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_B64`.
14. Firebase version in `firebase-messaging-sw.js` `importScripts` matches
    `package.json`.

Fix-specific decisions:

15. **Only the rate-limiter Redis client is fail-fast.** The BullMQ and adapter
    clients keep their offline queue — dropping commands there would be worse
    than waiting.
16. **nginx upstream is round-robin, not `hash $remote_addr`.** All clients are
    WebSocket-only; round-robin is what makes REST distribution (F4)
    demonstrable. Re-enable `hash ... consistent` only if long-polling returns.
17. **`alerts_by_status` is aggregated with `max by (status)`.** The gauge is
    DB-wide and every API instance exports the same value; `sum()` multiplied
    every count by 3 (showed RESOLVED=9 for 3 rows).

---

## 7. Safety Guarantees — Current Honesty Level

| # | Guarantee | Status | Evidence / scope |
|---|---|---|---|
| 1 | Acknowledged alert never fires SMS | ✅ PASS | Ack removed the delayed job; no worker line for the alert after 70 s (E3/E4/E8) |
| 2 | Worker restart doesn't lose a pending escalation | ✅ PASS | E5: job survived a 9.1 s outage and fired 60.091 s after creation; second run fired 3.3 s after restart |
| 3 | **Redis outage doesn't break SOS delivery** | ✅ **PASS (scoped)** | Creation + persistence + same-instance broadcast hold: `POST /alerts` 201 in **44.7–73.3 ms** (API side; 150–211 ms browser round trip), rows persisted, `/health` degraded. **Scope:** cross-instance fan-out pauses (measured 77 s late, arriving after Redis returned) because Redis pub/sub *is* that transport; escalation also pauses. FCM was never measured (unconfigured). Never phrase this as "realtime everywhere". |
| 4 | Student never blocked from SOS by rate limiting | ✅ PASS | 6th SOS → 201, `sos_overrides_total` 0→1, `sos_rate_limit_overridden` logged (G2); limiters fail open on Redis errors |
| 5 | Cross-instance broadcast <500 ms (Redis healthy) | ✅ PASS | F2: 15–55 ms across runs; Phase 2 probe: 4–8 ms; automated test asserts <500 ms |
| 6 | Stale FCM token deleted on next send | ✅ PASS | Unit-proven with a mock; no real device (D1–D4/D6 SKIP) |
| 7 | No secret in git history or logs | ✅ **VERIFIED** | gitleaks staged **0**, full history **0** over 11 commits / 230 files; repo scanner CLEAN; probe commit **blocked** (exit 1, HEAD unchanged); only `.env.example` files tracked |
| 8 | Dashboard never claims an SMS was sent without provider confirmation | ✅ PASS | Pill renders only from server `escalatedAt` (written after the provider confirms); failed send leaves `escalatedAt` NULL, shows the "Escalation SMS failed" toast, and `escalations_fired_total` stays 0. No client-side timer remains |
| 9 | A network outage of one API instance does not take the wardens offline | ✅ PASS | F3/F4 through nginx: two instances stopped, dashboard stayed `Live` and its socket moved 3001 → 3002; `POST /alerts` through :8080 returned 201 via the survivor |

Guarantees #3 and #5 cannot both be absolute during a Redis outage. Say so.

---

## 8. Known Traps (Updated)

| Symptom | Cause | Fix |
|---|---|---|
| **SOS hangs when Redis is down** | Limiter fail-closed, awaited enqueue, or `/health` 503 | `passOnStoreError: true` + 50 ms race; fire-and-forget enqueue; `/health` 200 `degraded` |
| **Grafana pipeline count is 3× the DB** | DB-wide gauge exported by every API instance, `sum by (status)` | `max by (status)` (fixed) |
| **Grafana failed-jobs panel spikes after a job is acknowledged** | `increase()` over a gauge: removal looks like a rate jump | `max(bullmq_jobs{state="failed"})` — the current count (fixed 2026-11-11) |
| **Grafana shows stale counters after reset** | Counters live in the process, not the DB | `demo:reset` restarts api + worker as its last step |
| **Grafana ignores a dashboard edit** | UTF-8 **BOM** from PowerShell `Set-Content` → `invalid character 'ï'` | Save UTF-8 **without BOM**; check first bytes `123,10`; restart Grafana and read the provisioning log |
| **Seq Scan on `EmergencyAlert` at demo size** | Planner choice, not a bug (the old comment claimed otherwise) | `npx tsx scripts/perf-seed.ts`; at 5,003 rows the planner picks the composite index unforced |
| **Forced plan picks `idx_alerts_student`, not the composite** | Which index wins under `enable_seqscan=off` is statistics-dependent | The claim that matters is the unforced 5,003-row plan; comment says so |
| "SMS sent" pill lies | Client-side 60 s timer | Server relays the worker outcome; pill is receipt-driven |
| Resolved filter hides a new PENDING | `alert:new` filtered out silently | New-alert banner with View / dismiss |
| nginx dies when the terminal closes | Windows console owns the process | Start with `-g "daemon off;"` in a terminal you keep open |
| nginx fails with `mime.types` not found | Relative `include` resolves against the config directory | `include mime.types;` removed — this proxy serves no static files |
| `maxRetriesPerRequest must be null` | BullMQ config | `maxRetriesPerRequest: null` |
| Push silently doesn't arrive | Firebase version mismatch (SW vs package.json) | Pin both |
| Cross-instance alerts don't arrive | `io.adapter()` after `listen()` | Move before `listen()` |
| Duplicate SMS escalations | Worker clustered | `instances: 1`, `exec_mode: "fork"` |
| SMS fires after acknowledge | Missing/misplaced idempotency guard | `if (alert.status !== "PENDING") return;` first |
| `cancelEscalation` never works | Random job ids / shorthand remove | Deterministic `jobId` + `job.remove()` |
| Rate limit is 3× intended | In-memory limiter across instances | `rate-limit-redis` |
| Pre-commit hook doesn't fire | Husky not installed | `git config core.hooksPath .husky` (or `npm run hooks:install`) |
| `git commit` blocked by the secret scanner | The file being committed contains a secret-shaped string (even in docs) | Remove the value, or add a **narrow** `.gitleaks.toml` allowlist; never use `--no-verify` blindly |
| Auth limiter trips during rehearsal | 10 logins / 15 min / IP is real | Wait, or clear `rl:auth*` in Redis; do not weaken it (G3 asserts it) |
| Twilio trial SMS silently doesn't arrive | Unverified recipient (error 21608) | Verify the number in the Twilio console |
| `alert:new` visible to students | `io.emit(...)` instead of `io.to("wardens").emit(...)` | Target the `wardens` room |
| Web push doesn't work on `http://192.168.x.x` | Requires HTTPS or localhost | Deploy with TLS, or test on localhost |
| iOS Safari web push doesn't work in a tab | Needs an installed PWA (16.4+) | Add to Home Screen |

---

## 9. Immediate Next Steps (in order)

1. **Read `docs/DRY_RUN_REPORT_V2.md`.** It is the authoritative result set;
   this file is the orientation.
2. **Rehearse the script twice** (`docs/DEMO_SCRIPT.md`) with the nginx
   topology running. The pre-flight starts nginx and points Vite at :8080. If
   the student phone is on a different network, also start the Cloudflare
   tunnel to :8080, set `VITE_API_URL` and the Flutter `API_BASE_URL` to the
   tunnel URL, and restart Vite — a quick-tunnel URL changes on every start
   (`docs/TUNNEL_SETUP.md`).
3. **Configure Twilio + FCM + an Android emulator** using
   `docs/DEMO_SETUP.md` §1–§3. That converts E2 delivery/E9, D1–D4/D6 and
   C4/C5 from SKIP to runnable. Without Twilio but with time to spare, §1.2b's
   `SMS_PROVIDER=mock` exercises the escalation path (dev only).
4. **Re-run Group 8 "two runs in a row"** with real Twilio and FCM — the actual
   demo rehearsal, not another dry run.
5. **Print the stage copy** from `DEMO_SCRIPT.md`; keep the rehearsal notes
   off-screen.
6. **Write the report / viva document** from `AUDIT.md`, `DEMO_SCRIPT.md`,
   `LOAD_TEST_RESULTS.md`, `DRY_RUN_REPORT_V2.md` and §7 here.

---

## 10. What Comes After the Fixes

1. `docs/DRY_RUN_REPORT_V2.md` with verdict **GO** — done; no originally-PASS
   drill regressed (the 56 PASSes are all 47 V1 PASSes, plus I2/I3, plus the
   7 fixed FAILs).
2. Phase 5 manual checklist — git done; Twilio/FCM/Android remain ~2 hours of
   console clicking, no code.
3. Re-run the two consecutive full scripts with the real channels.
4. Rehearse five times.
5. Assemble the report / viva document.
6. Submit and defend.

Suggested follow-ups (not implemented — recorded so they are not lost):

- `socket_io_connected` is still summed across instances and counts student
  sockets too. Consider per-instance series, or label/filter by role.
- `cancelEscalation()` removes an already-failed job and counts it as
  cancelled, so the Grafana failure evidence disappears on ack. The demo script
  documents this trap.
- `startQueueMetrics` runs an unbounded `getJobCounts()` every 15 s with no
  overlap guard.
- The auth limiter (10/15 min/IP) is easy to trip during rehearsal; do not
  weaken it without re-running G3.
- I4: make response `X-Request-Id` match pino `req.id` for direct requests, or
  keep the documented proxy-only limitation.

---

## 11. Reference Systems (For the Report — Unchanged)

- **Academic paper:** *"Design and Implementation of an Integrated Hostel
  Management System with Role-Based Access for Students and Wardens"* (2025) —
  three-tier architecture, emergency messaging, MySQL + PHP.
- **PaperBox Hostel App** — commercial, "Student wellbeing alerts & SOS",
  "Warden dashboard with analytics".
- **Solve-Health (V-HEALTH)** — open-source, warden dashboard with health
  analytics.
- **CampusHub** — one-tap SOS with authority routing + live GPS.
- **CggPullServices** — government app, warden sends health status via SMS to a
  central server.

---

## 12. The 10-Sentence Viva Cheat Sheet

1. "It's a hostel emergency system where students report medical emergencies
   with one tap and the warden is notified in under a second, with an automatic
   SMS escalation if not acknowledged in 60 seconds."
2. "The core design principle is that the system, not the student, is
   responsible for getting the alert to a human."
3. "The escalation timer lives in Redis, not in JavaScript memory — so it
   survives a server restart."
4. "We run three API instances with a Redis adapter for cross-instance
   Socket.IO broadcast, behind an nginx front door — verified by a passing
   multi-instance test and a live failover drill."
5. "The BullMQ worker runs as a single process, not clustered — a clustered
   worker could fire the same escalation twice."
6. "The idempotency guard in the worker prevents an SMS firing after the warden
   has acknowledged."
7. "The SOS rate limiter has a break-glass override, and it fails open if Redis
   is unreachable — a stuck button must not prevent a real emergency."
8. "The dashboard query uses an index on `(status, created_at DESC)`; at low row
   counts the optimizer correctly chooses a Seq Scan, so we prove the index
   with a 5,000-row synthetic seed, where the planner picks it unforced."
9. "We load-tested with 500 students, 50 warden sockets, 100 SOS over 60
   seconds. p95 response was under 200 ms."
10. "A Redis outage degrades escalation and cross-instance fan-out, but SOS
    creation, persistence and receipt still succeed in **44.7–73.3 ms on the API
    side** (150–211 ms browser round trip) — verified by stopping Redis and
    measuring six requests."

Use #8 and #10 only because they are now measured; do not upgrade #10 to
"realtime everywhere".

---

## 13. Evidence Index

| What | Where |
|---|---|
| V2 per-drill tables, actual outputs, verdict | `docs/DRY_RUN_REPORT_V2.md` |
| V1 historical report (do not edit) | `docs/DRY_RUN_REPORT.md` |
| Setup that is not code (Twilio/FCM/Android/nginx) | `docs/DEMO_SETUP.md` |
| Presenter runbook | `docs/DEMO_SCRIPT.md` |
| J4 plans | `backend/src/routes/alert.routes.ts:481-560`, `backend/explain.sql`, `backend/scripts/perf-seed.ts` |
| Opt-in index test | `backend/tests/index.test.ts` (`RUN_INDEX_TEST=true npm test -- tests/index.test.ts`) |
| Multi-instance test | `backend/tests/multi-instance.test.ts` (stop PM2 first) |
| nginx config | `backend/nginx.conf` |
| Public endpoint / tunnel | `docs/TUNNEL_SETUP.md` (quick + named tunnel, nginx variant, verification) |
| Secret scan | `.gitleaks.toml`, `.husky/pre-commit`, `backend/scripts/secret-scan-check.cjs` |
| HTTPS-redirect drill (I5, N/A) | `docs/DEMO_SETUP.md` §6, `backend/src/middleware/httpsRedirect.ts` |
| Security review | `docs/AUDIT.md` |
| Load test | `docs/LOAD_TEST_RESULTS.md` |

---

**End of handoff.** The pre-fix handoff is superseded; do not copy its V1
verdict or its "Redis-down is fine" / "no nginx" claims into a new session.
