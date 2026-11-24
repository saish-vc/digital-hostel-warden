# HostelGuard — Dry-Run Report V3 (Full 66-Drill Re-Verification)

**Drills executed:** 2026-11-20 (live, this machine — full set re-run)
**Supersedes:** V2 (2026-11-10/12, preserved in git history) — V2 evidence was
retained only where the 2026-11-20 run re-verified the same drill; every drill
below was executed or re-executed on 2026-11-20.
**Baseline:** `docs/DRY_RUN_REPORT.md` (V1, 2026-11-08 — preserved unchanged)
**Scope:** the full 66-drill set (A1–L2) against the current build — Phases 1–6
of the remediation plan applied (cross-network foundation, server-driven
escalation UI, metrics fixes, nginx topology decision, docs reconciliation) —
plus the Phase 7 drills themselves.

---

## 1. Verdict

> ## **GO for the demo as scripted** — 57 PASS / 0 FAIL / 8 SKIP / 1 N/A.

| | V1 (2026-11-08) | V2 (2026-11-10/12) | V3 (2026-11-20) |
|---|---|---|---|
| PASS | 47 | 56 | **57** |
| FAIL | 7 | 0 | **0** |
| SKIP | 11 | 9 | **8** |
| N/A | 1 | 1 | **1** |
| Total | 66 | 66 | 66 |
| Verdict | **NO-GO** | GO | **GO** |

**Why 57:** V2's E2 was counted SKIP because only the scheduler timing was
verifiable. On 2026-11-20 the escalation leg was exercised both ways — the
honest failure path (Twilio unconfigured) and the success path via the
`SMS_PROVIDER=mock` rehearsal provider (§1.2b) — so E2 is a full PASS and only
the Twilio-console confirmation (E9) remains skipped. Net: 56 + 1 = 57, SKIP 9 − 1 = 8.

No drill failed. One environment incident occurred mid-run-1 (an orphaned dev
worker held the escalation queue with mock credentials) — it was detected,
root-caused, repaired, and the affected leg was re-run cleanly. It is disclosed
in §5 and says nothing against the product: the queue, the scheduler, the
idempotency guard and the metrics all behaved exactly as designed throughout.

---

## 2. Stop-point / phase-gate record

The remediation plan gated work behind STOP points. Each gate's verification
evidence:

| Gate | Content | Verified | Evidence |
|---|---|---|---|
| Pre-Flight | Baseline: 80 tests pass / 1 skip; nginx topology chosen; Twilio/FCM unconfigured documented | PASS | `npm test` 80/1 (re-run at L1); `docs/DEMO_SETUP.md` §1 |
| STOP 1 → Phase 1 | Cross-network: CORS allowlist, 0.0.0.0 bind, `API_PORT`/`3001` default, `AppConfig.apiBase` + `API_BASE_URL` dart-define, `VITE_API_URL` required, `docs/TUNNEL_SETUP.md`, cloudflared quick tunnel | PASS | A1–A5 via tunnel; F1 through :8080; dashboard served with tunnel `VITE_API_URL`; phone-path documented, never pointed at a single API port |
| STOP 2 → Phase 2 | Resolve UI + filter banner + server-driven SMS pill; `PATCH /alerts/:id/resolve` (3–500-char note); `cancelEscalation` before DB update; `alert:resolved` fan-out | PASS | B6, K6/K7 resolve legs; banner drill ×3 (§4.1); pill semantics B1/B2/E2/mock drill |
| STOP 3 → Phase 3 | Grafana `or vector(0)`; J4 index comment + seed; metrics reset in `demo:reset`; min step 15s | PASS | H1 (0 “No data”); J4 three plans; K1/K2 counters zeroed |
| STOP 4 → Phase 4 | F3/F4 topology decision → keep nginx (Option A) | PASS | F3/F4 re-verified through :8080 (54 PASS tally in the phase guide) |
| Phase 5 | `DEMO_SETUP.md` reconciled; git init + gitleaks live re-verified | PASS | I2/I3; §4 Block I |
| Phase 6 | `HANDOFF.md`, `DEMO_SCRIPT.md`, phase guide reconciled | PASS | Docs swept; stale countdown/10-char/475-533 tokens zero |
| Phase 7 | This report | PASS | §4 |

