# HostelGuard — Pre-Demo QA Dry Run Report

**Date:** 2026-11-08
**Scope:** End-to-end dry run of the HostelGuard demo (backend, warden dashboard, escalation worker, monitoring stack, demo script, test suites).
**Drill source:** The drill list was supplied as the A1–L2 block sequence in the working conversation. `HANDOFF.md` is **absent** and its §7 (criticality), §9 (exit criteria) and §13 (report format) mappings **could not be verified**. Drill names below are reconstructed from the executed sequence, not copied from HANDOFF.

**Method constraints applied**
- Every drill was executed in order; the report records actual output only.
- No application code was changed during the dry run. The four authorized setup fixes were completed before Block A.
- Phone/Flutter actions were substituted with the same HTTP + Socket.IO paths (student JWT, `POST /alerts`, student socket listener). This is a substitution, not a phone test.
- A mismatch between the drill's literal expectation and observed output is recorded as **FAIL**, not rationalized.
- Temporary test-only changes (escalation delay, alert-rule thresholds) were restored; verification is in “Restoration” at the end.

---

## 1. Summary

| Verdict | Count |
|---|---|
| **PASS** | **47** |
| **FAIL** | **7** |
| **SKIP** | **11** |
| **N/A** | **1** |
| **Total drills** | **66** |

| Block | PASS | FAIL | SKIP | N/A |
|---|---:|---:|---:|---:|
| A — Auth & RBAC (A1–A5) | 5 | 0 | 0 | 0 |
| B — Realtime dashboard (B1–B6) | 6 | 0 | 0 | 0 |
| C — Map & location (C1–C7) | 5 | 0 | 2 | 0 |
| D — Push notifications (D1–D7) | 2 | 0 | 5 | 0 |
| E — Escalation (E1–E9) | 6 | 1 | 2 | 0 |
| F — Multi-instance failure (F1–F5) | 3 | 2 | 0 | 0 |
| G — Rate limiting & metrics auth (G1–G4) | 4 | 0 | 0 | 0 |
| H — Observability (H1–H5) | 4 | 1 | 0 | 0 |
| I — Log & secret hygiene (I1–I5) | 2 | 0 | 2 | 1 |
| J — Data integrity & indexing (J1–J4) | 3 | 1 | 0 | 0 |
| K — Demo readiness (K1–K7) | 5 | 2 | 0 | 0 |
| L — Automated tests (L1–L2) | 2 | 0 | 0 | 0 |

**Green light: NO-GO.** Critical failures E6 and K6/K7 mean the safety guarantee and the demo script itself do not hold as written. Details in §4.

---

## 2. Environment and substitutions

| Item | State |
|---|---|
| Backend | PM2 `api` ×3 (3001/3002/3003, cluster) + `worker` ×1, `NODE_ENV=production` |
| Database | PostgreSQL container `backend-postgres-1`, DB `hostel_emergency` |
| Redis | container `backend-redis-1`, DB 0 for app, DB 1 for tests |
| Monitoring | Prometheus :9090, Alertmanager :9093, Grafana :3000 (all containers up) |
| Dashboard | Vite on :5173, `VITE_API_URL=http://localhost:3001` |
| Student app | Flutter; `flutter devices` shows only Windows/Chrome/Edge — **no Android emulator** |
| Twilio | `TWILIO_*` / `WARDEN_ONCALL_PHONE` **unset** — SMS delivery impossible |
| FCM | `FIREBASE_SERVICE_ACCOUNT_B64` **unset**, dashboard VAPID key is `TEST-VAPID-KEY` — push delivery impossible |
| Git | **not a git repository** (no `.git` at root or `backend/`) |
| nginx | config file present, **no nginx process / no load balancer** |

**Substitutions**
- Phone SOS: real student login + `POST /alerts` from the dashboard page context.
- Phone confirmation: real student Socket.IO connection logging `alert:updated`.
- 2:15 resolve step: dashboard has no Resolve control, so `PATCH /alerts/:id/resolve` was used.
- Push and SMS legs are not simulated — they are unavailable and recorded as SKIP.

---

## 3. Drill results

