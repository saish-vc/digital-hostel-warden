# Demo script — Hostel Emergency Monitoring System

**Format:** presenter runbook, ~7 minutes of stage time. Hard stop at 8.
The numbered steps and the quoted *"Say:"* lines are the stage copy. The
blockquoted notes, drill IDs and measured numbers are **rehearsal reference** —
read them before you present, then print or scroll only the stage copy.
(The old "one A4 sheet, double-sided" target is no longer realistic: the dry run
found four steps that could not be performed as written, and the corrections plus
their evidence do not fit on two pages.)

> **Rewritten 2026-11-09 after the 2026-11-08 dry run
> (`docs/DRY_RUN_REPORT.md`) and updated 2026-11-10 after the fixes.**
> Every step below carries the drill ID that verifies it. Steps that need
> Twilio or FCM are marked **PRODUCTION DEPLOYMENT ONLY** and are *not*
> performed on stage — those integrations are unconfigured in this
> environment. Set them up with `docs/DEMO_SETUP.md` first if you want them
> live. nginx **is** running here; it is part of the demo topology.
>
> **Environment this script assumes:** PM2 `api` ×3 (3001/3002/3003) + `worker`
> ×1; nginx 1.31.8 on **:8080** fronting those three instances; containers
> `backend-postgres-1` and `backend-redis-1`; Prometheus :9090, Grafana :3000,
> Alertmanager :9093; dashboard on :5173 pinned to
> `VITE_API_URL=http://localhost:8080`; `ESCALATION_DELAY_MS=60000`;
> `INTERNAL_API_URL=http://localhost:3001` (the worker's result relay — without
> it the escalation pill cannot report the truth).
>
> **Why the proxy matters:** the dashboard and the app talk to :8080. nginx
> round-robins REST requests and pins each WebSocket to one instance at connect
> time, so no sticky session is needed. If an API instance dies, the proxy
> ejects it and the dashboard reconnects elsewhere (drills F3/F4).

---

## Pre-flight (10 minutes before, not on stage)

**Order matters.** `demo:reset` ends by restarting `api` and `worker` through
PM2 — that restart is what zeroes the Prometheus counters. If PM2 is not up
yet, the reset prints a warning and the counters keep their old values.

```bash
cd backend
npm run test:db:up                        # backend-postgres-1 + backend-redis-1
docker compose -f docker-compose.monitoring.yml up -d
npx pm2 start ecosystem.config.js         # api ×3 + worker ×1  ← BEFORE the reset

# front door — keep this terminal open (daemon mode dies with the shell here)
$prefix = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'nginxinc*' | Select-Object -First 1).FullName + '\nginx-1.31.8'
nginx -p $prefix -c "$PWD\nginx.conf" -g "daemon off;"

npm run demo:reset                        # 0 active, 3 resolved, queue flushed, counters zeroed
cd ../warden-dashboard && npm run dev     # :5173
```

`demo:reset` refuses to run when `NODE_ENV=production` (drill **K3**). Run it
from your own shell, not from inside a PM2 env. Expected tail:
`0 active alerts, 3 resolved, …` and
`[demo-reset] restarted api + worker — Prometheus counters zeroed`.

- [ ] `curl -s localhost:8080/health` → `{"status":"ok","instanceId":"30xx",...}` (**F1**)
- [ ] Repeat six times; the `instanceId` cycles 3001 → 3002 → 3003. That is
      nginx round-robin, not PM2 sharing. (**F1**, **F4**)
- [ ] Prometheus `:9090/targets` → **4/4 up** (api ×3 + worker). (**H5**)
      If one API target is down, check for another container publishing that
      port — `docker ps --format '{{.Names}} {{.Ports}}'`. A shadowing
      container makes Prometheus scrape the wrong process and every panel lies.
- [ ] Grafana `:3000` → dashboard **Hostel Emergency** (uid `hostel-emergency`,
      the *unconfigured* variant). Panel 1 reads **0**, not "No data". (**H1**)
- [ ] **Click the "Active" tab.** The filter persists in `localStorage`, so a
      previous session's "Resolved" tab survives the reset and hides the board.
      This bit us in dry-run **K6**.
