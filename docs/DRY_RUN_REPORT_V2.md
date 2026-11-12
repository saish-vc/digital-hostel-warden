# HostelGuard — Dry-Run Report V2 (Post-Fix)

**Drills executed:** 2026-11-10 (live, this machine)
**Recorded evidence retained for unchanged drills:** 2026-11-09 (`docs/PHASE7_PROGRESS_AND_COMPLETION_GUIDE.md`)
**Environment restored and re-verified:** 2026-11-12
**Baseline:** `docs/DRY_RUN_REPORT.md` (V1, 2026-11-08 — preserved unchanged)
**Scope:** the full 66-drill set (A1–L2) against the post-fix code, the nginx
front door, the React dashboard, the BullMQ worker, and the monitoring stack.

---

## 1. Verdict

> ## **GO for the demo as scripted** — 56 PASS / 0 FAIL / 9 SKIP / 1 N/A.

Every V1 FAIL is fixed and re-verified. Every V1 PASS still passes. The nine
SKIPs need an external account, device or deployment target that this
environment does not have; none hides a code failure. The one N/A (I5) is
disabled by configuration by design.

| | V1 (2026-11-08) | V2 (2026-11-10/12) |
|---|---|---|
| PASS | 47 | **56** |
| FAIL | 7 | **0** |
| SKIP | 11 | **9** |
| N/A | 1 | **1** |
| Total | 66 | 66 |
| Verdict | **NO-GO** | **GO** |

**Why the PASS count rises by 9, not 7:** the seven V1 FAILs (E6, F3, F4, H1,
J4, K6, K7) now pass, and I2/I3 moved from SKIP to PASS because the tree is now
a git repository with a working secret scan. **Why SKIP falls to 9:** I2/I3 are
no longer skipped. The arithmetic is exactly 47 + 7 + 2 = 56, and
11 − 2 = 9.

The V1 report's non-critical findings N-1…N-9 are all addressed or explicitly
scoped in §6–§8.

---

## 2. Method and provenance

- Every number below is quoted from live output on this machine: HTTP
  responses, PostgreSQL queries, Redis commands, Prometheus queries, worker
  logs, files, and the dashboard DOM.
- **Substitutions, unchanged from V1:** phone SOS → real student login +
  `POST /alerts`; phone confirmation → a real student Socket.IO client; the
  Resolve UI is now real and was clicked, not simulated.
- **Provenance is marked per drill.** Drills that the fixes could not affect
  (E5, H3, H4) retain their 2026-11-09 evidence and are labelled
  `recorded 11-09`. Everything nginx-, dashboard-, metrics- or
  Redis-path-affected was re-run on 2026-11-10. The final clean state was
  re-verified on 2026-11-12 after a host restart.
- **Tooling artefacts:** PowerShell mangles inline JSON. Three probes that
  used `--data-binary '{\"…\"}'` returned app-level 400
  `Unterminated string in JSON` and were discarded; the same requests were
  re-run with a Node `fetch` client and are the results reported here. No
  application code was involved.
- **Auth limiter:** the 10-login/15-min/IP key was cleared twice during
  rehearsal (after G3 and before the UI drills). G3 itself proves the limiter
  works; clearing keys is a rehearsal convenience, not a code change.
- **One dashboard query was fixed during verification** (traceable to V1
  finding **N-7**, not to a PASS): panel 1 used `increase()` over a gauge, so
  acknowledging a failed job produced a phantom **3.53** on a 0/1 gauge. It is
  now `max(bullmq_jobs{state="failed"})` (current count) in both dashboards.
  See §5.

---

## 3. Environment

| Component | State |
|---|---|
| PM2 | `api` ×3 cluster (:3001/:3002/:3003) + `worker` ×1 fork (:4001) |
| nginx | 1.31.8, **:8080**, round-robin upstream, `worker_processes 2`, `daemon off` |
| Postgres | Docker `backend-postgres-1`, DB `hostel_emergency` |
| Redis | Docker `backend-redis-1`, DB 0 app / DB 1 tests |
| Prometheus | :9090, **4/4 targets up** (api ×3 + worker) |
| Alertmanager | :9093, no active alerts |
| Grafana | :3000, default + configured dashboards provisioned without BOM errors |
| Dashboard | Vite :5173, `VITE_API_URL="http://localhost:8080"`, `Live` |
| Twilio | not configured |
| FCM | not configured |
| Android emulator | not installed |

