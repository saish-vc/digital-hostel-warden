# Manual test checklist

**Why this file exists.** The automated suite (`backend/npm test`) covers the
HTTP contract, socket fan-out, escalation timing, authorization, and the FCM
payload shape. It cannot cover things that only exist in a real browser, a real
phone, a real carrier network, or a process restart. Those are checked here,
by hand, before a demo or a release.

Run the automated suite first — this checklist assumes it is green.

## 0. Prerequisites

| # | Step | Expected |
|---|---|---|
| 0.1 | `cd backend && npm run test:db:up && npm test` | Suite passes in under 90s (see the summary Vitest prints). |
| 0.2 | `cd backend && npm run seed && npm run dev` | API on `:4000`, seed prints the demo credentials. |
| 0.3 | `cd backend && npm run worker` in a second terminal | `[worker] Escalation worker ready (queue: escalation)`. |
| 0.4 | `cd warden-dashboard && npm run dev` | Dashboard on `:5173`, login page loads. |
| 0.5 | `cd student_app && flutter run` on a physical Android device | Login screen loads; device on the same network as the API. |
| 0.6 | `.env` has real values for `FIREBASE_SERVICE_ACCOUNT_B64`, the four `TWILIO_*` / `WARDEN_ONCALL_PHONE` variables, and a reachable `REDIS_URL` | API/worker logs show `[firebase] FCM messaging initialized`; no `SMS is not configured` error on escalation. |
| 0.7 | Warden dashboard is served over **https** or `localhost`, and notification permission is granted | Browser reports the PWA as installable / notifications allowed. |

> A physical Android device and a phone that can receive the on-call SMS are
> required for sections 2 and 3. An emulator is not sufficient for FCM.

---

## 1. FCM push on a backgrounded dashboard

Automation cannot cover this reliably: headless Chrome does not deliver Web
Push, and the service worker's notification click handling does not exist in
jsdom.

1. Log in to the warden dashboard.
2. Accept the browser notification permission prompt.
3. Open DevTools → Application → Service Workers; confirm the service worker
   is **activated**.
4. Background the tab (switch to another tab, or minimise the browser).
5. From the Flutter app, press SOS.
6. **Expected:** an OS-level notification appears within ~2 seconds with the
   student's name, room, and alert type.
7. Click the notification.
8. **Expected:** the dashboard tab focuses and shows the new alert.
9. Repeat with the browser fully closed (PWA installed, not just a tab).
10. **Expected:** the notification still arrives while the browser process is
    closed, provided the OS allows background push for that browser.
11. Lock the phone/screen and repeat.
12. **Expected:** notification arrives with the screen locked; no duplicate
    notification for the same alert.

**Record:** device model, OS version, browser version, result, timestamp.

---

## 2. Flutter SOS with each location permission state

The app must always send the SOS, even when location is unavailable. Only the
permission UX differs.

### 2.1 Location permitted ("While using the app")

1. Grant location permission to the app.
2. Press SOS.
3. **Expected:** confirmation screen appears; dashboard alert shows a map pin
   at the device's approximate position; accuracy circle is displayed.
4. **Expected:** `latitude`, `longitude`, and `locationAccuracy` are non-null
   on `GET /alerts`.

### 2.2 Location denied (one-time denial)

1. Revoke location permission (or choose "Don't allow" on a fresh install).
2. Press SOS.
3. **Expected:** alert is still created and reaches the dashboard.
4. **Expected:** no map pin; the dashboard shows "location unavailable"
   rather than a pin at (0, 0).
5. **Expected:** no blocking error dialog — the SOS completes.

### 2.3 Location permanently denied ("Don't ask again")

1. Deny permission twice, or set "Don't allow" + "Don't ask again" in system
   settings.
2. Press SOS.
3. **Expected:** alert is created and reaches the dashboard (same as 2.2).
4. **Expected:** *after* the alert is sent, the app shows the "Location
   permission is off" dialog offering **Open settings**.
5. Tap **Open settings** → the OS app-settings page opens.
6. Enable location, return to the app, press SOS again.
7. **Expected:** this alert includes coordinates.

For every case above, confirm on the dashboard that the alert arrives within
~1 second and that acknowledging it flips the student's confirmation screen to
"Warden acknowledged".

---

## 3. Twilio SMS actually arriving on a phone

The automated tests mock Twilio and only assert *that* a send was attempted.
They cannot prove the carrier path, the sender ID, DLT/verification rules, or
the copy.

1. Ensure `WARDEN_ONCALL_PHONE` is the real on-call phone, in E.164 format,
   and that it is verified in the Twilio console if the account is a trial.
2. Keep the warden dashboard **closed** and do not acknowledge.
3. From the Flutter app, press SOS and wait.
4. **Expected:** within 60–75 seconds the phone receives an SMS whose body
   contains `[HOSTEL EMERGENCY]`, the student's name, room, type, and the
   `NO ACKNOWLEDGEMENT FOR 60s` line.
5. **Expected:** the worker log prints
   `[worker] escalation delivered for alert <id>: <SID> → <number>`.
6. Note the message SID and confirm it appears in the Twilio console
   (Monitor → Logs → Messaging) with status `delivered` (not just `sent`).
7. **Expected:** no duplicate SMS arrives for the same alert.
8. Now repeat, but acknowledge the alert at ~20 seconds.
9. **Expected:** no SMS at 60 seconds.
10. Repeat, acknowledging at ~55 seconds.
11. **Expected:** no SMS. (This is the race the automated suite also covers;
    the real-world check confirms the deployed worker has the same code.)