### Block A — Authentication & RBAC

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| A1 | Student login returns 200 + token + user | 200; `Aarav Sharma`, role `STUDENT`; JWT valid 7d | PASS |
| A2 | Warden login returns 200 + token + user | 200; `Priya Nair`, role `WARDEN`; JWT valid 7d | PASS |
| A3 | Wrong password → 401 generic error | 401 `{"error":"Invalid credentials"}` | PASS |
| A4 | Student on warden list → 403 | 403 `{"error":"Forbidden: requires role WARDEN"}` | PASS |
| A5 | Warden creating SOS → 403 | 403 `{"error":"Forbidden: requires role STUDENT"}` | PASS |

Note: login requires an explicit `role` field (`STUDENT`/`WARDEN`); omitting it returns 400. Not a drill failure, but a demo pre-flight gotcha.

### Block B — Realtime dashboard

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| B1 | New SOS renders without refresh and beeps | Card rendered in **635 ms** without reload; **1** oscillator created | PASS |
| B2 | Card shows student, room, type, time | `Aarav Sharma`, `Room B-314`, `FIRE`, `01:30:33 PM` | PASS |
| B3 | Acknowledge propagates to student socket | Student received `alert:updated ACKNOWLEDGED` **116 ms** after click | PASS |
| B4 | Acknowledged state survives reload | After reload: `ACKNOWLEDGED`, acknowledged-at line present, RESPONDING=1 | PASS |
| B5 | Alert created while dashboard closed is visible on reopen | `SECURITY` alert created while tab closed; visible on reopen | PASS |
| B6 | Dashboard ack sends one PATCH, no error, cancels one job | One PATCH; no error banner; worker job removed | PASS |

### Block C — Map & location

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| C1 | GPS alert shows marker, accuracy circle, coordinates | Marker + circle + `12.97190, 77.59480 ±12m` | PASS |
| C2 | No-GPS alert shows banner and no markers | “Location unavailable — this alert was sent without GPS data”; 0 markers | PASS |
| C3 | No-GPS alert never plots 0,0 | No `0.00000, 0.00000`; no circle | PASS |
| C4 | Mobile permission-denied flow | No Android emulator; cannot exercise OS permission dialog | SKIP |
| C5 | Mobile GPS-timeout flow | No Android emulator; cannot exercise OS timeout | SKIP |
| C6 | Map recenters per selected alert | Leaflet zoom transform changed between two GPS alerts and back | PASS |
| C7 | Detail shows medical conditions + emergency contact | `Asthma`, `+91 98765 43210` | PASS |

### Block D — Push notifications

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| D1 | Foreground push → toast + beep | FCM not initialised; no push ever arrives | SKIP |
| D2 | Background push → OS notification | FCM not initialised | SKIP |
| D3 | Notification click → deep link to alert | No notification to click | SKIP |
| D4 | Stale FCM token removed | No FCM registration possible | SKIP |
| D5 | Push blocked → banner, socket still live | `Push: blocked`, banner + “How to enable”, realtime `Live` | PASS |
| D6 | FCM metrics increment | No FCM metrics emitted | SKIP |
| D7 | Secure-context prerequisite | `http://localhost:5173` is a secure context (`isSecureContext=true`) | PASS |

### Block E — Escalation worker

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| E1 | Worker starts and logs ready | `[worker] Escalation worker ready` | PASS |
| E2 | SMS sent at `ESCALATION_DELAY_MS` (10 s override) | Scheduler fired at **10.227 s**; send failed `SMS is not configured`; `escalations_fired_total` stayed 0 — delivery leg unverifiable | SKIP |
| E3 | Ack before delay cancels SMS | Ack at **5.48 s**; job removed; no send attempt | PASS |
| E4 | Ack near the boundary / idempotency | First attempt acked at 10.108 s and correctly fired; retry acked at **9.604 s** with no send | PASS |
| E5 | Worker restart does not reset delayed job | Job survived stop/start, fired **1.6 s** after worker came back | PASS |
| E6 | Redis down: SOS still 201 in <100 ms | `curl` exit **28**, HTTP **000** after **5.007 s** (also 10 s attempt); `/health` 503; request blocked in Redis-backed limiter | **FAIL** |
| E7 | Recovery when Redis returns | 201 in **27.9 ms**; escalation fired at 10.108 s; recovered without manual API restart (~30–60 s) | PASS |
| E8 | Ack after SMS fired → no duplicate | PATCH 200; exactly one send attempt recorded for that alert | PASS |
| E9 | Twilio console confirms delivery | No Twilio account/console configured | SKIP |