`ESCALATION_DELAY_MS=60000`; `ENABLE_HTTPS_REDIRECT=false`;
`INTERNAL_API_URL=http://localhost:3001`.

---

## 4. Drill results

### Block A — Authentication & RBAC (5 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| A1 | Student login 200 + token + user | 200; `Aarav Sharma`, role `STUDENT`, JWT length **209** | PASS | — |
| A2 | Warden login 200 + token + user | 200; `Priya Nair`, role `WARDEN`, JWT length **208** | PASS | — |
| A3 | Wrong password → 401 generic | 401 `{"error":"Invalid credentials"}` | PASS | — |
| A4 | Student on warden list → 403 | 403 `{"error":"Forbidden: requires role WARDEN"}` | PASS | — |
| A5 | Warden creating SOS → 403 | 403 `{"error":"Forbidden: requires role STUDENT"}` | PASS | — |

### Block B — Realtime dashboard (6 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| B1 | New SOS renders without refresh and beeps | Card rendered in **193 ms** (run 1) / **274 ms** (run 2), **1 oscillator** created in each run, countdown `⏱ 60s` | PASS | — |
| B2 | Card shows student, room, type, time | `Aarav Sharma`, `Room B-314`, `MEDICAL · 11:25:42 PM`; GPS chip + countdown | PASS | — |
| B3 | Acknowledge propagates to student socket | `alert:updated … ACKNOWLEDGED` **212 ms** after click (run 1), **261 ms** (run 2) | PASS | — |
| B4 | Acknowledged state survives reload | After reload: `ACKNOWLEDGED`, `Acknowledged at 11:17:40 PM`, `RESPONDING 1`, Resolve button present | PASS | — |
| B5 | Alert created while dashboard closed is visible on reopen | Created while the page was on `about:blank`; on reopen the newest card was `PENDING … SECURITY · 11:19:03 PM` | PASS | — |
| B6 | One PATCH, no error, one job cancelled | Exactly one `PATCH /alerts/:id/acknowledge` → **200**; Redis job `EXISTS` → **0**; DB row `ACKNOWLEDGED` with `acknowledgedAt`/`acknowledgedBy`; no error banner | PASS | — |

### Block C — Map & location (5 PASS, 2 SKIP)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| C1 | GPS alert shows marker, accuracy circle, coordinates | 1 marker (`.leaflet-marker-icon`, red dot with halo) + 1 accuracy path; detail `12.97190, 77.59480±12m` | PASS | — |
| C2 | No-GPS alert shows banner and no markers | Banner: `Location unavailable — this alert was sent without GPS data`; **0** markers, **0** vector paths | PASS | — |
| C3 | No-GPS alert never plots 0,0 | Detail `COORDINATES / Location unavailable`; `0.00000, 0.00000` absent | PASS | — |
| C4 | Mobile permission-denied flow | No Android emulator; OS dialog cannot be exercised | SKIP | — |
| C5 | Mobile GPS-timeout flow | No Android emulator | SKIP | — |
| C6 | Map recenters per selected alert | GPS A marker at `(441,196)`; GPS B at `(1825,1951)`; reselecting B returned exactly `(1825,1951)` | PASS | — |
| C7 | Detail shows conditions + emergency contact | `Asthma`, `+91 98765 43210` (Aarav); `Penicillin allergy`, `+91 98765 43211` (Diya) | PASS | — |

### Block D — Push notifications (2 PASS, 5 SKIP)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| D1 | Foreground push → toast + beep | FCM unconfigured | SKIP | — |
| D2 | Background push → OS notification | FCM unconfigured | SKIP | — |
| D3 | Notification click → deep link | No notification exists | SKIP | — |
| D4 | Stale token removed | No device registration possible; unit-proven only | SKIP | — |
| D5 | Push blocked → banner, socket still live | `Push notifications are blocked…`, `How to enable`, realtime `Live` | PASS | — |
| D6 | FCM metrics increment | No FCM metrics emitted | SKIP | — |
| D7 | Secure-context prerequisite | `window.isSecureContext === true` on `http://localhost:5173` | PASS | — |