---

## 3. Method and provenance

- Every number is quoted from live 2026-11-20 output on this machine: HTTP
  responses, PostgreSQL queries, Redis commands, Prometheus queries, PM2/worker
  logs, and the dashboard DOM via a headless browser.
- **Substitutions:** phone SOS → real student login + `POST /alerts`; phone
  confirmation → a real student Socket.IO client; the Resolve UI was exercised
  through the real dialog semantics (3-character minimum).
- **Auth limiter:** the 10-login/15-min/IP key (`rl:auth*`) was cleared several
  times during the day (documented QA intervention — G3 itself proves the
  limiter works; clearing keys is a rehearsal convenience, not a code change).
- **Cross-instance note:** `sos_overrides_total` and `escalations_cancelled_total`
  are per-instance counters (the limiter and `cancelEscalation` live in the API
  processes); the instance that served the request holds the count. Drills
  record which instance held the value.
- **Tooling artefacts (honest):** Alertmanager's `/api/v1/alerts` is a removed
  endpoint (v1 deprecation router) and returns empty — all Alertmanager checks
  here used `/api/v2/alerts`. Grafana's login form ignores injected values;
  authentication was driven with native setter + `input` events.

---

## 4. Drill results

### Block A — Authentication & RBAC (5 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| A1 | Student login 200 + token + user | 200, role `STUDENT` (through :8080) | PASS |
| A2 | Warden login 200 + token + user | 200, role `WARDEN` | PASS |
| A3 | Wrong password → 401 generic | 401 `Invalid credentials` | PASS |
| A4 | Student on warden list → 403 | 403 `requires role WARDEN` | PASS |
| A5 | Warden creating SOS → 403 | 403 `requires role STUDENT` | PASS |

Login requires an explicit uppercase `role`; omitting it returns 400 (verified).

### Block B — Realtime dashboard (6 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| B1 | New SOS renders without refresh, beeps | In-page measurement: POST 201 → card rendered **212 ms** (K6 run 2); dedicated earlier measurement 452–798 ms across runs; exactly **1** beep. Card: `PENDING · No GPS · Aarav Sharma · Room B-314 · MEDICAL · <time>`. **No countdown** — removed by design | PASS |
| B2 | Card shows student, room, type, GPS chip; no fake pill | `Aarav Sharma`, `B-314`, `MEDICAL`, GPS/No-GPS chip; **no escalation pill until the worker reports** | PASS |
| B3 | Acknowledge propagates to student socket | `alert:updated … ACKNOWLEDGED` at the student listener **79 ms** after the warden's PATCH; warden-side ack 48–96 ms across the day's drills | PASS |
| B4 | State survives reload | After reload: session persisted, counts `Active 1 / Resolved 11 / All 12` reproduced, board intact | PASS |
| B5 | Alert raised while the dashboard tab is closed appears on reopen | Page closed → SOS created (`ab60bef1…`) → reopen: card `PENDING · FIRE · 01:19:26 PM` present, `Active` count includes it | PASS |
| B6 | Concurrent double-ack → exactly one winner, one job cancelled | Two simultaneous PATCHes: **200 + 409** `Alert is already ACKNOWLEDGED`; single `acknowledgedAt`/`acknowledgedBy`; **0** Redis keys and **0** queue entries for the alert; **0** send lines | PASS |

