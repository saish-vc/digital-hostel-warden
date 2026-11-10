# Demo setup — the configuration that is not code

**Why this file exists.** Four dry-run drills cannot pass by changing code.
C4/C5 need an Android emulator, I2/I3 need a git repository, and the SMS and
FCM legs need *your* accounts, *your* phone number and *your* Firebase project.
No amount of editing the repository substitutes for those. This is the manual
checklist that closes them.

**This file is a checklist, not automation.** Nothing here has been run for
you. Work through it top to bottom, tick the boxes, and record the outcome.
Every command below was checked against this tree on Windows 10 / Git Bash;
where a step differs on macOS/Linux the alternative is given.

Run `cd backend && npm run test:db:up && npm test` first and confirm it is
green (74 passed, 1 skipped, ~76s). This checklist assumes that baseline.

---

## 0. Where this environment actually stands

Verified by inspection, not assumed:

| Item | State | Consequence |
|---|---|---|
| Twilio | `TWILIO_ACCOUNT_SID` / `AUTH_TOKEN` / `FROM_NUMBER` / `WARDEN_ONCALL_PHONE` all empty | Escalation job fails with `SMS is not configured`; `sms_sent_total` has **no series** |
| FCM (backend) | `FIREBASE_SERVICE_ACCOUNT_B64` empty | Push disabled; `fcm_sent_total` has **no series** |
| FCM (dashboard) | `.env` holds `TEST-KEY` / `test-project` placeholders | Service worker initialises against a non-existent project |
| Firebase SDK version | `firebase@13.2.0` in `package.json`; `importScripts` pinned to `13.2.0` | **Already matches** — re-check only after an upgrade |
| Android tooling | `flutter` on PATH; `adb` **not** on PATH; no AVD | C4/C5 SKIP |
| Git | Initialized; baseline commit `1083575`; `core.hooksPath=.husky` | I2/I3 now runnable; every commit is scanned |
| Secret scanner | `.husky/pre-commit` (repo root) + `gitleaks 8.30.1` + `.gitleaks.toml` | Staged and full-history scans: **0 findings** |
| Grafana | Both variants provisioned | Load **variant A** until §1 and §2 are done |

**Port map — the single most common setup mistake.** `backend/src/config/instance.ts`
resolves the port in this order: explicit `PORT` → `NODE_APP_INSTANCE`
(PM2 cluster: `3001 + index`) → **4000**.

| How you run the API | Port(s) | What clients must use |
|---|---|---|
| `npm run dev` (single instance) | `4000` | `http://localhost:4000` |
| `pm2 start ecosystem.config.js` (API topology) | `3001`, `3002`, `3003` | direct only: `http://localhost:3001` |
| PM2 + nginx (the demo topology) | nginx `8080` → `3001/3002/3003` | `http://localhost:8080` |

The Flutter app defaults to `http://10.0.2.2:4000`
(`student_app/lib/services/api.dart:11`). That is correct for `npm run dev`
and **wrong for the PM2/nginx demo topology** — clients must use the proxy on
`8080`. See §3.3.

### 0.1 Start the reverse proxy (F3/F4)

nginx 1.31.8 is installed via `winget` (`nginxinc.nginx`). The repository file
`backend/nginx.conf` is authoritative: round-robin upstream over
`3001/3002/3003`, WebSocket upgrade on `/socket.io/`, passive ejection of a
dead instance (`max_fails=3 fail_timeout=10s`), and `proxy_next_upstream` for
REST. Clients are WebSocket-only, so no sticky session is needed.

- [ ] Start it in a dedicated terminal (keep the terminal open):

```powershell
$prefix = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'nginxinc*' | Select-Object -First 1).FullName + '\nginx-1.31.8'
nginx -p $prefix -c "$PWD\backend\nginx.conf" -g "daemon off;"
```

- [ ] Verify round-robin (expect the three ids to repeat):

```powershell
1..6 | ForEach-Object { (curl.exe -s http://localhost:8080/health | ConvertFrom-Json).instanceId }
```

- [ ] Point the dashboard at the proxy: `warden-dashboard/.env` →
      `VITE_API_URL="http://localhost:8080"`, then restart Vite.