- [ ] Warden logged in, "Enable alarm" clicked once (unlocks audio).
- [ ] Student client logged in as `aarav@hostel.local / password123`.
- [ ] Location ON; browser notifications allowed. Push itself is off, so the
      dashboard shows its push-disabled banner and the socket path stays
      `Live` (**D5**).

**Credentials:** warden `warden@hostel.local / password123`; students
`aarav@hostel.local`, `diya@hostel.local` / `password123`.
Login requires an explicit uppercase `role` (`STUDENT` / `WARDEN`); omitting it
returns 400.

**No phone?** The dry run substituted a real student JWT + `POST /alerts` and a
student Socket.IO listener for the Flutter app. That exercises the same server
path. It is a substitution, not a device test — **C4/C5** remain SKIP until an
Android emulator exists (`docs/DEMO_SETUP.md` §3).

> **PRODUCTION DEPLOYMENT ONLY — FCM web push.** No step in this script depends
> on a push notification arriving. `FIREBASE_SERVICE_ACCOUNT_B64` is unset and
> the dashboard's VAPID key is a placeholder, so the API logs
> `[push] FCM messaging not initialized — skipping push for this alert` and
> drills **D1/D2/D3/D4/D6** are SKIP. The socket path is what you demonstrate,
> and the dashboard says out loud that push is unavailable (**D5** observed
> `Push: blocked` with a "How to enable" banner while the socket stayed `Live`).
> Configure Firebase via `docs/DEMO_SETUP.md` §2 to make this leg live.

---

## 0:00 — Framing (30s)

> "A student alone in a hostel at 2am presses one button. This system gets a
> warden to them, and if nobody responds in 60 seconds it escalates by SMS —
> with a dashboard, an audit trail, and metrics that prove it worked."

Show the empty board: **"No active alerts"**, **Live** indicator green.
(**K6/K7**, after the Active-tab pre-flight step.)

---

## 0:30 — Student raises SOS (60s)

1. Raise the SOS (phone, or `POST /alerts` with a student JWT).
2. Switch to the dashboard: the card appears **without a refresh** (socket,
   `alert:new` → `wardens` room), scrolls into view, flashes, the alarm beeps.
   Measured **452–798 ms** card render, exactly **1** beep. (**B1**, **K6/K7**)
3. Say: *"The phone also tried GPS. If GPS is denied or slow it still sends —
   location is optional, the alert is not."* Point at the **GPS / No GPS** chip.
   (**C1/C2/C3**)
4. Point at the **Active / Responding / Resolved today** counters — each is a
   clickable shortcut into the tab that owns the number.

**Expected:** card with student name, room, type, and an amber `⏱ Ns` countdown.
(**B2**)

---

## 1:30 — Warden acknowledges (45s)

1. Click **Acknowledge**. Status → **ACKNOWLEDGED**; the card moves to
   Responding. Measured **65–202 ms**. (**B3**, **K6/K7**)
2. The student client flips to "Warden acknowledged" — *the same `alert:updated`
   socket event, no polling*. Measured **116 ms** after the click. (**B3**)
3. Say: *"The 60-second SMS was cancelled the moment this was acknowledged."*
   Two independent layers enforce that: the delayed BullMQ job is removed, and
   the worker re-reads the status and bails unless it is still `PENDING`.
   (**E3**, **E4**, **B6**)
4. Optional: `GET /alerts/:id/escalation-status` → `scheduled: false`. (**K6/K7**)

---

## 2:15 — Escalation fires, then the case is closed (90s) — the centrepiece

1. Raise a **second** SOS from `diya@hostel.local`.
2. **Do not acknowledge.** Let the countdown run out. The scheduler is accurate
   to ~70 ms: measured fire at **60.06–60.07 s**. (**E2**, **K6/K7**)
3. Watch the pill and narrate what it actually proves:
   - `⏱ Ns` while the window runs,
   - `Escalation pending…` once it elapses and the worker has not reported yet,
   - then the worker's own verdict, relayed over
     `POST /internal/escalation-result` → `alert:escalated` /
     `alert:escalation-failed`.