### Block F — Multi-instance failure

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| F1 | Three instances report distinct ids | `3001`, `3002`, `3003` response times +32/+36 ms | PASS |
| F2 | Cross-instance alert events | Sockets on 3001 and 3002 both received `alert:new`; latency 140/144 ms | PASS |
| F3 | Kill one instance; dashboard reconnects elsewhere | Dashboard pinned to `:3001`; stayed `Disconnected` for >7 s and never reconnected to another instance (no LB) | **FAIL** |
| F4 | Kill one instance; API traffic fails over | POST to dead `:3001` → HTTP 000; `:3002` only served requests posted directly to `:3002` | **FAIL** |
| F5 | Restart instance; health and dashboard recover | `:3001` health 200; dashboard back to `Live` | PASS |

### Block G — Rate limiting & metrics auth

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| G1 | 5 SOS/min allowed | 5 × HTTP 201 | PASS |
| G2 | 6th SOS gets break-glass override, not 429 | 6th HTTP 201; `sos_overrides_total` 0→1; `sos_rate_limit_overridden` warn log | PASS |
| G3 | Login limiter blocks 11th attempt in 15 min | Attempts 1–10 → 401; attempt 11 → 429 with `Retry-After: 900` | PASS |
| G4 | `/metrics` requires token | No token → HTTP 401 | PASS |

### Block H — Observability

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| H1 | Grafana dashboard panels all populated | **10** panels (drill text says 8); **SMS delivery rate** and **FCM stale token rate** both `No data` | **FAIL** |
| H2 | Connected-wardens gauge tracks sockets | `socket_io_connected` 2 → 3 → 2 on connect/disconnect | PASS |
| H3 | `EscalationFailuresHigh` fires on failures | With temporary `[1m]`/`for: 30s`: firing at t+72 s; Alertmanager showed 2 active | PASS |
| H4 | Alert clears on recovery | Inactive/cleared at t+24 s; Alertmanager empty | PASS |
| H5 | All Prometheus targets up | 4/4 `up` (api 3001/3002/3003 + worker 4001) | PASS |

H3/H4 used a temporary rule edit (`rate(...[1m]) > 0.1`, `for: 30s`) and a Prometheus restart; the committed rule was restored afterwards.

### Block I — Log & secret hygiene

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| I1 | Logs contain no secret values | `authorization:"[redacted]"`; 0 hits for `demo-metrics-token`, `password123`, `jwt`, `Bearer eyJ`; `TWILIO_*` hits are env-var names inside error text only | PASS |
| I2 | No secrets in git history | Not a git repository | SKIP |
| I3 | No untracked secret files / `.env` ignored | Not a git repository | SKIP |
| I4 | Request ID correlates a request across logs | Response `X-Request-Id` found in exactly one log line, but that line’s pino `req.id` was different: `requestId()` sets the response header only, so direct requests make pino mint its own id | PASS (with note) |
| I5 | HTTP → HTTPS redirect | Disabled by `ENABLE_HTTPS_REDIRECT=false`; implementation uses **308**, not 301; `/health` and `/metrics` exempt | N/A |

### Block J — Data integrity & indexing

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| J1 | Every ACKNOWLEDGED row has ack fields | 0 rows missing `acknowledgedAt`/`acknowledgedBy` | PASS |
| J2 | Every RESOLVED row has `resolvedAt` + note | 0 rows missing either | PASS |
| J3 | No orphan device tokens | 0 orphans | PASS |
| J4 | History query uses `idx_alerts_status_created` | At 86 rows the planner chose **Seq Scan + Sort**; forcing `enable_seqscan=off` uses **Bitmap Index Scan on `idx_alerts_status_created`** (index exists and is usable) | **FAIL** |

