# Audit record — checklist items verified against code

Purpose: the previous two audit/triage passes lived only in chat, so provenance
kept getting lost. This file is the on-disk record of **what was checked, where
the evidence is, and what could not be verified**. It is additive: nothing here
changes behaviour.

Verification date: 2026-11-07, line citations re-grepped against the tree on
2026-11-08. Every row below was re-read from the working tree, not from memory.
**See §5 for the 2026-11-08 re-verification** — one row (F2) was falsified by the
dry run and corrected, and the §1 addresses were re-pinned after the remediation
shifted them.

> **ID collision warning.** The IDs in this file come from the 2026-11-07
> checklist. They are **not** the same namespace as the drill IDs in
> `docs/DRY_RUN_REPORT.md` (2026-11-08) or in the remediation brief. Examples:
> `E6` here = "foreground push beeps once", but `E6` in the dry run = "Redis
> down, SOS still 201"; `F2` here = "documented EXPLAIN matches the real plan",
> but `F2` in the dry run = "cross-instance alert events"; `H3` here = "no debug
> `console.*`", but `H3` in the dry run = "`EscalationFailuresHigh` fires".
> Always name the source document when citing an ID.

## 1. Items with code evidence

| ID | Claim | Evidence | State |
| --- | --- | --- | --- |
| C2 | Board is not silently truncated at 100 rows; status filterable server-side | `backend/src/routes/alert.routes.ts:211-244` — `BOARD_DEFAULT_LIMIT=500`, `BOARD_MAX_LIMIT=1000`, `?status=` validated against `ALERT_STATUSES` | PASS |
| J3 | History student-name search matches inside the per-status branch, before `LIMIT` | `alert.routes.ts:631-664` `escapeLikePattern` + `historyPredicate`; applied in `historyBranch` (`:690`) and `fetchHistoryCount` (`:738`) | PASS |
| F2 | Documented EXPLAIN matches the real plan | **CORRECTED 2026-11-08.** The old row cited `alert.routes.ts:474-477` claiming `Bitmap Index Scan on idx_alerts_status_created` per branch. That was **false** at demo row counts (dry-run drill **J4** measured Seq Scan + Sort at 86 rows). The comment is now `alert.routes.ts:475-533` and quotes three measured `EXPLAIN (ANALYZE)` captures: 23 rows → Seq Scan + Sort; same rows with `enable_seqscan = off` → Index Scan using `idx_alerts_status_created`; 5,023 rows → Index Scan chosen unforced. Reproduce with `scripts/perf-seed.ts` or `RUN_INDEX_TEST=true npm test -- tests/index.test.ts` | PASS (claim now matches reality) |
| B1 | Unknown-email login burns equivalent bcrypt work | `backend/src/routes/auth.routes.ts:19,50` — `DUMMY_PASSWORD_HASH` cost 12, compared on unknown email | PASS |
| J1/J2 | `demo:reset` works on a freshly created database | `backend/prisma/demo-reset.ts:349-358` — `ensurePopulation()` runs before the head-warden lookup, with an `ORDER MATTERS` comment recording the P2025 it fixes | PASS |
| J5 | "Live" dot reflects socket state, not a constant | `warden-dashboard/src/pages/Dashboard.tsx:296` — `error ? 'error' : connected ? 'live' : 'reconnecting'`, passed to `ConnectionIndicator` at `:354`; `components/ConnectionIndicator.tsx` maps the three states | PASS |
| J6 | Board tabs (Active/Resolved/All) persist across refresh | `Dashboard.tsx:27,29-38,93,121-124,536` — `FILTER_KEY='hostel.alertFilter'`, `readStoredFilter()` seeds `useState`, an effect writes it back, `FILTERS.map` renders the tabs | PASS |
| J7 | The green dot cannot lie while the socket is dead | same wiring as J5; `hooks/useAlertSocket.ts:96-103` — `disconnect` clears `connected`, `connect_error` clears it **and** sets `error` | PASS |
| J8 | History view is reachable and survives refresh/back | `warden-dashboard/src/App.tsx:16,25-30` — pathname shell, `/history`, `popstate` listener + `pushState`; `pages/History.tsx` | PASS |
| J9 | Student app shows a terminal RESOLVED state | `student_app/lib/screens/confirmation_screen.dart:30,46-57,73-74,149-152` — `_resolved` branch, "Case closed ✅", `resolvedAt` shown, `alert:updated` handler accepts both ACKNOWLEDGED and RESOLVED | PASS |
| E6 | Foreground push beeps, and one alert never beeps twice | `warden-dashboard/src/lib/beep.ts:31,34` `playBeepForAlert` (`BEEP_DEDUPE_MS = 5_000`, keyed by alert id); called from `useAlertSocket.ts:113` (`alert:new`) and `Dashboard.tsx:179` (foreground FCM) | PASS |
| H3 | No debug `console.*` left in the dashboard source | `grep -rn "console\.\(log\|debug\|info\)" warden-dashboard/src` → none | PASS |
| J10 | Demo runbook + future-work + load-test disclosure exist | `docs/DEMO_SCRIPT.md`, `docs/FUTURE_WORK.md`, `docs/LOAD_TEST_RESULTS.md` | PASS |
| J11 | Load harness exists, runs green, and its cleanup door is guarded | `load-test/sos.js`, `load-test/README.md`; `backend/src/routes/loadtest.routes.ts` — timing-safe `x-loadtest-token` vs `METRICS_TOKEN`, production 403, `loadtest_student_` blast radius; mounted in `src/app.ts`. **Executed** with k6 v2.3.0: 1 543 iterations, 1 544/1 544 checks, `http_req_failed` 0.00%, p95 17.59 ms, teardown `HTTP 200` (see `docs/LOAD_TEST_RESULTS.md` Measurement 2) | PASS |
| A5 | Real `.env` and Firebase JSON cannot be committed | root/backend/dashboard `.gitignore` — `.env`, `.env.*` (templates re-allowed), `firebase-service-account.json`, `*.pem`, `*.log` | PASS |
| H10 | Pre-commit secret scan exists, one implementation | `.husky/pre-commit` (root, the real scan) + `backend/.husky/pre-commit` (shim that execs the root hook); `npm run hooks:install` | PARTIAL — see §3 |