- [ ] F3/F4 acceptance: stop one API instance (`pm2 stop <id>`), confirm the
      dashboard returns to `Live` and `POST /alerts` through `8080` still
      returns `201`. Restart it with `pm2 start <id>`.

> The proxy is **not** a production TLS terminator here; this is a plain HTTP
> listener on `localhost:8080`. TLS and a public hostname remain production
> work (see `docs/FUTURE_WORK.md`).

---

## 1. Twilio — makes the 60s escalation real (drills E2 delivery leg + E9, MANUAL_TESTS §3)

### 1.1 Account and number

- [ ] Create an account at `twilio.com`. The trial is free and carries ~$15 credit.
- [ ] In Console → **Account Info**, copy the **Account SID** and **Auth Token**.
- [ ] Get a sending number: Console → **Phone Numbers → Buy a number**, or use
      the trial number. It must be SMS-capable.
- [ ] **Trial accounts only:** verify the receiving phone under Console →
      **Phone Numbers → Manage → Verified Caller IDs**. Without this Twilio
      rejects the send with **error 21608**.
      *Expected:* the warden's phone appears in the verified list.

### 1.2 Configure `backend/.env`

- [ ] Set these five values:

```dotenv
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID="CHANGE-ME"
TWILIO_AUTH_TOKEN="CHANGE-ME"
TWILIO_FROM_NUMBER="+1..."          # your Twilio sending number, E.164
WARDEN_ONCALL_PHONE="+91..."        # the real on-call phone, E.164
```

`WARDEN_ONCALL_PHONE` is validated against `^\+?[1-9]\d{1,14}$`
(`sms.service.ts:135`). Spaces, dashes or a leading `0` fail with
`WARDEN_ONCALL_PHONE is not a valid E.164 number`. Use `+919876543210`, not
`+91 98765 43210`.

- [ ] Optional: set `DASHBOARD_URL="https://your-dashboard"` — when present it
      is appended to the SMS body as a deep link (`sms.service.ts:54`). Leave
      empty for a LAN demo and the body stays short.
- [ ] Confirm `backend/.env` is gitignored before saving (§4). **Never** paste
      the Auth Token into a committed file, a screenshot, or a chat message.

### 1.3 Restart so the new env is loaded

PM2 does not re-read `.env` on its own.

- [ ] `cd backend && npx pm2 restart api worker --update-env`
      *Expected:* all 3 `api` instances and `worker` return to `online`.
- [ ] If you run via `npm run dev` instead, stop and restart that terminal.

### 1.4 Smoke-test the service directly

This command was verified to reach the Twilio guard. Before configuration it
fails with `SMS is not configured: ...`; after configuration it sends one real
SMS and prints the receipt.

- [ ] From `backend/`:

```bash
node node_modules/tsx/dist/cli.mjs -e "import('dotenv/config').then(()=>import('./src/services/sms.service')).then(m=>m.default.sendEscalationSms({id:'setup-check',type:'MEDICAL',student:{name:'Aarav Sharma',roomNumber:'B-314'}})).then(r=>console.log('OK receipt='+r.receiptId+' to='+r.to)).catch(e=>{console.error('FAIL:',e.message);process.exit(1)})"
```

> Use this exact form. `npx tsx -e "..."` breaks on Windows when Node lives
> under `C:\Program Files` (the space is not escaped through `npx.cmd`), and
> `node -e "require('./src/services/sms.service')"` cannot load TypeScript.
> Under `tsx -e` the namespace arrives as `m.default`, hence `m.default.sendEscalationSms`.

*Expected:* `OK receipt=SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx to=+91...`, the
phone receives a body containing `[HOSTEL EMERGENCY]`, `Aarav Sharma`,
`Room B-314`, `MEDICAL` and `NO ACKNOWLEDGEMENT FOR 60s`, and the log prints
`[sms] escalation SMS delivered to <number> — receipt <SID>`.

- [ ] Record the SID and confirm it in Console → **Monitor → Logs → Messaging**
      with status **`delivered`**, not merely `sent`.
- [ ] This smoke test sends outside the escalation queue, so it does not touch
      any alert. Delete nothing afterwards.

### 1.5 End-to-end through the worker