### Block C — Map & location (5 PASS, 2 SKIP)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| C1 | GPS alert shows marker, accuracy circle, coordinates | Marker rendered; detail `COORDINATES 12.97190, 77.59480 ±12m`; 1 arc path (accuracy circle) in the overlay pane | PASS |
| C2 | No-GPS alert shows banner, no markers | `Location unavailable — this alert was sent without GPS data`; **0** markers, **0** paths | PASS |
| C3 | No-GPS never plots 0,0 | Detail `COORDINATES / Location unavailable`; `0.00000` absent | PASS |
| C4 | Mobile permission-denied flow | No Android emulator | SKIP |
| C5 | Mobile GPS-timeout flow | No Android emulator | SKIP |
| C6 | Map recenters per selected alert | GPS alert marker at `(247,1674)`; switched to another alert and back → marker returned to exactly `(247,1674)` | PASS |
| C7 | Detail shows conditions + emergency contact | `MEDICAL CONDITIONS Asthma`, `EMERGENCY CONTACT +91 98765 43210` (Aarav); Diya `Penicillin allergy / +91 98765 43211` per seed | PASS |

### Block D — Push notifications (2 PASS, 5 SKIP)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| D1–D4, D6 | Real FCM push legs | FCM unconfigured (`FIREBASE_SERVICE_ACCOUNT_B64` unset, VAPID placeholder); unit-proven only | SKIP |
| D5 | Push blocked → banner, socket still live | Banner `Push notifications are blocked. You will only see alerts while this tab is open. How to enable`; socket path `Live` | PASS |
| D7 | Secure-context prerequisite | `window.isSecureContext === true` on `http://localhost:5173` (localhost is a potentially trustworthy origin) | PASS |

### Block E — Escalation worker (8 PASS, 1 SKIP)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| E1 | Worker starts and logs ready | `[worker] Escalation worker ready` on every (re)start, incl. after the §5 incident repair | PASS |
| E2 | SMS at `ESCALATION_DELAY_MS`; honest outcome reporting | Failure path: created `07:40:24.483` → fired `07:41:24.468` = **60.0 s**, `SMS is not configured`, `escalatedAt` NULL, dashboard toast `⚠️ Escalation SMS failed for Aarav Sharma (Room B-314) at 12:55:49 PM…`, **no pill**. K6 runs: **60.124 s** / **60.218 s**. Success path via mock provider (§4.1.1): `escalatedAt` set at **60.1 s**, receiptId `MOCK-…`, red **SMS SENT** pill | PASS |
| E3 | Ack before delay cancels SMS | `{"scheduled":false,"jobState":null,"firedAt":null}` (`ab8e8629…` and every ack leg of K6/K7); no send line for acked alerts | PASS |
| E4 | Boundary / idempotency | Suite test `cancels the SMS when the alert is acknowledged just before the delay fires` passes (in the 80-test run); ack-after-fire covered by E8 | PASS |
| E5 | Worker restart does not lose a delayed job | Job `escalation-c81c30cc…` created 07:40:24; worker down 07:40:53→07:41:26; fired **07:41:24.468 — instantly on start, 60.0 s after creation**. K6 run 2: created while worker down, fired exactly at the 60 s mark after restart | PASS |
| E6 | Redis down: SOS still 201 in <100 ms | 6× `POST /alerts` through :8080 → **201 in 30–89 ms**; login works (limiter fails open); 6/6 rows persisted in Postgres; `/health` 200 `{"status":"degraded","redis":"down","db":"ok"}` (1.0 s — Redis probe timeout); `/health/ready` **503** (3.0 s) | PASS |
| E7 | Recovery when Redis returns | `docker start` 07:48:09.015 → `health`/`ready` both **200 by the first probe at 07:48:18 (≤9 s incl. container boot)**; post-recovery SOS 201; no API restart | PASS |
| E8 | Ack after SMS fired → no duplicate | Exactly **1** send line per alert; duplicate-check count = 1; ack-after-fire returns 200 and the job's failed state is removed by `cancelEscalation` (counted as a cancellation, per the presenter-trap note) | PASS |
| E9 | Twilio console confirms delivery | No Twilio account/console | SKIP |

#### 4.1.1 Mock-provider success rehearsal (E2 success leg)

Per `docs/DEMO_SETUP.md` §1.2b: `npx pm2 stop worker`; `SMS_PROVIDER=mock` appended to
`backend/.env`; `npm run worker` in a plain terminal (PM2 hardcodes
`NODE_ENV=production`, where the mock is refused by design); raise SOS; wait 60 s.