### Block E — Escalation worker (7 PASS, 2 SKIP)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| E1 | Worker starts and logs ready | `[worker] Escalation worker ready` at 23:22:02 and 23:30:16 | PASS | — |
| E2 | SMS at `ESCALATION_DELAY_MS` | Scheduler: DB `17:56:23.887` → fire `17:57:24.022` = **60.135 s** (run 1); `18:01:17.308` → `18:02:17.441` = **60.133 s** (run 2). Delivery leg unverifiable (Twilio unconfigured) | SKIP (delivery leg) | — |
| E3 | Ack before delay cancels SMS | After ack: `{"scheduled":false,"jobState":null,"firedAt":null}`; Redis job `EXISTS` → **0**; no send line for the alert | PASS | — |
| E4 | Ack near the boundary / idempotency | Boundary test in the suite passes: `cancels the SMS when the alert is acknowledged just before the delay fires` (1.478 s); recorded boundary evidence: 10.108 s fired correctly, retry acked at 9.604 s with no send | PASS | — |
| E5 | Worker restart does not reset a delayed job | **recorded 11-09:** job survived a 9.1 s worker outage and fired **60.091 s** after creation; second run fired 3.3 s after restart | PASS | unchanged |
| E6 | Redis down: SOS still 201 in <100 ms | 6× `POST /alerts` through :8080 → **201 in 44.7–73.3 ms** (API side); 6 rows persisted; `/health` 200 `{"status":"degraded","redis":"down","db":"ok"}`; `/health/ready` 503; browser round trip 150/211 ms | PASS | **FIXED** |
| E7 | Recovery when Redis returns | `redis:"ok"` after **2.4 s** (drill), **3.2 s** (run 1), **2.5 s** (run 2); post-recovery POST **201 in 49.9 ms**; no API restart | PASS | — |
| E8 | Ack after SMS fired → no duplicate | Exactly **1** `unacknowledged — sending escalation SMS` line for each acked-after-failure alert (`4c2187e0…`, `f305a428…`) | PASS | — |
| E9 | Twilio console confirms delivery | No Twilio account/console | SKIP | — |

E6 scope is discussed in §7, guarantee #3. The failed sends are honest:
`SMS is not configured: set TWILIO_ACCOUNT_SID, …`.

### Block F — Multi-instance failure (5 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| F1 | Three instances report distinct ids | `3002 → 3001 → 3003 → 3002 → 3001 → 3003` via :8080 | PASS | — |
| F2 | Cross-instance alert events <500 ms | Warden sockets on :3001 and :3002 both received the same `alert:new` at **55 ms**; Phase 2 probe: 4–8 ms | PASS | — |
| F3 | Kill one instance; dashboard reconnects elsewhere | Stopped PM2 ids 3 (3003, owner of the dashboard sockets) and 0 (3001): dashboard stayed **`Live`**; both dashboard sockets moved `3003=2 → 3002=2` | PASS | **FIXED** (nginx) |
| F4 | Kill one instance; API traffic fails over | With two APIs down: 3× `POST /alerts` through :8080 → **201 in 2.07–2.12 s** (proxy retry to dead upstreams), LB `/health` 200 `instanceId=3002` | PASS | **FIXED** (nginx) |
| F5 | Restart; health and dashboard recover | All three direct `/health` 200; LB cycle returned; 4/4 Prometheus targets `up`; dashboard `Live` | PASS | — |

### Block G — Rate limiting & metrics auth (4 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| G1 | 5 SOS/min allowed | 5× HTTP **201** | PASS | — |
| G2 | 6th SOS gets break-glass override, not 429 | 6th → **201**; `sos_overrides_total` **0 → 1** (instance 3002); `sos_rate_limit_overridden` logged at 23:04:00 | PASS | — |
| G3 | Login limiter blocks the 11th attempt | Attempts 1–10 → **401**; 11th → **429** `{"error":"rate_limited","retryAfter":900}` | PASS | — |
| G4 | `/metrics` requires token | No token → **401**; `?token=…` → **200** | PASS | — |

