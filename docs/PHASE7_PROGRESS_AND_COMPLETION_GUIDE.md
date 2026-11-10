# HostelGuard Remediation — Phase 7 Progress Report & Completion Guide

**Written:** 2026-11-09, after the Phase 7 re-run of all 66 drills.
**Purpose:** (1) report what has been done and verified so far, and
(2) provide a copy-paste prompt that completes the one remaining task —
writing `docs/DRY_RUN_REPORT_V2.md` — using the evidence collected below.
**Do not re-run any drill.** All numbers below were measured live on this
machine; raw logs are in `C:\Users\saish\AppData\Local\Temp\v2-*.log` /
`v2-*.cjs` / `v2-*.json` / `v2-h1-*.png`.

---

## 1. What has been completed

| Phase | Status | Output |
|---|---|---|
| 0–4 | COMPLETE | Reported at each stop point; Phase 4 Option B (F3/F4 = production-only, no nginx). |
| 5 | COMPLETE | `docs/DEMO_SETUP.md` checklist written and verified. |
| 6 | COMPLETE | False claims removed from `progress.md`, `docs/AUDIT.md`, `docs/DEMO_SCRIPT.md`, `docs/LOAD_TEST_RESULTS.md`; line citations re-pinned. |
| 7 | **All 66 drills re-run** | **52 PASS / 0 FAIL / 11 SKIP / 1 N/A / 2 DEFERRED**. Only the V2 report file itself remains. |