- [ ] Raise an SOS from the Flutter app and **do not acknowledge**.
      *Expected at ~60s:* worker logs
      `[worker] alert <id> unacknowledged — sending escalation SMS`, then
      `[worker] escalation delivered for alert <id>: <SID> → <number>`; the
      phone receives exactly one SMS.
- [ ] Raise a second SOS and acknowledge at ~20s.
      *Expected:* **no SMS at 60s**; `escalations_cancelled_total` increments.
- [ ] Complete `docs/MANUAL_TESTS.md` §3 in full, including the invalid-token
      step (API must still return 201).

### 1.6 India-specific decision point — MSG91

- [ ] Measure delivery latency across 3–5 real sends. If it is consistently
      **>30s**, decide whether to switch to MSG91.

**This is a decision, not a configuration flip.** `SMS_PROVIDER` is a switch
with exactly one implemented value. Setting `SMS_PROVIDER=msg91` today throws
`SMS_PROVIDER=msg91 is not implemented yet (only "twilio")`
(`sms.service.ts:121-126`) and every escalation job fails. The MSG91 branch is
a stub comment, not code. Implementing it means adding `sendViaMsg91(alert, phone)`
with the same `Promise<SmsResult>` contract and extending
`isRetryableTwilioError` for MSG91's error shape. That is a code change outside
this remediation's scope — raise it separately, and see
`docs/FUTURE_WORK.md` §3.

### 1.7 What changes in the UI once Twilio works

- [ ] Switch Grafana to **variant B**: `http://localhost:3000/d/hostel-emergency-configured`
      ("Hostel Emergency (SMS + FCM configured)"). Panels 5 and 6 turn into
      live stats. Both queries use `or vector(0)`, so they read `0` rather than
      "No data" even before the first send.
- [ ] The dashboard's escalation pill now reports a **server-confirmed**
      outcome. With Twilio unconfigured it correctly degrades to
      unconfirmed/failed instead of claiming "SMS sent".

---

## 2. FCM Web Push — makes background notifications real (drills D1/D2/D3/D4/D6, MANUAL_TESTS §1)

### 2.1 Firebase project

- [ ] Firebase Console → **Add project**.
- [ ] Project settings → **General** → **Your apps** → add a **Web app** (`</>`).
      Register the app; you do not need Firebase Hosting for a LAN demo.
- [ ] Copy the six public config values: `apiKey`, `authDomain`, `projectId`,
      `storageBucket`, `messagingSenderId`, `appId`.
- [ ] Project settings → **Cloud Messaging** → **Web Push certificates** →
      **Generate key pair**. Copy the public VAPID key.

### 2.2 Service account (backend credential)

- [ ] Project settings → **Service accounts** → **Generate new private key**.
      This downloads a JSON file. **Scope this account to Firebase Cloud
      Messaging only** — it is a full credential.
- [ ] Base64-encode it to a single line:

```powershell
# PowerShell (Windows)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```
```bash
# Git Bash / macOS / Linux — -w0 keeps it on one line
base64 -w0 service-account.json
```

- [ ] Put the result in `backend/.env`:

```dotenv
FIREBASE_SERVICE_ACCOUNT_B64="<one-line base64>"
```

- [ ] **Delete the downloaded JSON** from your working tree, or move it outside
      the repository. It must never be staged. The `.gitignore` covers `*.pem`
      and `.env`, but a stray `service-account.json` is not covered by name —
      check it explicitly in §4.4.
- [ ] Restart: `cd backend && npx pm2 restart api worker --update-env`
      *Expected:* API logs show `[firebase] FCM messaging initialized`.

### 2.3 Dashboard config

- [ ] Replace the placeholder values in `warden-dashboard/.env`:

```dotenv
VITE_FIREBASE_API_KEY="AIza..."
VITE_FIREBASE_AUTH_DOMAIN="<project-id>.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="<project-id>"
VITE_FIREBASE_STORAGE_BUCKET="<project-id>.appspot.com"
VITE_FIREBASE_MESSAGING_SENDER_ID="<sender-id>"
VITE_FIREBASE_APP_ID="1:<sender-id>:web:<app-id>"
VITE_FIREBASE_VAPID_KEY="<public VAPID key>"
```