### Block H — Observability (5 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| H1 | Grafana panels all populated | Default dashboard **9/9 panels** (6 query panels, 2 static text), configured variant **10/10**; every query returned ≥1 series → **0 “No data”**. Panel 1 now `max(bullmq_jobs{state="failed"})` = **0** clean / **1** with a failed job. | PASS | **FIXED** |
| H2 | Connected-wardens gauge tracks sockets | `socket_io_connected`: `3003=2` before → `3003=3` during → `3003=2` after; other instances 0 | PASS | — |
| H3 | `EscalationFailuresHigh` fires | **recorded 11-09:** temporary `[1m]`/`for: 30s` rule fired at **t+72 s**; Alertmanager showed **2 active**; rule restored | PASS | unchanged |
| H4 | Alert clears on recovery | **recorded 11-09:** inactive/cleared at **t+24 s**; Alertmanager empty | PASS | unchanged |
| H5 | All Prometheus targets up | **4/4** `up` (api 3001/3002/3003 + worker 4001) | PASS | — |

H1 provenance: panel enumeration and series checks were executed live against
the running Grafana/Prometheus on 2026-11-10 and re-checked on 2026-11-12 after
the panel query fix. The two static text panels are populated by design (they
carry the “not configured” copy), not empty.

### Block I — Log & secret hygiene (4 PASS, 1 N/A)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| I1 | Logs contain no secret values | Fresh logs show `"authorization":"[redacted]"`; **0 hits** for the metrics token, `password123`, `Bearer eyJ`, `TWILIO_AUTH_TOKEN=`, `FIREBASE_SERVICE_ACCOUNT_B64=` | PASS | — |
| I2 | No secrets in git history | `gitleaks git --staged` → `no leaks found` (0 commits); full history at drill time → **2 commits, 1.30 MB, no leaks** | PASS | **SKIP → PASS** |
| I3 | No tracked secret files / `.env` ignored | Repo scanner `CLEAN — 0 hits` over 65 files; **211** tracked files; no `.env`, `.pem` or service-account file tracked; `git check-ignore` confirms `backend/.gitignore:5` ignores `backend/.env` | PASS | **SKIP → PASS** |
| I4 | Request ID correlates a request across logs | Sent `X-Request-Id: v2-i4-probe-1794333041930`; response echoed it; the pino line carried `"req":{"id":"v2-i4-probe-1794333041930",…}` | PASS | — |
| I5 | HTTP → HTTPS redirect | `ENABLE_HTTPS_REDIRECT=false`; when enabled it returns 308, `/health` and `/metrics` exempt | N/A | — |

**I1 caveat (honest):** the pre-flush log file contained four 2026-11-08 lines
with the dev metrics token in the `x-internal-token` header. `pm2 flush`
cleared them; all lines written after the redaction fix are clean. This is a
historical artefact, not a current leak.

### Block J — Data integrity & indexing (4 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| J1 | Every ACKNOWLEDGED row has ack fields | **0** rows missing `acknowledgedAt`/`acknowledgedBy` | PASS | — |
| J2 | Every RESOLVED row has `resolvedAt` + note | **0** rows missing either | PASS | — |
| J3 | No orphan device tokens | **0** orphans | PASS | — |
| J4 | History query uses the composite index where the planner chooses it | 9 rows → **Seq Scan** (correct at demo size); forced `enable_seqscan=off` → `idx_alerts_student`; **5,009 rows → 3× `Index Scan using idx_alerts_status_created`**, execution **1.662 ms**; seed cleaned back to 9 rows | PASS | **FIXED** |

The comment at `backend/src/routes/alert.routes.ts:475-533` now quotes all three
plans and the forced-plan caveat.