### Block K — Demo readiness

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| K1 | `demo:reset` produces clean demo state | `0 active alerts, 3 resolved, 502 students, 5 wardens`; alerts deleted=86; queue flushed | PASS |
| K2 | Reset is idempotent | Second run: deleted alerts=3; identical summary | PASS |
| K3 | Reset refuses in production | `NODE_ENV=production` → `REFUSED`, exit code 1 | PASS |
| K4 | History filters and pagination | 3 rows, 8 columns; name `Diya` → 1 row; date/status filters work | PASS |
| K5 | CSV export has 8 audit columns and notes | Header + 3 rows, 8 columns, resolution note included; filter-aware (Diya → 1 row) | PASS |
| K6 | Full demo script, run 1 | Executed; **4 script steps fail** (see §3.1) | **FAIL** |
| K7 | Full demo script, run 2 | Same failures reproduced | **FAIL** |

#### 3.1 K6/K7 detail — what the demo script actually does

| Script step | Observed |
|---|---|
| 0:00 empty board | Pass after pre-flight; first K6 attempt was hidden behind a **persisted “Resolved” filter** left over from QA. Required a manual click on “Active”. |
| 0:30 SOS appears, beeps | K6 798 ms, K7 452 ms; 1 beep; GPS chip; countdown 60 s; coordinates `12.97160, 77.59460 ±15m` / `±10m` |
| 1:30 Acknowledge | K6 202 ms, K7 65 ms; student socket got `alert:updated ACKNOWLEDGED`; `escalation-status` → `scheduled:false`; no worker attempt |
| 2:15 escalation fires | Fired at **60.07 s** (K6) / **60.06 s** (K7); worker logged “unacknowledged — sending escalation SMS” then `SMS is not configured`; `escalations_fired_total` **0**. The card still shows a red **“SMS sent”** pill — a client-side 60 s approximation, not delivery truth. |
| 2:15 resolve with note | **No Resolve control exists in the dashboard.** Only Acknowledge is exposed. Resolve had to be done with `PATCH /alerts/:id/resolve`; student socket then received `RESOLVED`. |
| 3:45 history + index claim | Filters and 8-column export pass. The spoken claim “it is an index scan, not a table scan” is **false at 86 rows** (Seq Scan + Sort). |
| 4:45 Grafana | Dashboard only rendered in a fresh tab. Panel 1 showed **244** (K6) / **247** (K7), not 0; “escalations cancelled” showed **1.35 K**; “Alert pipeline” showed **PENDING 2** although the DB had 0 pending; SMS/FCM panels `No data`. |
| 5:45 multi-instance | `instanceId` 3001/3002/3003 confirmed; `nginx.conf` lists 3 upstreams — but no nginx is running. |
| 6:30 Redis-down drill | `curl` exit 28, HTTP 000 after 5 s; `/health` 503; auto-recovery after restart. The script’s “still 201, still realtime” is **false**. |
| 7:15 close | No functional step. |

### Block L — Automated tests

| Drill | Expected | Actual | Verdict |
|---|---|---|---|
| L1 | Full suite passes (9 files / 74 tests) | **9 files, 74 tests passed** in 59.99 s | PASS |
| L2 | Multi-instance test passes | First attempt failed only because ports 3001/3002 were held by PM2 (the test’s documented precondition). With PM2 stopped: **1 test passed** in 3.785 s, including the <500 ms cross-instance assertions | PASS |

---

## 4. Critical failures

| # | Drill | Failure | Why it is critical |
|---|---|---|---|
| C-1 | **E6** | Redis down → SOS POST hangs and returns HTTP 000 (5 s client timeout; 10 s attempt also 000), while `/health` returns 503 | The SOS path is blocked by the Redis-backed limiter. At the exact moment the safety-critical dependency is degraded, the emergency button stops working. This directly contradicts the demo script and the “SOS survives Redis” backup answer. |
| C-2 | **K6/K7** | Demo script does not execute as written: no Resolve UI, SMS delivery unavailable, index claim false, Redis-down claim false, Grafana panel values wrong/stale | The 7-minute story breaks at 2:15 (cannot resolve), 3:45 (false index claim), 4:45 (panel 1 says 244/247), and 6:30 (Redis drill hangs). A presenter would have to improvise or skip four sections. |