- [ ] **Do not edit `public/firebase-messaging-sw.js`.** It carries
      `__VITE_FIREBASE_*__` markers that the Vite plugin substitutes
      automatically — in dev on every request, and in `dist/` at build close
      (`warden-dashboard/vite.config.ts:34-69`). Editing the markers by hand
      breaks the substitution.
- [ ] **Restart the Vite dev server.** `import.meta.env` values (including the
      VAPID key) are baked in at server start; saving `.env` alone is not enough.
- [ ] Verify the SDK and the service worker agree:

```bash
grep '"firebase"' warden-dashboard/package.json
grep importScripts warden-dashboard/public/firebase-messaging-sw.js
```

*Expected:* both show **13.2.0**. They match today. If you upgrade the SDK,
upgrade both `importScripts` URLs to the same version or the worker fails to
register.

### 2.4 Serve over a trustworthy origin

- [ ] Use `http://localhost:5173` (a secure context) or real **HTTPS**.
      Web Push will not work over a plain `http://192.168.x.x` LAN address.
      For a second device, terminate TLS or use an HTTPS tunnel.
- [ ] Log in to the dashboard and **accept** the notification permission prompt.
- [ ] DevTools → **Application → Service Workers** → confirm
      `firebase-messaging-sw.js` is **activated** and running.
- [ ] DevTools → **Application → Service Workers → Push** may be used to send a
      test payload, but the real check is §2.5.

### 2.5 End-to-end

- [ ] Background the dashboard tab, raise an SOS from the phone.
      *Expected:* an OS notification within ~2s showing the student's name,
      room and alert type.
- [ ] Click it. *Expected:* the dashboard tab focuses and shows the alert.
- [ ] Close the browser entirely (PWA installed) and repeat.
      *Expected:* the notification still arrives, subject to OS background-push
      policy.
- [ ] Confirm **no duplicate** notification for one alert. The foreground
      `onMessage` path and the worker's `onBackgroundMessage` are mutually
      exclusive by design.
- [ ] Complete `docs/MANUAL_TESTS.md` §1 and record device, OS and browser.

### 2.6 Stale-token handling

- [ ] Uninstall/reinstall the PWA or clear site data so the old FCM token
      becomes invalid, then raise an SOS.
      *Expected:* the send reports an unregistered token, the stale
      `DeviceToken` row is **deleted**, and `fcm_sent_total{status="stale_token"}`
      increments. The SOS itself still returns 201 — push is fire-and-forget.

---

## 3. Android emulator — unblocks C4 and C5

C4 (permission-denied flow) and C5 (GPS-timeout flow) were SKIP because no
emulator existed. `flutter` is already on PATH; `adb` is not.

### 3.1 Tooling

- [ ] `flutter doctor -v` — resolve every ✗ under **Android toolchain**.
- [ ] Install **Android SDK Platform-Tools** and an **Android SDK Platform**
      via Android Studio → SDK Manager, then add `platform-tools` to PATH so
      `adb devices` works.
- [ ] Accept licences: `flutter doctor --android-licenses`.

### 3.2 Create and boot an AVD

- [ ] `flutter emulators` — list what exists.
- [ ] `flutter emulators --create --name hostel_demo` (or create one in Android
      Studio → Device Manager). Pick a **Play Store**-less image if you want
      `adb root`; a recent API level (34+) is fine.
- [ ] `flutter emulators --launch hostel_demo`
- [ ] `adb devices` → *Expected:* one `emulator-5554  device`.
- [ ] In the emulator, enable Location and set a mock position via
      **Extended controls → Location** (e.g. `12.97190, 77.59480`) so C1's
      marker/accuracy assertions have something to render.

### 3.3 Point the app at the right port — read this before running

The app defaults to `http://10.0.2.2:4000`. `10.0.2.2` is the emulator's alias
for the host, which is correct; **the port is only correct for `npm run dev`.**

- [ ] If the API runs under **PM2** (the demo topology), override the port:

```bash
cd student_app
flutter run --dart-define=API_URL=http://10.0.2.2:8080
```

- [ ] If the API runs via **`npm run dev`**, the default is already right:

```bash
flutter run
```

- [ ] For a **physical device** on the same Wi-Fi, use the host's LAN IP and
      whichever port the API is on:

```bash
flutter run --dart-define=API_URL=http://192.168.1.20:8080
```