4. **In this environment the pill lands on red "⚠️ Escalation failed".** That is
   the correct, honest outcome: Twilio is unconfigured, so the worker's send
   throws `SMS is not configured` and the worker reports the failure. Say:

   > *"Nobody answered, so the system tried to page the on-call warden. The
   > attempt failed because the SMS credentials aren't provisioned in this
   > environment — and notice the dashboard tells you that. It does not claim
   > 'SMS sent'. The old version did, on a 60-second timer, whether or not the
   > worker succeeded. The pill is now driven by the worker's receipt."*

   `escalations_fired_total` stays **0** because it counts *delivered*
   escalations; the failure is recorded on the BullMQ job and drives
   `EscalationFailuresHigh`. (**H3**)

   > **PRODUCTION DEPLOYMENT ONLY — the SMS delivery leg.** With Twilio
   > configured (`docs/DEMO_SETUP.md` §1) this same step ends in a red **"SMS
   > sent"** pill, `escalations_fired_total` increments, and the on-call phone
   > rings. Do not claim that here. Drills **E2** (delivery leg) and **E9** are
   > SKIP until the credentials exist.
5. **Acknowledge** the alert, then click **Resolve**. A note dialog opens.
   Type a resolution note — **Submit resolution** stays disabled until the
   trimmed note is **10 characters** (max 500), and the counter tells you how
   many more are required. Submit. (**new finding #1**, `tests/demo.test.ts`)
6. The card shows **RESOLVED**, the note and `Resolved at` appear in the detail
   pane, a success toast confirms, and the student client receives
   `alert:updated` with `RESOLVED` → **"Case closed"**. (**new finding #1**)
7. Say: *"Resolve is a real state transition, not a delete. PENDING cannot be
   resolved — the API returns 409 — and resolving twice is idempotent. The note
   is the audit trail."* (`PATCH /alerts/:id/resolve`, **J2**)

> **Presenter trap — do not promise the failed job will still be on the Grafana
> panel at 4:45.** Acknowledging in step 5 calls `cancelEscalation()`, which
> removes the job by id whatever state it is in — including `failed` — and
> counts it as a cancellation. So the failure you just demonstrated disappears
> from `bullmq_jobs{state="failed"}`. If you want it on screen, show Grafana
> **between steps 4 and 5**, or read the worker log
> (`npx pm2 logs worker --lines 50`) instead. This is a known limitation, listed
> in the remediation's suggested follow-ups; it is not fixed in this pass.

---

## 3:45 — Audit trail, and the tab that cannot hide an emergency (60s)

1. Header → **History**. Filter **Resolved**, set a date range, search `Diya`
   → 1 row. 8 columns, resolution note included. (**K4**)
2. Click **Export CSV** — the download is filter-aware and carries the same 8
   audit columns plus the notes. (**K5**)
3. **Do not make the index-scan claim.** At demo row counts Postgres correctly
   chooses a **Seq Scan + Sort**: reading a two-page table is cheaper than an
   index descent. Say instead:

   > *"The history query is shaped for `idx_alerts_status_created` — status
   > equality plus a `created_at DESC` walk with a LIMIT. At this row count the
   > planner prefers a sequential scan, which is the right call. We proved the
   > index serves the query two ways: forcing `enable_seqscan = off` produces an
   > Index Scan, and at 5,000 rows the planner picks it unforced."*

   The measured `EXPLAIN (ANALYZE)` output for all three cases is quoted in
   `backend/src/routes/alert.routes.ts:475-533`. Reproduce **off stage** with
   `npx tsx scripts/perf-seed.ts` (it deletes what it seeds) or
   `RUN_INDEX_TEST=true npm test -- tests/index.test.ts`. (**J4** — the old
   script's "it is an index scan, not a table scan" was **false** and is removed.)
4. Back on the board, click the **Resolved** tab, then raise a **third** SOS.
   That tab cannot show a PENDING row, so a red banner appears:
   **"🔔 1 new pending alert"** with a **View** button (jumps to Active and
   clears the count) and a **✕** dismiss. The alarm still beeps. Say:

   > *"A warden parked on the Resolved tab used to be able to miss a live
   > emergency — the counter moved but the card was filtered out. Now the
   > banner interrupts whatever tab you are on."*

   (**new finding #2**, dry-run observation **N-5**.) Click **View** to return.

---

## 4:45 — Observability (60s)

Grafana, dashboard **Hostel Emergency** (uid `hostel-emergency`), in this order:

1. **⛔ BullMQ failed jobs — THE safety-guarantee panel** (top-left). On a clean
   board it reads **0**. Say: *"This is the most important series in the system.
   If it rises, the 60-second promise is broken."* (**H1**)
   Remember the trap above: the 2:15 failure was removed when you acknowledged
   it, so 0 here is expected, not evidence that nothing failed.
2. **🚪 SOS break-glass overrides (total)** — 0 unless a student exceeded 5 SOS
   in 60s, in which case the request was *allowed through* and counted here.
   (**G2**)
3. **SOS rate (last 5m)**, **Alert pipeline (PENDING / ACKNOWLEDGED /
   RESOLVED)**, **Escalations fired vs cancelled**, **Connected wardens**,
   **HTTP p95 latency by route**. (**H2**)
4. **Notification channels** — a *static text* panel reading
   `SMS: not configured (Twilio trial) | FCM: not configured (Web Push)`.
   Say: *"Those two channels are deliberately not provisioned here, so the
   dashboard says so in words instead of showing an empty graph you'd have to
   explain."* The second provisioned dashboard, **Hostel Emergency (SMS + FCM
   configured)** (uid `hostel-emergency-configured`), swaps that text panel for
   live SMS/FCM stat panels using `or vector(0)`. Load it only after
   `docs/DEMO_SETUP.md` §1–2 are done. (**H1** — the V1 "No data" panels are fixed.)
5. Prometheus `:9090/targets` → `up{job="api"}` = 3, `up{job="worker"}` = 1. (**H5**)
6. Alertmanager `:9093` → the **EscalationFailuresHigh** rule and the webhook
   stub. The committed rule is `rate(...[5m]) > 0.1` **for 10m**, so a single
   failed job during a 7-minute demo will not sustain long enough to fire.
   Drills **H3/H4** verified firing and clearing with a temporary shortened
   rule, which was restored afterwards.

> **Counters reset with the demo.** prom-client counters live in the process,
> not the database, so `demo:reset` restarts `api` and `worker` as its last step.
> If a panel shows a large stale number, the reset ran before PM2 was up — run
> it again. (**new finding #3**, observation **N-7**.)

---

## 5:45 — Multi-instance proof (45s)

1. `for i in 1 2 3 4 5 6; do curl -s localhost:8080/health; done` → the
   `instanceId` cycles through `3001`, `3002`, `3003`. (**F1**)
2. Say: *"Sockets are WebSocket-only, so no sticky sessions are needed. nginx
   pins each socket to one instance; the Redis adapter broadcasts alert events
   across all three — measured at 15/17 ms, and the automated test asserts
   under 500 ms."* (**F2**, **L2**)
3. Say: *"The proxy also removes a dead instance. We tested stopping two of the
   three API processes: the dashboard stayed Live, its sockets reconnected to
   the survivor, and a POST through :8080 still returned 201."* (**F3**, **F4**)

**Failover is a rehearsed optional step, not part of the 7-minute run.** If you
want to show it:

```bash
# map PM2 ids to instances once, before the demo
npx pm2 list
npx pm2 stop <id1> <id2>     # leave one api + worker running
curl -s localhost:8080/health            # 200, survivor's instanceId
# dashboard: Live; sockets move to the survivor (socket_io_connected)
npx pm2 start <id1> <id2>                # restore; LB distribution returns
```

Do not stop the **worker** in this step — that is the separate E5 drill. If you
are short on time, skip the failover demo entirely; the dashboard going
`Reconnecting` on stage is normal Socket.IO behaviour, but it costs seconds you
may not have.

---

## 6:30 — Failure drill (45s, pick ONE)

### Redis down — escalation degrades, SOS survives (**E6**, **E7**)

```bash
docker stop backend-redis-1        # the container the dry run used — see the note below
# raise SOS  -> HTTP 201 in ~11-15 ms, row persisted in Postgres
curl -s localhost:8080/health      # 200 {"status":"degraded","redis":"down","db":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/health/ready   # 503
docker start backend-redis-1       # recovers on its own in ~35 s, no API restart
```

> **Which Redis container?** This machine has **two**: `backend-redis-1`
> (Compose, from `npm run test:db:up`) and `hostel-redis` (the manual
> `docker run --name hostel-redis` in `backend/.env.example`). Both publish
> `6379`, so only one can be up at a time. The dry run used `backend-redis-1`,
> and that is the one currently running — stopping `hostel-redis` would do
> nothing. Confirm with
> `docker ps --format '{{.Names}}\t{{.Status}}' | grep redis` before the drill.
> Postgres has the same duplication (`backend-postgres-1` vs `hostel-pg`); the
> dev database `hostel_emergency` lives in **`backend-postgres-1`**.

Say exactly this:

> *"With Redis down the SOS still lands in Postgres and the API still answers in
> eleven to fifteen milliseconds — we measured six requests. The rate limiter
> fails open rather than blocking the emergency, and the health endpoint
> honestly reports `degraded`. What you lose is escalation and real-time
> fan-out, because both transport over Redis. They resume when it comes back."*

**Do not say "still realtime everywhere".** During the outage the dashboard may
be connected to a different instance than the one that accepted the SOS, and
cross-instance delivery waits for Redis: V1 measured a different-instance
warden receiving the event **77 s late**, about 2 s after Redis returned. The
alert is never lost — it is in Postgres and appears on refresh or on recovery —
but the live card is not guaranteed while Redis is down. This is guarantee #3's
documented scope.

**Do this drill last**, or skip it if the demo is running long. It is the one
drill whose visual result depends on which instance the socket landed on.

**Never gate the SOS on `/health/ready`.** It returns 503 by design while Redis
is down; that is a readiness signal for a load balancer, not a permission slip
for the emergency button.

### Worker down — visible, not silent (**E5**, **H3**)

```bash
npx pm2 stop worker      # InstanceDown fires; the pill goes "Escalation pending…"
                         # then "⚠️ Escalation failed" after a 10 s grace
npx pm2 start worker     # an already-queued delayed job survives and fires
```

**E5** measured a pending job surviving the restart and firing **1.6 s** after
the worker came back — the job lives in Redis, not in worker memory.

---

## 7:15 — Close (15s)

> "One button, three delivery paths, an audit trail, and alarms on the alarms.
> The next steps are in `docs/FUTURE_WORK.md` — primarily refresh tokens and
> horizontal worker scaling with a distributed lock."

**Reset after the demo:** `cd backend && npm run demo:reset` (PM2 still running,
so the counters zero too). Then click the **Active** tab before you walk away —
the filter persists in `localStorage` and the next presenter inherits it.

---

## Backup answers (if asked)

| Question | Answer |
| --- | --- |
| Why 3 instances? | Cross-instance fan-out via the Redis adapter, rolling restarts, and real failover behind nginx. Stop one instance and the dashboard reconnects to another; POSTs through :8080 still succeed. |
| Why not cluster the worker? | Two consumers can double-send SMS; needs a lock. Deliberate. |
| What if Redis dies? | SOS still returns **201 in 11–15 ms** and the alert is persisted; `/health` says `degraded`, `/health/ready` says 503 — neither blocks the SOS. Escalation and cross-instance fan-out pause and resume on recovery; the live card is not guaranteed until then. |
| What if FCM fails? | Push is fire-and-forget; the socket path is primary; stale tokens are deleted on the next send. **Unit-proven only** — Firebase is unconfigured here, so no real device has exercised it (`docs/DEMO_SETUP.md` §2). |
| Why does the pill say "Escalation failed"? | Because the worker's Twilio send genuinely failed — no credentials in this environment. The pill reports the worker's receipt, not a client-side timer. That is the fix, not a bug. |
| Can a student be rate-limited out of sending an SOS? | No. Over 5 SOS/60s the limiter **allows the request through**, logs `sos_rate_limit_overridden` and increments `sos_overrides_total`. We prefer a 7th push over a silently dropped emergency. (**G2**) |
| Why plain-string status? | Transition rules live in testable app code; adding RESOLVED needed no enum migration. |
| Why a Seq Scan in the history query? | The planner's choice at demo row counts, not a missing index. Forced `enable_seqscan=off` uses an index; at 5,003 rows the planner picks `idx_alerts_status_created` unforced (3×, one per UNION branch, 0.607 ms). Measured plans are in `alert.routes.ts:475-533`. (**J4**) |
| Is the SMS number committed? | No — `WARDEN_ONCALL_PHONE` env only. The root `.husky/pre-commit` scanner blocks secret-shaped content; git history is initialized and gitleaks reports **0 findings** (`docs/DEMO_SETUP.md` §4). |