> HANDOFF §7 was not available, so the criticality labels above are this review’s judgment, not a verified mapping to HANDOFF’s definitions.

---

## 5. Non-critical failures and observations

| # | Drill/Observation | Detail | Impact |
|---|---|---|---|
| N-1 | F3 | Dashboard stayed `Disconnected` after killing its instance; no reconnection to another instance | No load balancer, so client-side failover is impossible. `nginx.conf` exists but is not running. |
| N-2 | F4 | POST to dead `:3001` → HTTP 000; surviving `:3002` served only direct requests | Same root cause as N-1. |
| N-3 | H1 | SMS delivery and FCM stale-token panels show `No data`; 10 panels vs 8 expected | Two observability claims cannot be shown. |
| N-4 | J4 | Planner uses Seq Scan + Sort at 86 rows; index exists and is used when forced | Demo’s “index scan” claim is false at demo data volume. |
| N-5 | K6 attempt 1 | Persisted “Resolved” filter hid a new PENDING SOS; only the counter changed | A warden who leaves the Resolved tab selected can miss a live emergency board entry (audio still beeps if alarm is enabled). |
| N-6 | K6/K7 | “SMS sent” pill is a client-side 60 s approximation and displays even when the worker’s send failed | UI can claim delivery that did not happen. |
| N-7 | K6/K7 | After `demo:reset`, Grafana shows panel 1 = 244/247, cancelled = 1.35 K, PENDING = 2 | Metrics are not reset by `demo:reset`; `increase()` on gauges/counters across resets/restarts extrapolates nonsense. The “must be 0” safety panel is not credible right after reset. |
| N-8 | I4 | Response `X-Request-Id` differs from pino’s `req.id` for direct requests | Log correlation works only when a proxy injects the header; a client-reported response id will not match the request log line. |
| N-9 | L2 precondition | Initial `npm test -- tests/multi-instance.test.ts` failed with “Timed out … connected” because ports 3001/3002 were held by PM2; passed in 3.78 s once PM2 was stopped | Test is correct but cannot run alongside the demo stack; the precondition is documented in the test header. |

---

## 6. Skips and N/A (with reasons)

| Drill | Reason |
|---|---|
| C4, C5 | No Android emulator/device. `flutter devices` lists only Windows/Chrome/Edge, so OS permission-denied and GPS-timeout dialogs cannot be exercised. |
| D1, D2, D3, D4, D6 | FCM is disabled: `FIREBASE_SERVICE_ACCOUNT_B64` unset and the dashboard VAPID key is `TEST-VAPID-KEY`. No push can be delivered, so foreground/background/click/stale-token/metric drills cannot run. |
| E2 (delivery leg) | Twilio credentials unset. Scheduler timing was verified (10.227 s), but no SMS can be sent. |
| E9 | No Twilio console/account to confirm delivery. |
| I2, I3 | Not a git repository; no history or ignore rules to inspect. |
| I5 | N/A: `ENABLE_HTTPS_REDIRECT=false`. When enabled the middleware returns **308**, not the 301 the drill describes; `/health` and `/metrics` are exempt. |

**No skip was used to hide a code failure.** Every skip is environment-limited and independently reproducible from the stated reason.

---

## 7. Green Light verdict

**NO-GO for the demo as scripted.**

What is solid:
- Auth/RBAC, realtime LAN path, GPS/no-GPS rendering, acknowledgement propagation, audit history, CSV export, rate-limit break-glass, test suite (74/74), and multi-instance fan-out all work and are evidenced.
- The 60-second escalation scheduler is accurate to ~70 ms and the idempotency guard works.

What blocks a green light:
1. **E6** — Redis outage makes the SOS request hang/fail. This is a safety-guarantee breach, not cosmetic.
2. **K6/K7** — the demo script cannot be performed as written (no Resolve UI; SMS leg unavailable; false index and Redis-down claims; Grafana shows stale/wrong headline numbers).
3. Supporting failures **F3/F4** (no failover), **H1** (two panels empty), **J4** (index claim false) would each be survivable alone, but together they undermine the multi-instance and observability story.