12. Temporarily set an invalid `TWILIO_AUTH_TOKEN`, press SOS, wait.
13. **Expected:** API still returns 201 and the dashboard still shows the
    alert; the worker logs a Twilio authentication failure. Restore the token.

**Record:** carrier, country, sender ID, message SID, delivery status, and
whether the message was filtered as spam.

---

## 4. Worker restart survival

Automation starts and stops the worker in-process; this check proves the
*scheduled escalation lives in Redis*, not in a timer owned by the process.

1. Stop the worker (`Ctrl+C` in its terminal).
2. Confirm the log says `[worker] SIGINT received, closing worker`.
3. From the Flutter app, press SOS.
4. **Expected:** the API returns 201, the dashboard shows the alert, and no
   SMS has been sent.
5. Wait 15 seconds (the job is delayed 60 seconds in Redis).
6. Start the worker again: `npm run worker`.
7. **Expected:** `Escalation worker ready`.
8. **Expected:** at ~60 seconds after the SOS — not 60 seconds after the
   restart — the SMS is sent exactly once.
9. Repeat, but this time acknowledge the alert while the worker is **down**,
   then start the worker and wait past 60 seconds.
10. **Expected:** no SMS. Acknowledge must remove the delayed job, and the
    worker's idempotency guard must also refuse an already-acknowledged alert.
11. Kill the worker with `kill -9` (not Ctrl+C) during a pending escalation,
    restart it, and wait.
12. **Expected:** the SMS still fires at the original deadline, exactly once.

If step 12 fails with no SMS and no job in Redis, the reconciler described in
ADR-05 is not implemented yet — record that explicitly rather than treating it
as a pass.

---

## 5. Two real devices, socket updates in real time

1. Log in to the warden dashboard on **device A** (laptop).
2. Log in to the warden dashboard on **device B** (phone or second laptop).
3. Put both dashboards side by side.
4. From the Flutter app, press SOS.
5. **Expected:** both dashboards show the new alert within ~1 second, both
   play the alarm sound (after the first user gesture has unlocked audio), and
   both show the same alert id.
6. Acknowledge on device A.
7. **Expected:** device B flips the alert to ACKNOWLEDGED within ~1 second,
   and device A does the same. Neither device shows a duplicate alert.
8. On the Flutter confirmation screen, confirm it changes to
   "Warden acknowledged".
9. Put device B to sleep / disable Wi-Fi for 30 seconds, then restore it.
10. **Expected:** the dashboard reconnects (no manual refresh needed), shows
    the "live updates" state as connected again, and refetches the alert list
    so nothing was missed while offline.
11. Force-close the API (`Ctrl+C`) for ~10 seconds while both dashboards are
    open, then restart it.
12. **Expected:** both dashboards show a visible "live updates degraded"
    state while the API is down, reconnect automatically, and resync from REST
    when it returns — no stale alert is treated as current.

---

## 7. Opt-in automated checks (skipped by `npm test`)

These live in the suite but are gated behind an env var, because each one
costs far more than the 5s budget the rest of the suite runs under. They are
listed here so they are run deliberately before a demo rather than forgotten.

### 7.1 History index proof — `tests/index.test.ts`

| | |
|---|---|
| **Run** | `cd backend && RUN_INDEX_TEST=true npm test -- tests/index.test.ts` |
| **Default** | Skipped (`describe.skipIf`). `npm test` reports `1 skipped`. |
| **Why gated** | Seeds 5,000 alerts + `ANALYZE` + `EXPLAIN ANALYZE`. Measured: **15.4s** for the file against a 5s budget. |
| **Target** | `TEST_DATABASE_URL` only — `tests/helpers/testEnv.ts` refuses any database not ending in `_test`. |
| **Asserts** | The history query's plan contains exactly three `Index Scan using idx_alerts_status_created` nodes (one per status branch) and **no** `Seq Scan on "EmergencyAlert"`. |
| **Cleanup** | `afterAll` deletes the seeded alerts and the temporary student, then re-runs `ANALYZE`. |

**Why this test exists (J4).** At demo size (~23–86 rows) Postgres correctly
prefers a sequential scan: reading a two-page table is cheaper than an index
descent. The old code comment claimed a Bitmap Index Scan at that size, which
was false. The index only wins once the table is large enough, so the proof
has to be taken at 5,000 rows.

**One-time capture for the code comment.** `npx tsx scripts/perf-seed.ts` runs
the same query three ways against the **dev** database — current row count,
current row count with `SET LOCAL enable_seqscan = off`, and after seeding
5,000 rows — prints all three plans, then deletes every row it created. It
refuses to run with `NODE_ENV=production`. Use it to refresh the plans pasted
above the history endpoint in `backend/src/routes/alert.routes.ts`.

---

## 8. Sign-off

| Section | Tester | Date | Device / OS / browser | Carrier | Result | Notes |
|---|---|---|---|---|---|---|
| 1. Background FCM | | | | — | ☐ pass ☐ fail | |
| 2.1 Location permitted | | | | — | ☐ pass ☐ fail | |
| 2.2 Location denied | | | | — | ☐ pass ☐ fail | |
| 2.3 Location permanently denied | | | | — | ☐ pass ☐ fail | |
| 3. Twilio SMS | | | | | ☐ pass ☐ fail | |
| 4. Worker restart | | | | — | ☐ pass ☐ fail | |
| 5. Two-device sockets | | | | — | ☐ pass ☐ fail | |
| 7.1 History index (opt-in) | | | | — | ☐ pass ☐ fail | |

A section counts as passed only when every numbered expectation in it was
observed. Partial passes must list which expectation failed.