All 7 V1 FAILs are resolved: **E6, H1, J4, K6, K7 → FIXED**; **F3/F4 → DEFERRED**
(production-only per the user's Option B decision). All 4 new findings are FIXED
and verified (see §3).

---

## 2. Phase 7 drill results (actual outputs, condensed)

Legend for "Delta from V1": **FIXED** (was FAIL, now passes) · **DEFERRED** ·
**—** (unchanged; re-verified). V1 reference: `docs/DRY_RUN_REPORT.md`
(2026-11-08, NO-GO: 47/7/11/1).

### Block A — Auth & RBAC (5 PASS)
| Drill | Actual (re-verified) | Verdict | Delta |
|---|---|---|---|
| A1 | Student login 200 + JWT + role STUDENT | PASS | — |
| A2 | Warden login 200 + JWT + role WARDEN | PASS | — |
| A3 | Wrong password → 401 `Invalid credentials` | PASS | — |
| A4 | Student on warden list → 403 | PASS | — |
| A5 | Warden creating SOS → 403 | PASS | — |

### Block B — Realtime dashboard (6 PASS)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| B1 | Card rendered **32 ms** after POST, **exactly 1** oscillator (beep), GPS chip, `⏱ 60s` (K6: 31 ms, K7: 33 ms) | PASS | — |
| B2 | `Aarav Sharma · Room B-314 · FIRE · time` + countdown | PASS | — |
| B3 | Acknowledge click → student socket `alert:updated ACKNOWLEDGED` in **38 ms** (K6) / **22 ms** (K7) | PASS | — |
| B4 | ACKNOWLEDGED + acknowledged-at line survive reload | PASS | — |
| B5 | Tab navigated off the app (React unmounted, socket closed), `SECURITY` alert created via API (Ishaan Gupta, B-104, 02:20:51 PM), tab returned → card visible, **no manual refresh**, `Live`. (Built-in browser refuses `about:blank`, so the tab was parked on `http://localhost:3001/health` — same unmount effect.) | PASS | — |
| B6 | One PATCH per ack, one job cancelled, no error banner | PASS | — |

### Block C — Map & location (5 PASS / 2 SKIP)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| C1 | 1 marker + accuracy circle (radius 21 px @ z18 = **12 m**) + `12.97190, 77.59480 ±12m` | PASS | — |
| C2 | No-GPS alert: "Location unavailable" banner, 0 markers | PASS | — |
| C3 | No `0.00000, 0.00000`, no circle | PASS | — |
| C4 | No Android emulator | SKIP | — |
| C5 | No Android emulator | SKIP | — |
| C6 | Vihaan pin → tiles `18/187574/121544`, circle 21 px; Ananya pin (12.9850/77.6100, acc 25) → tiles `18/187585/121534`, circle **43 px** (=25 m); back to Vihaan → identical tiles; **Recenter map** → zoom 16, circle 5 px; re-select flies back to zoom 18. Circle radius is metric-scaled (÷4 per 2 zoom levels). | PASS | — |
| C7 | Detail pane: `MEDICAL CONDITIONS: Asthma`, `EMERGENCY CONTACT: +91 98765 43210` | PASS | — |

### Block D — Push notifications (2 PASS / 5 SKIP)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| D1–D4, D6 | FCM unconfigured (`FIREBASE_SERVICE_ACCOUNT_B64` unset, VAPID placeholder) | SKIP | — |
| D5 | `Push: blocked` + "How to enable" banner while socket stays `Live` | PASS | — |
| D7 | `isSecureContext === true` on `http://localhost:5173` | PASS | — |

### Block E — Escalation (7 PASS / 2 SKIP)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| E1 | `[worker] Escalation worker ready` | PASS | — |
| E2 | Scheduler fired at **60.077 s / 60.068 s** (K6/K7: 60.1 s). Delivery leg unverifiable — Twilio unset, worker logs `SMS is not configured` | SKIP (scheduler verified) | — |
| E3 | Ack before delay → job removed, no send attempt | PASS | — |
| E4 | Boundary ack → no send | PASS | — |
| E5 | Job survived a 9.1 s worker outage and fired **60.091 s** after creation; K7 drill: queued job past its due time fired **3.3 s** after worker restart | PASS | — |
| E6 | **Redis stopped**: 6 × `POST /alerts` → **HTTP 201 in 11–14 ms** (V1: HTTP 000 after 5 s); K6 repeat: 201 in 15 ms; `/health` 200 `degraded` (`redis:"down"`, `db:"ok"`), `/health/ready` 503, rows persisted | PASS | **FIXED** |
| E7 | Recovered in **~35 s** with no API restart (K6 repeat: `redis:"ok"`, ready 200, PM2 uptimes predate the outage) | PASS | — |
| E8 | Ack after fire → 0 duplicates | PASS | — |
| E9 | No Twilio console | SKIP | — |

### Block F — Multi-instance (3 PASS / 2 DEFERRED)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| F1 | `instanceId` 3001/3002/3003 distinct, all `ok` | PASS | — |
| F2 | Cross-instance `alert:new` on 3001+3002 in **15/17 ms** | PASS | — |
| F3 | No load balancer — reframed **PRODUCTION DEPLOYMENT ONLY** (user decision: Phase 4 Option B) | DEFERRED | **DEFERRED** |
| F4 | Same root cause as F3 | DEFERRED | **DEFERRED** |
| F5 | `pm2 restart 0` → :3001 `/health` 200 in **~3.9 s**; siblings 200 throughout; dashboard back to `Live`, 29 cards intact | PASS | — |

### Block G — Rate limiting & metrics auth (4 PASS)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| G1 | 5 × 201 | PASS | — |
| G2 | 6th SOS → 201, `sos_overrides_total` 0→1, `sos_rate_limit_overridden` logged | PASS | — |
| G3 | Attempts 1–10 → 401, attempt 11 → **429 `Retry-After: 900`** | PASS | — |
| G4 | `/metrics` without token → 401 | PASS | — |

### Block H — Observability (5 PASS)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| H1 | Default dashboard (`hostel-emergency`): **9 panels, 0 in a "No data" state**; the only "No data" string on the page is inside the static **Notification channels** text panel (`SMS: not configured (Twilio trial) \| FCM: not configured (Web Push)`). Configured variant (`hostel-emergency-configured`): **10 panels, 0 "No data"**; SMS sends = `attempts 0 / delivered 0`, FCM = `attempts 0 / stale tokens 0` via `or vector(0)`. Screenshots: `Temp\v2-h1-default.png`, `Temp\v2-h1-configured.png` | PASS | **FIXED** |
| H2 | `socket_io_connected` 1→0 read on the port whose socket changed | PASS | — |
| H3 | Temp rule `[1m]`/`for: 30s`: **pending t+97 s → firing t+127 s** (Alertmanager 3 active) | PASS | — |
| H4 | **Cleared t+142 s**, Alertmanager 0; committed rule restored byte-identical (`[5m]`, `for: 600s`, inactive) | PASS | — |
| H5 | 4/4 targets up (api ×3 + worker) | PASS | — |

### Block I — Log & secret hygiene (2 PASS / 2 SKIP / 1 N/A)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| I1 | `authorization:"[redacted]"`, `x-internal-token:"[redacted]"`; 0 secret hits | PASS | — |
| I2 | Not a git repository | SKIP | — |
| I3 | Not a git repository | SKIP | — |
| I4 | PASS with note: `X-Request-Id` found in exactly one log line on `GET /alerts`, but pino's `req.id` differs (proxy-only correlation; `/health` is not request-logged) | PASS (note) | — |
| I5 | `ENABLE_HTTPS_REDIRECT=false`; implementation returns **308** and exempts `/health`, `/metrics` | N/A | — |

### Block J — Data integrity & indexing (4 PASS)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| J1 | 0 ACKNOWLEDGED rows missing ack fields | PASS | — |
| J2 | 0 RESOLVED rows missing `resolvedAt`/note | PASS | — |
| J3 | 0 orphan device tokens | PASS | — |
| J4 | Real `EXPLAIN (ANALYZE)` on the true UNION query: **A** (23 rows) Seq Scan + Sort, 1.600 ms — correct at demo size; **B** forced `enable_seqscan=off` → Index Scan on `idx_alerts_status_created`, 1.729 ms; **C** (5,023 rows) planner picks the index unforced — Incremental Sort with `Presorted Key: createdAt`, reads **26 rows to serve LIMIT 25**, 1.918 ms. `scripts/perf-seed.ts` cleaned up after itself (30→30 rows). Comment at `backend/src/routes/alert.routes.ts:475-533` matches all three. | PASS | **FIXED** |

### Block K — Demo readiness (7 PASS)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| K1 | `demo:reset`: `0 active alerts, 3 resolved, 502 students, 5 wardens`; queue flushed | PASS | — |
| K2 | Second consecutive reset: `deleted alerts=3`, identical summary | PASS | — |
| K3 | Refuses `NODE_ENV=production`, exit 1 | PASS | — |
| K4 | History: 8 columns; Resolved + today + `Diya` → **1 row** with the resolution note | PASS | — |
| K5 | CSV: 8 columns + note, filter-aware (1 row) | PASS | — |
| K6 | **Full script run 1 — every step performed as written**: 0:00 empty board ("No active alerts"); 0:30 card 31 ms + 1 beep; 1:30 ack, student socket 38 ms, `scheduled:false`; 2:15 fire at **60.1 s**, pill `⏱` → `Escalation pending…` → **`⚠️ ESCALATION FAILED`** (never "SMS sent"), resolve with 53-char note → RESOLVED + toast + student `RESOLVED` in 25 ms; 3:45 history 1 row / CSV / Resolved-tab banner `🔔 1 new pending alert` + View; 4:45 `bullmq_jobs{state="failed"}=0`, overrides 0, fired 0; 5:45 3 instanceIds + 4/4 targets; 6:30 Redis-down: 201 in 15 ms, degraded/503, recovery without API restart; 7:15 reset | PASS | **FIXED** |
| K7 | **Full script run 2** — same steps: 0:30 33 ms; 1:30 22 ms; 2:15 60.1 s, honest FAILED pill, resolve → student 19 ms; 3:45 1 row + CSV + banner + View; 4:45 all 0s; 5:45 3 ids; 6:30 worker-down: SOS 201 in 30 ms while worker stopped, job stayed `delayed` in Redis **past its due time**, fired **3.3 s after worker restart**; 7:15 reset | PASS | **FIXED** |

### Block L — Automated tests (2 PASS)
| Drill | Actual | Verdict | Delta |
|---|---|---|---|
| L1 | 9 files + 1 skipped, 74 tests + 1 skipped, 35.89 s, exit 0 | PASS | — |
| L2 | PM2 stopped (ports 3001/3002 verified free), `npm test -- tests/multi-instance.test.ts` → **1 test passed, 2.018 s** (duration 4.98 s), including <500 ms cross-instance assertions | PASS | — |

### Tally vs V1
| | V1 (2026-11-08) | V2 (this re-run) |
|---|---|---|
| PASS | 47 | **52** |
| FAIL | 7 | **0** |
| SKIP | 11 | 11 |
| N/A | 1 | 1 |
| DEFERRED | — | 2 (F3, F4) |
| Total | 66 | 66 |

---

## 3. The 4 new findings — all FIXED and verified

| # | Finding | Fix | Verified by |
|---|---|---|---|
| 1 | No Resolve UI | Resolve button (ACKNOWLEDGED only) + dialog: submit disabled until **trimmed** note ≥10 chars (9→disabled, 10→"Minimum met", 13 raw/7 trimmed→"3 more characters required"); PENDING → 409; double-resolve idempotent | K6/K7 resolve steps + isolated drill |
| 2 | Resolved filter hides new PENDING | Red banner `🔔 1 new pending alert` + View + ✕ on any non-Active tab; alarm still beeps | K6/K7 3:45 + isolated drill |
| 3 | Grafana metrics not reset on `demo:reset` | Reset restarts api+worker via PM2 (counters live in the process) | All counters read **0** on :3001/:3002/:3003/:4001 after reset; Grafana queries 0 |
| 4 | "SMS sent" pill lies when the worker fails | Server-driven pill: worker → `POST /internal/escalation-result` → `alert:escalation-failed` → pill shows `⚠️ ESCALATION FAILED` | E2/K6/K7: failed at 60.1 s; pill never said "SMS sent" |

---

## 4. GO acceptance checklist (brief Phase 7) — all met

- ✅ E6 PASS (<200 ms with Redis down): 11–14 ms ×6, K6 15 ms.
- ✅ Resolve flow PASS end-to-end from the dashboard.
- ✅ Resolved filter does not hide new PENDING (banner).
- ✅ SMS pill does not claim "SMS sent" on worker failure.
- ✅ J4 claim matches reality (three measured plans, comment updated).
- ✅ H1 panels show 0 / static text (both variants, screenshots).
- ✅ Grafana metrics reset on `demo:reset` (0 on every instance).
- ✅ F3/F4 reframed and removed from the demo script (marked PRODUCTION DEPLOYMENT ONLY; "Do not kill an API instance on stage").
- ✅ All originally-PASS drills still PASS (52 PASS includes all 47).

**Verdict: GO for the demo as scripted** in this environment, subject to the
environment-limited SKIPs and the guarantee #3 scope note below.

---

## 5. Guarantee #3 deviation — must be surfaced in the V2 report

The brief asked for: *"SOS delivery (alert creation + socket broadcast + FCM push)
still succeeds in <200ms."* Only the creation leg is evidenced
(`progress.md` §4, "Scope note on guarantee #3"):

- **Alert creation:** 201 in 11–151 ms with Redis down. Measured. ✅
- **Socket broadcast:** same-instance wardens ~16 ms; **different-instance wardens 77.159 s late** (Redis pub/sub *is* the cross-instance transport — guarantees #3 and #5 cannot both hold during an outage).
- **FCM push:** never measured (Firebase unconfigured; API logs "FCM messaging not initialized — skipping push").

The V2 report must quote this deviation, not the brief's parenthetical.
Stage-safe wording lives in `progress.md` §4.

---

## 6. Restoration record (verified after the last drill)

- `ESCALATION_DELAY_MS=60000`, `INTERNAL_API_URL=http://localhost:3001` (unchanged).
- Alert rule restored **byte-identical** (`diff` clean) to `rate(...[5m]) > 0.1 for 10m`; Prometheus reloaded, rule `inactive`, health ok; Alertmanager clear of EscalationFailuresHigh.
- PM2: `api` ×3 cluster + `worker` fork all online after L2; `/health` `{"status":"ok","redis":"ok","db":"ok"}` on 3001/3002/3003; Prometheus 4/4 targets up.
- DB: 3 rows (the seeded resolved demo rows); every drill alert removed by `demo:reset`.
- `rl:auth*` keys cleared after G3 and twice mid-drill when rehearsal logins tripped the auth limiter (documented QA intervention — the limiter is working as designed).
- Vite on :5173; dashboard left on the Active tab.
- No `.env` edits; `DIRECT_DATABASE_URL` was supplied inline for one `prisma` command only.

---

## 7. What remains incomplete

1. **Write `docs/DRY_RUN_REPORT_V2.md`** (the last step of task #12). All source data is in §2–§6 of this file — no re-running needed.
2. **Deliver the consolidated Phase 5/6/7 report** to the user (Phases 5–7 have no stop points; a single final report with verification tables suffices). It must include the suggested-follow-ups section (below).

---

## 8. Completion prompt (copy-paste into a fresh session)

> You are continuing the HostelGuard remediation in
> `C:\Users\saish\OneDrive\Documents\Default Project`. The environment is fully
> restored and all 66 Phase 7 drills have been run. Do NOT re-run drills and do
> NOT change any code or config. Your only job is to write
> `docs/DRY_RUN_REPORT_V2.md` and then report completion.
>
> First read `docs/PHASE7_PROGRESS_AND_COMPLETION_GUIDE.md` — it contains every
> measured result (per-drill tables, actual outputs, deltas) and the restoration
> record. Read `docs/DRY_RUN_REPORT.md` (V1) for the report structure to mirror.
>
> Write `docs/DRY_RUN_REPORT_V2.md` with:
> 1. Header: date 2026-11-09, scope, method constraints (same honesty rules as V1:
>    mismatches recorded as FAIL, temporary changes restored).
> 2. Summary: PASS 52 / FAIL 0 / SKIP 11 / N/A 1 / DEFERRED 2 = 66, with the
>    V1→V2 comparison table. Verdict: **GO for the demo as scripted**, subject to
>    the environment-limited SKIPs and the guarantee #3 scope note.
> 3. The same per-block drill tables as V1 (Drill | Expected | Actual | Verdict)
>    plus a **"Delta from V1"** column using the tokens FIXED / DEFERRED / — .
>    Copy the actual outputs from the guide's §2 verbatim — they are the
>    verification evidence (the brief requires actual output, not "should work").
> 4. A "Critical failures resolved" section: E6, K6/K7 (with the V1 failure
>    detail vs the V2 measured result), H1, J4; F3/F4 DEFERRED with the user's
>    Phase 4 Option B decision cited.
> 5. A "New findings" section: the 4 findings, all FIXED, with their
>    verification pointers (guide §3).
> 6. A "Guarantee #3 deviation" section quoting the scope note from
>    `progress.md` §4 verbatim (guide §5).
> 7. Skips/N-A: same list as V1 (C4/C5, D1–D4/D6, E2 delivery leg, E9, I2/I3,
>    I5 N/A) with the same reasons; state "No skip hides a code failure."
> 8. A "Restoration" section from the guide §6.
> 9. A **"Suggested follow-ups"** section (do NOT implement):
>    - `alerts_by_status`, `socket_io_connected` and similar gauges are summed
>      across the 3 instances by Grafana queries — they triple-count (e.g.
>      PENDING 87 / RESOLVED 15 for 3 DB rows; "Connected wardens" counts student
>      sockets too). Consider per-instance series or max/avg aggregations.
>    - `cancelEscalation()` removes an already-failed job and counts it as
>      cancelled, so the Grafana failure evidence disappears on ack (the demo
>      trap documented in DEMO_SCRIPT.md 2:15).
>    - `startQueueMetrics` runs an unbounded `getJobCounts()` await every 15 s
>      with no overlap guard — add one.
>    - Auth limiter (10/15 min/IP) tripped repeatedly during QA rehearsal logins;
>      consider an env-flag exemption or keying by email+IP for demo machines
>      (G3 asserts the current behavior — do not weaken it without re-running G3).
>    - I4: make response `X-Request-Id` match pino `req.id` for direct requests
>      (set the header inside `requestId()` before pino reads it) or keep the
>      documented proxy-only limitation.
> 10. End with the same "Green light verdict" style as V1 §7 but GO, listing
>     what is solid and the remaining caveats (Twilio/FCM/emulator/git/nginx
>     unconfigured; cross-instance fan-out pauses during a Redis outage).
>
> Then report completion to the user with the stop-point table format
> ("PHASE X COMPLETE. Verification results: [table]. ... Blockers: none.") for
> the consolidated Phases 5/6/7, and prominently flag the guarantee #3 deviation
> from the brief's prescribed wording.

---

## 9. Evidence file index (raw logs, this machine)

`C:\Users\saish\AppData\Local\Temp\`:
`v2-e2-run.log`, `v2-e5-run.log`, `v2-h3h4.log`, `v2-k7-worker.log`, `v2-j4.log`,
`v2-l1.log`, `v2-h1-default.png`, `v2-h1-configured.png`, harnesses `v2-*.cjs`,
evidence JSON `v2-*.json`. Project docs already updated this session:
`docs/DEMO_SCRIPT.md`, `docs/AUDIT.md`, `docs/LOAD_TEST_RESULTS.md`,
`docs/DEMO_SETUP.md`, `progress.md`.