A **conditional reduced demo** is possible if the presenter:
- cuts the 2:15 “resolve with a note” step (or resolves via API off-screen),
- cuts the 3:45 index-scan claim,
- replaces the 4:45 Grafana panel-1 walkthrough with Prometheus’s raw `bullmq_jobs{state="failed"}` = 0 (after confirming 0), and
- cuts or rewrites the 6:30 Redis-down drill.

That reduced demo is not the script in `docs/DEMO_SCRIPT.md`, so it is not a green light for the current document.

---

## 8. Recommended next action

**P0 — before any demo**
1. **Fix the SOS path under Redis failure (E6).** Either bound the limiter’s Redis call (fail-open with a warning + metric for the SOS limiter specifically) or move the SOS limiter’s store to a local fallback when Redis is unavailable. Acceptance: Redis stopped → `POST /alerts` returns 201 in <100 ms and the alert is persisted; `/health` may remain 503.
2. **Add a Resolve control to the warden dashboard** (note required, ≥10 chars) or change the demo script to use the API. Acceptance: acknowledge → resolve with note → card shows `RESOLVED` and the note appears in History.
3. **Decide the Grafana story.** Fix panel queries so a clean reset shows 0:
   - panel 1 must not use `increase()` on the `bullmq_jobs` gauge;
   - panel 4 must not treat PM2 restarts as escalation events (`increase()` over counters that reset);
   - `demo:reset` should reset or clearly age the metrics used by the demo;
   - investigate the `PENDING 2` gauge after reset.
4. **Align `docs/DEMO_SCRIPT.md` with reality**: remove/replace the <100 ms Redis claim, the index-scan claim at demo volume, the SMS-delivery claim without Twilio, and the “must be 0” panel claim unless N-7 is fixed.

**P1 — before calling it production-ready**
5. Run nginx (or another LB) or remove the failover claims from the script; otherwise F3/F4 remain expected failures.
6. Make response `X-Request-Id` and pino `req.id` identical for direct requests (set `req.headers['x-request-id']` inside `requestId()` before pino’s `genReqId` reads it), or document the proxy-only limitation.
7. Populate or remove the SMS/FCM panels when those integrations are disabled.

**P2 — hygiene**
8. Reset the persisted dashboard filter to `active` as part of `demo:reset`/pre-flight, or do not hide PENDING alerts behind the Resolved tab.
9. Make the “SMS sent” pill reflect `escalation-status` or label it “60 s elapsed”, not “SMS sent”.
10. Document the L2 prerequisite (ports 3001/3002 free) in the test runner or make the test use non-demo ports.

---

## 9. Evidence and restoration

- Drill evidence was captured live from HTTP responses, worker/API logs, Prometheus API, Alertmanager API, Grafana DOM, PostgreSQL (`docker exec … psql`), and Playwright downloads.
- CSV checks: unfiltered export 8 columns + 3 rows; filtered export 8 columns + 2 rows; both include resolution notes.
- Test evidence: `npm test` → **9 files / 74 tests passed** in 59.99 s; `npm test -- tests/multi-instance.test.ts` → **1 test passed** in 3.785 s (ports free).
- Restoration verified after the run:
  - `backend/.env` → `ESCALATION_DELAY_MS=60000`, `ENABLE_HTTPS_REDIRECT=false`.
  - `backend/monitoring/rules/hostel.yml` → `rate(bullmq_jobs{state="failed"}[5m]) > 0.1`, `for: 10m`.
  - Prometheus restarted after rule restore; 4/4 targets `up`.
  - PM2 restarted: api ×3 + worker online; `/health` 200 with ids 3001/3002/3003.
  - `npm run demo:reset` → `0 active alerts, 3 resolved, 502 students, 5 wardens`.
  - Temporary probe processes stopped.

**Residual environment state:** Grafana panels may still display historical values until their 1 h window ages out; this is the N-7 metric-reset defect, not a leftover probe.