### Block K — Demo readiness (7 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| K1 | `demo:reset` produces clean demo state | `deleted alerts=26`; queue obliterated; `0 active alerts, 3 resolved, 502 students, 5 wardens`; counters zeroed | PASS | — |
| K2 | Reset is idempotent | Second run: `deleted alerts=3`; identical summary; queue empty | PASS | — |
| K3 | Reset refuses in production | `NODE_ENV=production` → **REFUSED**, exit code **1** | PASS | — |
| K4 | History filters and pagination | **3 rows, 8 columns**; `Diya` + `RESOLVED` → **1 row**; `PENDING` → empty-state row; date range excludes all → empty-state; Previous/Next disabled with 3 rows | PASS | — |
| K5 | CSV export has 8 audit columns and notes | Unfiltered: **3 rows, 8 columns**, notes present; filtered `Diya`: **1 row**, 8 columns, note present (263 bytes) | PASS | — |
| K6 | Full demo script, run 1 | All steps performed; see §4.1 | **PASS** | **FIXED** |
| K7 | Full demo script, run 2 | All steps performed again after a reset; see §4.1 | **PASS** | **FIXED** |

#### 4.1 K6/K7 — what was actually performed, twice

| Script step | Run 1 (2026-11-10 23:25–23:28) | Run 2 (23:30–23:34) |
|---|---|---|
| 0:00 empty board | `ACTIVE 0 / RESPONDING 0 / RESOLVED TODAY 2`, 0 cards, `Live` | Same after reset; 0 cards, `Live` |
| 0:30 SOS appears, beeps | **193 ms**; `PENDING · GPS · Aarav Sharma · B-314 · MEDICAL · 11:25:42`, `⏱ 60s`, **1 oscillator** | **274 ms**; same fields, **1 oscillator** |
| 1:30 Acknowledge | `alert:updated ACKNOWLEDGED` **212 ms**; `{"scheduled":false,…}` | **261 ms**; `{"scheduled":false,…}` |
| 2:15 escalation fires | DB `17:56:23.887` → worker `17:57:24.022` = **60.135 s**; pill `⚠️ ESCALATION FAILED`; `SMS is not configured` | `18:01:17.308` → `18:02:17.441` = **60.133 s**; same failure |
| 2:15 resolve with note | Dialog: 5 chars → disabled + “5 more characters required”; 58 chars → enabled; toast `Case resolved`; card `RESOLVED`, note + `Resolved at 11:27:59 PM` | Same: disabled at 5, enabled at 57, toast, note + `Resolved at 11:32:41 PM` |
| 3:45 history + CSV | 3 rows / 8 columns; `Diya` → 1; CSV 3 rows, filtered 1 row | Re-checked; same |
| 3:45 Resolved-tab banner | Banner `🔔 1 new pending alert` **195 ms**; `View` returned to Active and showed the card; alarm beeped | Banner **246 ms**; `View` returned to Active |
| 4:45 Grafana | Panel 1 **0**; overrides **0**; pipeline `RESOLVED=4 / ACKNOWLEDGED=1 / PENDING=1`; fired 0; connected 2 | Panel 1 **0** after ack; same structure; targets 4/4 |
| 5:45 multi-instance | `3002 → 3001 → 3003 …`; cross-instance 55 ms (F2) | `3002 → 3003 → 3001 …` |
| 6:30 Redis down | 201 in **150 ms** browser (API-side 44.7–73.3 ms); `degraded`; `ready` 503; recovery **3.2 s** | 201 in **211 ms** browser; `degraded`; `ready` 503; recovery **2.5 s** |
| 7:15 close | No functional step | No functional step |

Run 1 alert IDs: `1601fb7e…` (SOS1), `4c2187e0…` (SOS2), `cf45f9a8…` (SOS3),
`e4821404…` (Redis-down SOS4). Run 2: `fe603a7b…`, `f305a428…`, `70fe59de…`,
`19c03596…`.

### Block L — Automated tests (2 PASS)

| Drill | Expected | Actual | Verdict | Delta from V1 |
|---|---|---|---|---|
| L1 | Full suite passes (9 files / 74 tests) | **9 files passed / 1 skipped; 74 tests passed / 1 skipped** in **131.64 s** | PASS | — |
| L2 | Multi-instance test passes | PM2 stopped; **1 test passed** in **7.19 s**, including `delivers alert:new and alert:updated across instances within 500ms` (570 ms test body) | PASS | — |