*Expected:* the login screen accepts `aarav@hostel.local / password123`. If it
hangs or reports a connection error, the port is wrong — check §0's port map
first. Also confirm `CORS_ORIGIN` in `backend/.env` allows the dashboard origin
and that the device can reach the host (same network, host firewall open).

### 3.4 The three permission states

Work through `docs/MANUAL_TESTS.md` §2 in full. Summary of what to capture:

- [ ] **Granted** — allow location "While using the app". Press SOS.
      *Expected:* marker + accuracy circle on the dashboard; `latitude`,
      `longitude`, `locationAccuracy` non-null on `GET /alerts`. → **C1**
- [ ] **Denied once** — revoke permission, press SOS.
      *Expected:* alert still created and delivered; "Location unavailable"
      banner; **no pin at (0,0)**; no blocking dialog. → **C4**, **C2/C3**
- [ ] **Permanently denied** — deny twice / "Don't ask again", press SOS.
      *Expected:* alert still sent; *after* sending, the "Location permission is
      off" dialog offers **Open settings**, which opens the OS app-settings
      page. Re-enable and confirm the next SOS carries coordinates. → **C4**
- [ ] **GPS timeout** — enable permission but make a fix impossible (Extended
      controls → Location → set no position, or disable the emulator's GPS).
      Press SOS. *Expected:* the app gives up waiting and still sends; the
      dashboard shows the no-GPS state. → **C5**
- [ ] Capture a screenshot of each state and attach them to
      `docs/MANUAL_TESTS.md` §2, then flip C4/C5 from SKIP to PASS in the V2
      dry-run report.

> An emulator is sufficient for C4/C5 (permission and timeout UX). It is **not**
> sufficient for FCM push or real carrier SMS — §1 and §2 need a physical
> device and a real phone.

---

## 4. Git init and the secret scan — unblocks I2 and I3

**Status: DONE on this tree.** The repository is initialized, the hook is
active, and both the staged and full-history scans report **0 findings**.
Re-run the checks below after any change that adds files.

### 4.1 Initialise (already executed — repeat only for a fresh clone)

- [x] From the repository root:

```bash
git init
git config core.hooksPath .husky     # or: npm run hooks:install
git config --get core.hooksPath      # -> .husky
```

- [x] Baseline commit: `1083575` (`baseline: verified phases 1-4 …`).
- [x] Independent scanner installed: `winget install Gitleaks.Gitleaks`
      → `gitleaks 8.30.1`, with the narrow allowlist in `.gitleaks.toml`.
- [x] `gitleaks git --staged --config .gitleaks.toml` → **no leaks found**
      (209 tracked files).
- [x] `gitleaks git --config .gitleaks.toml` (full history) → **no leaks found**.
- [x] `node backend/scripts/secret-scan-check.cjs` → **CLEAN — 0 hits**.
- [x] `git ls-files` contains only `.env.example` / `.env.test.example`;
      no real `.env`, `*.pem`, or Firebase service-account JSON is tracked.

- [ ] **Do not `npm install husky` or `git-secrets`.** Neither is a dependency
      of this project, and neither is needed: the repository ships its own
      shape-based scanner at `.husky/pre-commit`. `backend/.husky/pre-commit`
      is only a shim that `exec`s the root one, so there is a single
      implementation. Installing husky would overwrite `core.hooksPath` and
      could silently disable the existing scan.
- [ ] `npm run hooks:install` also runs `chmod +x .husky/pre-commit`. On
      Windows/Git Bash this works; if the hook does not fire, check the bit.

### 4.2 Confirm the ignore rules before the first commit

- [ ] `git check-ignore -v backend/.env warden-dashboard/.env`
      *Expected:* both matched by `.gitignore` (`.env`, `.env.*`, with
      `!.env.example` and `!.env.test.example` re-included).
- [ ] `git status --short` — **read every line.** No `.env`, no
      `service-account.json`, no `*.pem`, no token scratch files.
- [ ] `git add` specific paths, not `git add -A`, for the first commit. Then
      `git diff --cached --name-only` and confirm the list contains no secrets.

### 4.3 First commit

- [ ] `git commit -m "Initial commit — Hostel Emergency Monitoring System"`
      *Expected:* the hook runs silently and the commit succeeds.

### 4.4 Prove the hook actually blocks (this is drill I3)

- [ ] Create a throwaway file containing a secret-shaped string, stage it, and
      attempt a commit:

```bash
printf 'TWILIO_%s=probe-value\n' AUTH_TOKEN > secret-probe.txt
git add secret-probe.txt
git commit -m "probe: should be blocked"
```

*Expected:* the commit is **rejected** with
`🔒 PRE-COMMIT BLOCKED: secret-shaped content staged!` and a non-zero exit.

- [ ] Clean up: `git rm --cached secret-probe.txt && rm secret-probe.txt`.
- [ ] The scanner is shape-based and covers Twilio SID/auth-token and
      `JWT_SECRET`/`METRICS_TOKEN` assignments, long base64 blobs (Firebase
      service-account bodies), FCM server keys, Google API keys, AWS access
      keys, JWTs and PEM private keys. It allowlists empty `.env.example`
      values, `CHANGE-ME` placeholders, the test suite's fake credentials and
      `process.env.*` reads.
- [ ] **Do not use `--no-verify` to get past it.** If it fires on a real
      secret, move the secret to a gitignored `.env`. If the secret already
      entered history, **rotate it** — deleting the file does not un-leak it.

### 4.5 Scan history (this is drill I2)

- [ ] After the first commit, history is clean by construction. To verify:

```bash
git log --all -p | grep -nE 'TWILIO_AUTH_TOKEN *= *[^"[:space:]]|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}'
```

*Expected:* no hits, or hits only on allowlisted placeholders (`""`,
`CHANGE-ME`, the test fixtures). Record the command and its empty output as
the I2 evidence.

- [ ] If you later import an existing history, scan it before pushing and
      rotate anything found.

---

## 5. After configuration — what to re-run

- [ ] `cd backend && npm run test:db:up && npm test` → still 74 passed, 1 skipped.
- [ ] `npm run demo:reset` → 0 active, 3 resolved; PM2 restarts `api`+`worker`
      and the Prometheus counters zero. Grafana panels read 0, not stale totals.
- [ ] Load Grafana **variant B** (`hostel-emergency-configured`) now that both
      channels exist. Variant A (`hostel-emergency`) remains correct for any
      environment where they do not — do not delete it.
- [ ] Work through `docs/MANUAL_TESTS.md` §§1–5 on real devices and record the
      sign-off table.
- [ ] Re-run the affected dry-run drills and update `docs/DRY_RUN_REPORT_V2.md`:
      **C4/C5** SKIP → PASS (emulator), **I2/I3** SKIP → PASS (git),
      **D1/D2/D3/D4/D6** SKIP → PASS (FCM, with device details),
      **E2** delivery leg and **E9** SKIP → PASS (Twilio, with recorded message
      SIDs). Every other drill should be unchanged — if one regresses, that is a
      new finding, not a configuration side effect.
- [ ] Optional, off by default: the history index proof.
      `RUN_INDEX_TEST=true npm test -- tests/index.test.ts` (~15s, seeds 5,000
      rows, asserts `Index Scan using idx_alerts_status_created`, cleans up).
      See `docs/MANUAL_TESTS.md` §7.1. For demo evidence run
      `npx tsx scripts/perf-seed.ts` instead — it captures the plans and deletes
      what it seeded.

---

## 6. Sign-off

| Section | Done by | Date | Evidence recorded (SID / project id / AVD / commit) | Result |
|---|---|---|---|---|
| 1. Twilio | | | message SID + `delivered` status | ☐ pass ☐ fail |
| 2. FCM | | | Firebase project id + device/OS/browser | ☐ pass ☐ fail |
| 3. Android emulator | | | AVD name + 4 screenshots | ☐ pass ☐ fail |
| 4. Git + secret scan | | | commit sha + blocked-probe output | ☐ pass ☐ fail |
| 5. Re-runs | | | suite summary + V2 report updated | ☐ pass ☐ fail |

A section passes only when every checkbox in it is ticked **and** its expected
outcome was observed. Partial passes must name the step that failed.

**Secrets hygiene for this document:** record SIDs, project ids and commit
shas here — never an Auth Token, a service-account JSON, a base64 credential
or a VAPID private key. This file is committed.