Evidence: worker log `[sms] MOCK escalation SMS for alert 2c771ba3… (nothing
sent)`, `[worker] escalation delivered … MOCK-2c771ba3… → mock`; DB
`escalatedAt = 07:45:26.448` (60.1 s); dashboard card `FIRE · 01:14:26 PM` with
red pill **`SMS SENT 01:15:26 PM`** rendered from `alert:escalated` + `escalatedAt`.
Reverted afterwards: mock line removed from `.env` (verified: 0 `SMS_PROVIDER`
lines), PM2 worker restarted, drill alert resolved.

### Block F — Multi-instance failure (5 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| F1 | Three instances report distinct ids | `3002 → 3001 → 3003 → 3002 → 3001 → 3003` and `3003 → 3002 → 3001 …` through :8080 (both K6 runs) | PASS |
| F2 | Cross-instance alert events <500 ms | Automated 549 ms (L2); live 15–55 ms across runs (recorded in the phase guide) | PASS |
| F3 | Kill one instance; dashboard reconnects elsewhere | nginx Option A re-verified through the proxy: dashboard stays `Live`, sockets move to the survivor (phase guide Block F, PASS) | PASS |
| F4 | Kill one instance; API traffic fails over | POST through :8080 → 201 via the survivor through proxy + tunnel (phase guide Block F, PASS) | PASS |
| F5 | Restart; health and dashboard recover | `:3001` 200 after restart, siblings 200, LB cycle restored, 5/5 Prometheus targets | PASS |

### Block G — Rate limiting & metrics auth (4 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| G1 | 5 SOS/min allowed | 5× HTTP **201** | PASS |
| G2 | 6th SOS break-glass override | 6th → **201**; `sos_overrides_total` 0→1 on instance **:3002** (the instance that served it — counter is per-instance by design) | PASS |
| G3 | Login limiter blocks the 11th attempt | After clearing rehearsal pollution: attempts 1–10 → **401**, 11th → **429** `retryAfter=900` | PASS |
| G4 | `/metrics` requires token | No/wrong token → **401**; `?token=…` → 200 | PASS |

### Block H — Observability (5 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| H1 | Grafana panels populated | Dashboard `hostel-emergency`: **9 panels** enumerated via the Grafana API (7 query + 2 static text incl. notification-channels copy); live values: BullMQ failed jobs **0**, SOS overrides **1**, `Connected wardens` stat present, HTTP p95 panel shows real per-route data (`/alerts` 48 ms, `/auth/login` 480 ms, `/health` **4.6 s** — the Redis outage visible in the data). **0 “No data”** | PASS |
| H2 | Connected-wardens gauge tracks sockets | `socket_io_connected`: `:3001 = 1` while the dashboard socket lived there, 0 on :3002/:3003; migrates on reconnect (3003 = 1 after the run-2 restart) | PASS |
| H3 | Alert rule fires and reaches Alertmanager | Temporary `DryRunH3H4Drill` rule (`vector(1)`, `for: 0s`) added; Prometheus restart → firing on the first 15 s evaluation; **Alertmanager `/api/v2/alerts`**: `DryRunH3H4Drill`, state `active`, routed to receiver `generic-webhook` | PASS |
| H4 | Alert clears on recovery; config restored | Rule group removed; Prometheus restart → firing list empty; Alertmanager cleared to **(none)** after the 5 m `resolve_timeout`; `monitoring/rules/hostel.yml` restored **byte-identical** (sha256 `2addd161…` before = after) | PASS |
| H5 | All Prometheus targets up | **5/5** `up` — api ×3 (3001/3002/3003) + worker (:4001) + leave-worker (:4002) | PASS |

Webhook delivery itself targets the documented placeholder
(`hostel.docker.internal:5001/alerts` — “DELIBERATELY A STUB” in
`monitoring/alertmanager.yml`); connection-refused retries for it are expected
and visible in the Alertmanager log. The Prometheus → rule → Alertmanager →
routing pipeline is what H3/H4 verify.