## 2. Checks run against this tree

| Check | Command | Result |
| --- | --- | --- |
| Backend types | `cd backend && npx tsc --noEmit` | exit 0 — **re-run 2026-11-09**, exit 0 |
| Backend suite | `cd backend && npm test` | 2026-11-07: 9 files / 74 tests, 0 failed, 68.9 s. **After the remediation: 9 files passed + 1 skipped (10), 74 tests passed + 1 skipped (75), 75.61 s.** The skip is `tests/index.test.ts`, opt-in via `RUN_INDEX_TEST=true` |
| Dashboard types + bundle | `cd warden-dashboard && npx tsc --noEmit && npx vite build` | exit 0, built in 8.85 s — **re-run 2026-11-09**: tsc exit 0, `✓ 129 modules transformed`, `✓ built in 4.75s` (513.25 kB js / 32.92 kB css; the >500 kB chunk warning is pre-existing) |
| Flutter static analysis | `cd student_app && flutter analyze` | "No issues found!" (52.5 s) — 2026-11-07, not re-run |
| Secret scan | `cd backend && node scripts/secret-scan-check.cjs` | 2026-11-07: 61 files, 0 hits. **Re-run 2026-11-09: `scanned 65 files with the hook's patterns` / `SECRET SCAN: CLEAN — 0 hits`, exit 0** |

## 3. Known gaps that code cannot close here