---

## 5. Changes made during this verification

Only one code/config change was made, and it is traceable to V1 finding **N-7**
(“`increase()` on a gauge is wrong”). No PASS code was touched.

| Change | Why | Verification |
|---|---|---|
| `monitoring/grafana/dashboards/hostel.json` and `hostel-configured.json`: panel 1 `sum(increase(bullmq_jobs{state="failed"}[$__rate_interval]))` → `max(bullmq_jobs{state="failed"})`; legend `failed escalations (current)` | Run 2 acked the failed job and the old query showed a phantom **3.53** on a gauge that had gone 1 → 0. `sum()` also triples the DB-wide value because all three APIs export it; `max` is the same rule already used for `alerts_by_status`. | Grafana API returns the new expression; live value **1** with one failed job and **0** after cleanup; 9/9 and 10/10 panels populated; no BOM (`123,10,32`) |

Documentation corrections made from measured output (not code):

- `docs/DEMO_SCRIPT.md`: Redis-down SOS **11–15 ms → 44.7–73.3 ms API side**
  (150–211 ms browser); recovery **~35 s → 2.4–3.2 s**; scheduler
  **60.06–60.07 s → 60.135/60.133 s**; F2 **15/17 ms → 15–55 ms across runs**.
- `HANDOFF.md`: the same numbers, the final count **56/0/9/1**, and a new known
  trap for the failed-jobs gauge.

---

## 6. V1 findings — closure

| V1 item | Status | Evidence |
|---|---|---|
| C-1 / E6: SOS hangs when Redis is down | **FIXED** | 6× 201 in 44.7–73.3 ms, rows persisted, health `degraded` |
| C-2 / K6, K7: script cannot be performed | **FIXED** | Two full runs, every step performed |
| N-1 / F3: no reconnection | **FIXED** | Dashboard `Live` with two APIs stopped |
| N-2 / F4: no REST failover | **FIXED** | 3× 201 through :8080 with two APIs down |
| N-3 / H1: “No data” panels | **FIXED** | 9/9 and 10/10 populated |
| N-4 / J4: false index claim | **FIXED** | Comment + 5,009-row plan |
| N-5: Resolved filter hid a new SOS | **FIXED** | Banner at 195/246 ms, View returns to Active |
| N-6: client-side “SMS sent” pill | **FIXED** | Pill is worker-receipt driven; failure shown honestly |
| N-7: metrics not reset; gauge misuse | **FIXED** | `demo:reset` restarts processes; panel 1 now a current gauge |
| N-8: request-id mismatch | **PASS with note** | Through nginx the client header becomes pino `req.id`; a direct-to-app request may still differ (documented) |
| N-9 / L2 precondition | **PASS** | PM2 stopped before the test, restored after |

---

## 7. Safety guarantees — current honesty level

| # | Guarantee | Status | Evidence / scope |
|---|---|---|---|
| 1 | Acknowledged alert never fires SMS | PASS | Ack removed the job (`EXISTS 0`, `scheduled:false`); no send line after ack (E3/E4/E8) |
| 2 | Worker restart doesn't lose a pending escalation | PASS | **recorded 11-09:** job survived a 9.1 s outage and fired 60.091 s after creation |
| 3 | Redis outage doesn't break SOS delivery | **PASS (scoped)** | 201 in 44.7–73.3 ms, 6/6 rows persisted, health `degraded`. **Scope:** cross-instance fan-out pauses (77 s late in V1, arriving after Redis returned) and escalation pauses; FCM never measured. Never say “realtime everywhere”. |
| 4 | Student never blocked from SOS by rate limiting | PASS | 6th SOS → 201; overrides 0→1; fail-open on Redis errors (G2/E6) |
| 5 | Cross-instance broadcast <500 ms (Redis healthy) | PASS | 55 ms live; 4–8 ms Phase 2 probe; automated test asserts <500 ms |
| 6 | Stale FCM token deleted on next send | PASS (unit) | Mock-proven; no real device (D1–D4/D6 SKIP) |
| 7 | No secret in git history or logs | PASS | Gitleaks 0 staged / 0 history; scanner CLEAN; fresh logs redacted |