### Block I — Log & secret hygiene (4 PASS, 1 N/A)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| I1 | Logs contain no secret values | **0 hits** for token/`Bearer eyJ`/`password123`/`TWILIO_AUTH_TOKEN=`/`FIREBASE_SERVICE_ACCOUNT_B64=` shapes in fresh logs; pino redaction verified (`authorization: [Redacted]`) | PASS |
| I2 | No secrets in git history | gitleaks 8.30.1: staged scan and full history (HEAD `f3fb785`, 11 commits) → **0 findings** (live re-run in Phase 5) | PASS |
| I3 | No tracked secret files | Repo scanner CLEAN; `.env` ignored (`git check-ignore` verified); I3 production-env probe blocked with exit 1 and HEAD unchanged | PASS |
| I4 | Request ID correlates across logs | `X-Request-Id: v3-i4-probe-20261120b` echoed in the response and present as pino `"req":{"id":"v3-i4-probe-20261120b",…}` (probed on `GET /alerts`; `/health` is not request-logged) | PASS |
| I5 | HTTP → HTTPS redirect | **N/A** — `ENABLE_HTTPS_REDIRECT=false`; implementation verified as 308 with `/health`, `/health/ready`, `/metrics` exempt | N/A |

### Block J — Data integrity & indexing (4 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| J1 | Every ACKNOWLEDGED row has ack fields | **0** rows missing `acknowledgedAt`/`acknowledgedBy` | PASS |
| J2 | Every RESOLVED row has `resolvedAt` + note | **0** rows missing either (3–500-char note enforced at the API) | PASS |
| J3 | No orphan device tokens | **0** orphans (query corrected to `DeviceToken.wardenId` — the table has no `studentId`) | PASS |
| J4 | History query uses the composite index where the planner chooses it | Plan A (9 rows): Seq Scan — correct at demo size. Plan B (forced `enable_seqscan=off`): Index Scan. Plan C (**5,009 rows**): 3× `Index Scan using idx_alerts_status_created` + Incremental Sort, `Presorted Key createdAt`, `rows=26` for `LIMIT 25`, execution **1.552–1.576 ms**; seed cleaned back to 9 rows | PASS |

All three plans are quoted in the comment at
`backend/src/routes/alert.routes.ts:481-560`; reproducer `npx tsx scripts/perf-seed.ts`.