| Gap | Why | What would close it |
| --- | --- | --- |
| Hook enforcement never observed | The tree has **no `.git`** and `core.hooksPath` is unset, so `git commit` (and therefore `.husky/pre-commit`) cannot run | `git init`, `npm run hooks:install`, stage a file containing a planted token, confirm the commit is refused |
| ~59 checklist rows not recorded | The original checklist table (IDs beyond the rows above) was never written to disk and no longer exists in either the conversation context or the repository | Re-supply the **checklist** (IDs + requirement text) and each row can be verified the same way as §1 |

## 4. Items that remain unverified by name

`K3` and `K4` were tiered in the earlier triage but their requirement text is
not recoverable from any artifact in this repository. They are listed here
rather than described from memory, because a wrong restatement would read as a
verified row.

## 5. Re-verification after the 2026-11-08 dry run

The dry run (`docs/DRY_RUN_REPORT.md`, 66 drills, NO-GO) and the remediation that
followed it changed the tree. This section records what that means for the rows
above, so nobody reads a 2026-11-07 PASS as a current guarantee.

| Row | What changed |
| --- | --- |
| **F2** | The claim was **false** and is corrected in place above. Dry-run drill **J4** measured Seq Scan + Sort at 86 rows, not the Bitmap Index Scan the old comment asserted. `alert.routes.ts:475-533` now carries three real `EXPLAIN (ANALYZE)` captures. |
| **J6** | Still PASS, and now load-bearing: the persisted filter is exactly what hid a new PENDING SOS in dry-run **K6** (observation N-5). Fixed on the client, not by removing persistence — a banner (`🔔 N new pending alerts` + **View**) now interrupts any non-Active tab. `Dashboard.tsx:195-215` and `:450-473`. |
| **J9** | Still PASS. The resolve leg it depends on is now reachable from the dashboard (**Resolve** button + `ResolveDialog.tsx`), not only from `PATCH /alerts/:id/resolve`. |
| **E6** (this file's ID = push beep dedupe) | Untouched, still PASS. **Not** the dry run's E6 (Redis-down SOS), which was FAIL and is now fixed — see `progress.md` §4, guarantee #3. |
| **H10** | Still PARTIAL for the same reason: no `.git`, so the hook cannot fire. `docs/DEMO_SETUP.md` §4 is the checklist that closes it. The scanner's patterns were probe-tested and `scripts/secret-scan-check.cjs` runs clean over 65 files. |
| **All §1 line numbers** | **Re-grepped and re-pinned on 2026-11-08**, not carried over. C2 `181-214`→`211-244`, J3 `589-628/648/696`→`631-664/690/738`, J1/J2 `294-299`→`349-358`, J5 `236`→`296` (+`:354`), J6 →`27,29-38,93,121-124,536`, J7 →`96-103`, J8 →`16,25-30`, J9 →`30,46-57,73-74,149-152`, E6 →`beep.ts:31,34` + `Dashboard.tsx:179` (was `:158`). B1 `19,50`, F2 `475-533` and H3 were already correct. The **claims** are unchanged — only the addresses moved. |

**Claims corrected elsewhere in this pass** (the documents, not the code):

- `progress.md` §1/§5/§6/§9 — "no monitoring", "no rate limiting", "no resolve
  endpoint", "PM2 not launched", and the 7-file/58-test count were all false and
  are replaced with what was observed.
- `progress.md` §4 — the seven safety guarantees are now listed with their real
  evidence and status. Guarantee #3 is deliberately **narrower** than the
  remediation brief's suggested sentence: only alert creation was measured under
  a Redis outage (31–151 ms). Cross-instance broadcast was 77 s late and FCM was
  never exercised, so neither is claimed.
- `docs/DEMO_SCRIPT.md` — rewritten; every step carries its verifying drill ID,
  the Twilio/nginx legs are marked **PRODUCTION DEPLOYMENT ONLY**, the container
  name is `backend-redis-1` (the Compose one; a stopped `hostel-redis` duplicate
  also exists on this machine and both claim port 6379), and the false index-scan and
  "still realtime" claims are gone.
- `docs/FUTURE_WORK.md` §6 and `progress.md` §8 — nginx documented, not run;
  **F3/F4 DEFERRED — production-only**.