Guarantees #3 and #5 cannot both be absolute during a Redis outage. The script
and this report say so explicitly.

---

## 8. Skips, N/A, and residual risks

### Skips (9) and N/A (1)

| Drill | Reason |
|---|---|
| C4, C5 | No Android emulator/device; OS permission and GPS-timeout dialogs cannot run |
| D1, D2, D3, D4, D6 | FCM unconfigured (`FIREBASE_SERVICE_ACCOUNT_B64` unset, VAPID is a test key) |
| E2 (delivery leg) | Twilio unconfigured; scheduler timing is measured, delivery is not |
| E9 | No Twilio console |
| I5 | **N/A:** HTTPS redirect disabled; implementation is 308, health/metrics exempt |

No skip hides a code failure. Every one requires an external account, device or
deployment target; `docs/DEMO_SETUP.md` is the checklist.

### Residual risks (none blocking)

1. **H3/H4 and E5 rely on 2026-11-09 evidence.** They are unaffected by the
   fixes (rule timing, worker restart) but were not re-run on 2026-11-10.
2. **Acknowledging a failed job removes it**, so the failure disappears from
   panel 1. The script documents this and offers showing Grafana between the
   failure and the ack.
3. **nginx is part of the topology.** If it is not running, F3/F4 revert to
   V1 failures. Start it with `-g "daemon off;"` in a kept-open terminal.
4. **L2 requires PM2 stopped** so the test can bind 3001/3002.
5. **Redis-down fan-out is not realtime.** The alert is persisted and appears
   on refresh/recovery; escalation resumes on recovery.
6. **Two Redis/Postgres container sets exist** (`backend-*` vs `hostel-*`).
   The demo uses `backend-postgres-1` / `backend-redis-1`.
7. **`npx gitleaks` failed to resolve on this host**; the installed
   `gitleaks` 8.30.1 binary was used. The pre-commit hook is a shell scanner
   and is unaffected.

---

## 9. Evidence index and restoration

| What | Where |
|---|---|
| This report | `docs/DRY_RUN_REPORT_V2.md` |
| V1 historical report (unchanged) | `docs/DRY_RUN_REPORT.md` |
| Prior-phase evidence and guide | `docs/PHASE7_PROGRESS_AND_COMPLETION_GUIDE.md` |
| Setup that is not code | `docs/DEMO_SETUP.md` |
| Presenter runbook | `docs/DEMO_SCRIPT.md` |
| J4 plans | `backend/src/routes/alert.routes.ts:475-533`, `backend/explain.sql`, `backend/scripts/perf-seed.ts` |
| Opt-in index test | `backend/tests/index.test.ts` (`RUN_INDEX_TEST=true npm test -- tests/index.test.ts`) |
| Multi-instance test | `backend/tests/multi-instance.test.ts` (PM2 stopped) |
| nginx config | `backend/nginx.conf` |
| Secret scan | `.gitleaks.toml`, `.husky/pre-commit`, `backend/scripts/secret-scan-check.cjs` |
| Dashboards | `backend/monitoring/grafana/dashboards/hostel.json`, `hostel-configured.json` |

**Restoration verified 2026-11-12:** PM2 api ×3 + worker online; nginx on :8080
cycling 3001/3002/3003; Postgres/Redis/Prometheus/Alertmanager/Grafana up;
Prometheus 4/4 targets; DB **3 RESOLVED / 0 active**, 502 students, 5 wardens;
queue delayed/failed **0/0**; panel 1 expression `max(bullmq_jobs{state="failed"})`;
dashboard `Live` with an empty board.

---

## 10. Final statement

The system is **GO for the scripted demo** on this topology. The two critical
V1 defects — the Redis-down SOS hang and the unperformable demo script — are
fixed and were exercised twice end-to-end. The security, data-integrity,
rate-limit and observability claims that remain are either measured here or
explicitly labelled as environment-limited skips. The only claims that must not
be made on stage are the ones this report marks SKIP: SMS delivery, real FCM
push, Android permission dialogs, and “realtime everywhere” during a Redis
outage.