### Block K — Demo readiness (7 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| K1 | `demo:reset` produces clean state | `0 active alerts, 3 resolved, 502 students, 5 wardens`; queue flushed; counters zeroed via api+worker+leave-worker restart | PASS |
| K2 | Reset is idempotent | `deleted alerts=3` on the re-run; identical summary | PASS |
| K3 | Reset refuses in production | `NODE_ENV=production` → **REFUSED**, exit 1 | PASS |
| K4 | History filters and pagination | 9 rows / 9 columns; `Diya` → 1; 2030 date range → 0; filter params `status`, `studentName`, `from`, `to`, `page`, `limit` (V1's `statuses=`/`search` params were wrong — corrected) | PASS |
| K5 | CSV export 8 audit columns + notes | 8 columns (`Date/Time,Student,Room,Type,Status,Acknowledged by,Resolved at,Resolution note`); filtered Diya export 263–549 bytes across runs, notes included | PASS |
| K6 | Full demo script, run 1 | All steps performed — §4.1 | PASS |
| K7 | Full demo script, run 2 | All steps performed again after a reset — §4.1 | PASS |

#### 4.1 K6/K7 — what was actually performed, twice (2026-11-20)

| Script step | Run 1 (08:03–08:14 UTC) | Run 2 (08:15–08:21 UTC) |
|---|---|---|
| Pre-flight | Reset clean; cycle `3002→3001→3003…`; 5/5 targets; leave submitted (`621f580b`) | Reset clean; cycle `3002→3001→3003…`; leave submitted (`e40b8ad0`) |
| 0:30 SOS #1 | 201 in 123 ms; card `PENDING · No GPS · Aarav · B-314 · MEDICAL · 01:34:06` | 201 in 687 ms incl. login; **card rendered 212 ms after POST** (in-page measurement); `01:46:09` |
| 1:30 Acknowledge | 200 in **96 ms**; `escalation-status {scheduled:false}`; leave approved → gate pass `HG-1DE463` | 200 in **73 ms**; `{scheduled:false}`; leave approved → gate pass `HG-40E32B` |
| 2:15 escalation fires | **60.124 s** (worker log, PM2 worker, `SMS is not configured`); toast shown; **no pill**; `escalatedAt` NULL → resolved with note | **60.218 s**; same failure path; toast `⚠️ … Diya Patel (Room A-102) at 1:47:32 PM`; no pill → resolved |
| 3:45 history + CSV | Diya → 3 RESOLVED rows (incl. the re-run leg, see §5), note present; CSV 8 cols / 549 bytes | Diya → 2 rows; CSV 8 cols / 401 bytes |
| 3:45 banner | On Resolved tab: `🔔 1 new pending` + View → Active selected, SECURITY card shown | Same: banner + View → Active |
| 4:45 Grafana leg | BullMQ failed **0**; overrides **1**; cancellations 2+1 across :3001/:3003; fired 0; connected 1 (socket on :3003) | Same structure; cycle `3003→3002→3001…` |
| 5:45 multi-instance | Cycle re-verified | Cycle re-verified |
| 6:30 failure drill | **Redis leg:** FIRE SOS 201 in **111 ms** with Redis down; `degraded` 200; `ready` 503; row persisted; recovery ≤9 s | **Worker leg:** worker stopped → SOS created (201 in 47 ms) → worker started → job fired exactly at the 60 s mark; toast; resolved |
| 7:15 close | Reset → `0 active, 3 resolved` | Reset → `0 active, 3 resolved` |

Run 1 alert IDs: `38267d5b…` (SOS1), `481d6b9f…` (SOS2, tainted — see §5),
`e98a0feb…` (SOS2 re-run), `3803b8a7…` (SOS3/banner), `ceeb6433…` (Redis leg).
Run 2: `42390045…`, `c24c85b7…`, `7cd8f071…`, `bdf9dfb8…` (worker leg).

### Block L — Automated tests (2 PASS)

| Drill | Expected | Actual (2026-11-20) | Verdict |
|---|---|---|---|
| L1 | Full suite passes | **9 files passed / 1 skipped; 80 tests passed / 1 skipped** (81 total) in **105.33 s** | PASS |
| L2 | Multi-instance test passes | PM2 `api` stopped, test bound the ports itself: **1 passed**, `delivers alert:new and alert:updated across instances within 500ms` (549 ms test body) in 18.73 s; PM2 `api` restored afterwards, 5/5 online, `/health` 200 | PASS |

---

## 5. Environment incident during K6 run 1 (disclosure)

Mid-run-1 the escalation for SOS #2 (`481d6b9f`) set `escalatedAt` at 60.1 s —
which should have been impossible with Twilio unconfigured. Root cause: the
mock-provider rehearsal (§4.1.1) was launched as `npm run worker` in a
terminal, and stopping that task killed the `npm` wrapper but **left the tsx
child process orphaned**, still holding port 4001 with `SMS_PROVIDER=mock` in
its environment. The PM2 worker then crash-looped on `EADDRINUSE ::: 4001`
(276→301 restarts) while the orphan consumed the queue. Everything the system
did in that window was internally consistent — job fired at 60.1 s, receipt
recorded, pill rendered — the worker simply wasn't the one we thought was
running.

**Detection:** the run-1 2:15 leg produced a success pill where the scripted
failure path was expected. **Repair:** orphan PID identified via
`netstat -ano | grep :4001` and killed; PM2 worker bound 4001 on its next
restart (`Escalation worker ready`); tainted alert acknowledged, resolved with
an explanatory note, and the leg re-run cleanly (`e98a0feb…`, 60.124 s,
failure path, toast, no pill). **Lesson recorded for demo ops:** after any
terminal-run worker rehearsal, confirm port 4001's owner before restarting the
PM2 worker; `npx pm2 list` alone is not sufficient evidence.

No application defect was found; the idempotency guard, scheduler, queue and
metrics behaved as designed on both the orphan and the PM2 worker.

---

## 6. V1/V2 findings — closure status (unchanged, re-verified 2026-11-20)

| Finding | Status | 2026-11-20 evidence |
|---|---|---|
| C-1 / E6: SOS hangs when Redis is down | FIXED, re-verified | 6× 201 in 30–89 ms, rows persisted, `degraded`/503 honest |
| C-2 / K6, K7: script cannot be performed | FIXED, re-verified | Two full runs, all steps, evidence §4.1 |
| N-1 / F3, N-2 / F4: no failover | FIXED, re-verified | nginx Option A; phase-guide Block F PASS |
| N-3 / H1: “No data” panels | FIXED, re-verified | 9/9 populated, `or vector(0)` |
| N-4 / J4: false index claim | FIXED, re-verified | 3 plans measured, comment at :481-560 |
| N-5: Resolved filter hid a new SOS | FIXED, re-verified | Banner `🔔 1 new pending` ×3, View returns to Active |
| N-6: client-side “SMS sent” pill | FIXED, re-verified | Pill only from `escalatedAt`/`alert:escalated`; failure = toast, no pill; mock rehearsal proves the success rendering |
| N-7: metrics not reset; gauge misuse | FIXED, re-verified | `demo:reset` restarts all three counter-holding processes |
| N-8: request-id mismatch | PASS with note | I4 re-verified through nginx |
| N-9 / L2 precondition | PASS | PM2 stopped for L2, restored after |

---

## 7. Safety guarantees — current honesty level

| # | Guarantee | Status | Evidence |
|---|---|---|---|
| 1 | Acknowledged alert never fires SMS | PASS | E3/E4/E8/B6; `cancelEscalation` before the DB update in both ack and resolve handlers |
| 2 | Worker restart doesn't lose a pending escalation | PASS | E5 ×2 (instant-on-start delivery; exactly-at-60s delivery) |
| 3 | Redis outage doesn't break SOS delivery | PASS (scoped) | 201 in 30–89 ms, rows persisted, health honest. Cross-instance fan-out and escalation pause; live card not guaranteed until recovery |
| 4 | Student never blocked from SOS by rate limiting | PASS | G2 break-glass 201; limiter fails open on Redis errors (E6 login during outage) |
| 5 | Cross-instance broadcast <500 ms (Redis healthy) | PASS | L2 549 ms test body with <500 ms assertion on the events; live 15–55 ms |
| 6 | Stale FCM token deleted on next send | PASS (unit) | Mock-proven; no real device |
| 7 | No secret in git history or logs | PASS | gitleaks 0/0; scanner CLEAN; redaction verified live |

Guarantees #3 and #5 cannot both be absolute during a Redis outage — the
script and this report say so explicitly and never claim “realtime everywhere”.

---

## 8. Skips (8), N/A (1), residual risks

### Skips — no skip hides a code failure

| Drill | Reason |
|---|---|
| C4, C5 | No Android emulator/device |
| D1–D4, D6 | FCM unconfigured |
| E9 | No Twilio console (E2's success leg is now covered by the mock rehearsal; only provider-console confirmation remains) |
| I5 | N/A — HTTPS redirect disabled by configuration; 308 implementation verified with health/metrics exemptions |

### Residual risks and ops notes

1. **Acknowledging a failed job removes it** from `bullmq_jobs{state="failed"}` (counted as a cancellation) — show Grafana between the failure and the ack, or read the worker log. Documented presenter trap.
2. **Terminal-run worker rehearsals can orphan** the process and hold :4001 (see §5). Verify the port owner afterwards.
3. **Per-instance counters:** `sos_overrides_total` / `escalations_cancelled_total` live on the API instance that served the request; read all three instances (or Prometheus `sum`) for totals.
4. **nginx is part of the topology** — without it F3/F4 revert. The Cloudflare tunnel publishes :8080 only; never point it at a single API port.
5. **L2 requires PM2 `api` stopped** so the test can bind 3001/3002.
6. **Two Redis/Postgres container sets exist** (`backend-*` vs `hostel-*`); the demo uses `backend-postgres-1` / `backend-redis-1`.
7. **Alertmanager checks must use `/api/v2/alerts`** — v1 is a removed endpoint.
8. **Git:** remediation changes are uncommitted pending owner authorization; `stash@{0}` and branch `phase1-wip-backup` predate this work and were left untouched. HEAD remains `f3fb785`.

---

## 9. Evidence index and restoration record

| What | Where |
|---|---|
| This report | `docs/DRY_RUN_REPORT_V2.md` |
| V1 historical report (unchanged) | `docs/DRY_RUN_REPORT.md` |
| Phase-by-phase evidence and completion guide | `docs/PHASE7_PROGRESS_AND_COMPLETION_GUIDE.md` |
| Setup that is not code | `docs/DEMO_SETUP.md` |
| Presenter runbook | `docs/DEMO_SCRIPT.md` |
| J4 plans | `backend/src/routes/alert.routes.ts:481-560`, `backend/scripts/perf-seed.ts` |
| Opt-in index test | `backend/tests/index.test.ts` (`RUN_INDEX_TEST=true`) |
| Multi-instance test | `backend/tests/multi-instance.test.ts` (PM2 `api` stopped) |
| Mock SMS provider | `backend/src/services/sms.service.ts:141-148` (refused under `NODE_ENV=production`) |
| nginx / tunnel | `backend/nginx.conf`, `docs/TUNNEL_SETUP.md` |
| Alert rules / Alertmanager | `backend/monitoring/rules/hostel.yml` (sha256 `2addd161…`, byte-identical after H3/H4), `backend/monitoring/alertmanager.yml` |
| Secret scanning | `.gitleaks.toml`, `.husky/pre-commit`, `backend/scripts/secret-scan-check.cjs` |

**Restoration verified 2026-11-20 (after all drills, final check):**

- PM2: **5/5 online** (api ×3 cluster + worker fork + leave-worker fork).
- nginx :8080 healthy `{"status":"ok","instanceId":"3003","redis":"ok","db":"ok"}`;
  round-robin cycle re-verified twice.
- Postgres `backend-postgres-1`: **0 PENDING / 3 RESOLVED**, 502 students, 5 wardens.
- Redis `backend-redis-1` up; escalation queue delayed/waiting **0**, no residual
  drill job keys.
- Prometheus **5/5 targets up**; firing alerts **(none)**; Alertmanager
  `/api/v2/alerts` **(none)**.
- Worker log: ready line after final restart; no crash-loop entries since the
  §5 repair.
- `backend/.env`: **no** `SMS_PROVIDER` line (mock rehearsal fully reverted);
  tunnel URL remains out of git (`.env`-only).
- Grafana dashboards provisioned; panel 1 `max(bullmq_jobs{state="failed"})` = 0.
- `npm test`: 80 passed / 1 skipped. Multi-instance: 1 passed (PM2 restored).
- Git: HEAD `f3fb785`, working tree carries the Phase 1–6 changes uncommitted
  (awaiting explicit commit authorization); gitleaks 0 findings over history.

---

## 10. Final statement

The system is **GO for the scripted demo** on this topology. Every V1 failure
is fixed and was re-exercised on 2026-11-20, the full 66-drill set passes with
zero failures, and the demo script was performed end-to-end twice with measured
evidence — including both escalation outcomes (honest failure with Twilio
unconfigured, and the mock-rehearsed success pill). The only claims that must
not be made on stage are the ones marked SKIP: real Twilio delivery
(console-confirmation), real FCM push on a device, Android permission dialogs,
and “realtime everywhere” during a Redis outage.
