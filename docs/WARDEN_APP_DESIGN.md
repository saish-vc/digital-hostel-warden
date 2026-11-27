# HostelGuard Warden — Native Android App Design (Step 0)

Status: **implemented (Phases 0–7 code complete; physical-device drills pending).**
See `docs/WARDEN_APP_TESTS.md` for the evidence and every SKIP, and
`docs/WARDEN_APP_RUNBOOK.md` for operations. Backend push is now initialized
on `hostelguard-warden` and carries the additive Android channel/TTL block.
Branch: `wardedn-application` (spelling kept exactly as requested).
Base commit: `ed09dc7`.
Author: Step 0 inventory + contract extraction, 2026-11-26.

This document is the gate artifact for the warden app work. It records (a) what
exists today, (b) the exact API/socket/push contract a native client must honour,
(c) the proposed client design, (d) the Firebase/GCP provisioning plan, and
(e) every place where the brief, the code and the docs disagree. Nothing here
authorises a change; the changes listed in §14 need an explicit go-ahead.

---

## 1. Scope

In scope

- A new Flutter Android app, `warden_app/`, that reaches feature parity with the
  web warden dashboard (`warden-dashboard/`): login, live alert board, alert
  detail (acknowledge / resolve / tap-to-call / map), history with CSV export,
  leave approval + gate departure/return.
- Native push: FCM Android notifications, deep link into the alert, in-app
  banner + audible cue, and the existing server-driven "SMS sent" pill.
- A single additive change in `backend/src/services/push.service.ts` (Android
  channel / sound / TTL) plus its tests.
- Documentation for build, install and Firebase setup.

Out of scope / untouched

- `warden-dashboard/` and `student_app/` — zero file changes.
- Routes, response shapes, socket event names/payloads, Prisma schema and
  migrations, BullMQ/escalation behaviour, rate limiters, CORS, PM2 topology,
  nginx config, env-var names.
- Web push for the dashboard (stays on placeholder config as documented).
- Student-side push, WhatsApp/SMS provider changes, escalation ladder, IVR.
- Billing/plan upgrades, Owner/Editor IAM roles, key exposure, deleting any
  existing cloud resource, touching any Firebase project that is not the one
  approved at the gate.

---

## 2. Step 0 inventory (measured on this laptop)

| Area | Value |
|---|---|
| OS | Windows 11 Home Single Language, 26H2, build 10.0.26300.9974, locale en-IN |
| Node / npm | v24.18.0 / 11.16.0 |
| Java | OpenJDK 17.0.12 LTS |
| Flutter / Dart | 3.47.2 stable / Dart 3.13.2 (assets mirror `storage.flutter-io.cn`) |
| Android SDK | platforms 35, 36; build-tools 36.0.0; `adb` present |
| Android devices | **none** (`adb devices` empty) |
| Emulators | **none installed** (`emulator -list-avds` not available) |
| Flutter devices | Windows desktop, Chrome, Edge only (no Android target) |
| `firebase` CLI | **not installed** |
| `gcloud` CLI | **not installed** |
| `gitleaks` | 8.30.1 installed, not wired to the hook |
| Git hooks | `core.hooksPath=.husky`, custom grep secret scan (not gitleaks) |
| Signed-in console | Firebase console reachable, 2 unrelated projects visible |
| Firebase projects visible | `StudySync`, `positive-force-dw1xt` — **neither is HostelGuard** |
| `warden_app/` | does not exist |
| PM2 | `api`×3 (3001/3002/3003, cluster), `worker` (fork, metrics 4001), `leave-worker` (fork) — all online, 0 restarts |
| Docker | Postgres 16 + Redis 7 healthy; Prometheus/Grafana/Alertmanager up |
| nginx | 1.31.8 serving `:8080` (SPA + `/api` regex + WS upgrade) |
| Public entry | `https://as7us.tailc07926.ts.net` → Funnel → nginx `:8080` → API 3001–3003 |
| Local entry | `http://localhost:8080` |
| LAN / Tailscale | `192.168.31.34` / `100.93.25.2` |
| `/health` | ok (redis ok, db ok) on 3001, 3002, 3003 and via nginx |
| `backend/.env` | `FIREBASE_SERVICE_ACCOUNT_B64` **absent**, `DASHBOARD_URL` absent, `SMS_PROVIDER` unset, `JWT_EXPIRES_IN=7d` |
| FCM today | **not configured** — push disabled, log: `[firebase] FIREBASE_SERVICE_ACCOUNT_B64 is not set — push notifications are disabled` |
| Secret ignores | `.env`, `.env.*`, `firebase-service-account.json`, `*.pem`, `*.p12` ignored; **`google-services.json` is not ignored** |

Not installed, and not required by the plan: `firebase-tools`, `gcloud`,
Android emulator, Visual Studio C++ workload. Console-only provisioning avoids
global installs entirely (see §14).

---

## 3. Locked invariants the app must respect

These are load-bearing and must not be "improved" while adding the client:

1. **SOS is fail-open.** `POST /alerts` returns 201 even if Redis/FCM/BullMQ are
   down; push and escalation are fire-and-forget. The app must never gate the
   SOS path on push permission.
2. **60 s SMS escalation** is server-side only. `alert.escalatedAt` is the only
   source of the "SMS sent" pill. No client timer, no local inference.
3. **Server-confirmed UI states.** Acknowledge/resolve only apply after a 2xx;
   leave actions re-fetch after success. (The web UI is optimistic for resolve
   with rollback; the native app will be strictly server-confirmed — a
   deliberate, documented deviation, see §11.)
4. **Resolve requires ACKNOWLEDGED.** `PATCH /alerts/:id/resolve` returns
   `409 {error:"invalid_transition",current,allowed:["ACKNOWLEDGED"]}` from
   PENDING; repeated resolve of a RESOLVED alert is a 200 no-op. Resolve note is
   **3–500 chars** (docs saying 10–500 are stale).
5. **New-alert banner** on any non-Active tab, and it must not suppress the
   alarm cue.
6. **Socket transport is WebSocket-only on clients**; server stays
   transport-agnostic and nginx remains round-robin (no sticky sessions).
7. **Stateless JWT**: no refresh endpoint, no revocation, no logout server call.
   Token expiry is the only invalidation.
8. **Separation of Redis connections** (BullMQ, adapter pub, adapter sub,
   limiter, fail-fast limiter) and the PM2 worker remains `instances:1`,
   `exec_mode:"fork"`.
9. **No secrets in git.** Never commit `.env`, service-account JSON, base64
   credentials, keys, tokens. Pre-commit scans staged files.
10. **Additive backend change only**: `push.service.ts` (+ tests). No route,
    payload, DB, queue or limiter edits.

---

## 4. HTTP contract used by the warden app

Base URL is injected at build time (`--dart-define=API_BASE_URL=...`), mirroring
`student_app/lib/config.dart:5-9`. All paths are as-is (no `/api` prefix on the
API; nginx strips `/api`). JSON only, `Authorization: Bearer <jwt>`.
Body size limit is 10 kb (`400`/`413` on oversize).

Global limiter: 100 req/60 s/IP, excluding `/health*` and `/metrics`. The app
therefore uses sockets for live updates and manual refresh — **no polling loop**.

### 4.1 Auth

| Call | Body | Success | Failure |
|---|---|---|---|
| `POST /auth/login` | `{email, password, role:"WARDEN"}` | `200 {token, user:{id,name,role}}` | `400 {error}`, `401 {error:"Invalid credentials"}`, `429 {error:"rate_limited",retryAfter:900}` |

- Token: HS256 JWT, claims `id`, `role`, `iat`, `exp`; expiry `JWT_EXPIRES_IN`
  (7 d). No `name` claim → keep `user.name` from the login response.
- Limiter: 10 attempts / 15 min / IP (`authLimiter`). Fails open if Redis is down.
- There is **no** `/me`, refresh, or logout endpoint. On any `401` the app must
  clear the session and return to login.
- `user` has no `hostelBlock`; the app must not display one.

### 4.2 Alerts (warden)

| Call | Notes |
|---|---|
| `GET /alerts?status=CSV&limit=N` | `status` ∈ `PENDING,ACKNOWLEDGED,RESOLVED` or `ALL`; `limit` 1–1000, default 500; newest first. Returns `Alert[]`. Send no `status` for "All", `status=PENDING,ACKNOWLEDGED` for "Active". |
| `PATCH /alerts/:id/acknowledge` | no body. `200 Alert`. `404`; `409 {error:"Alert is already <STATUS>"}`. Cancels the escalation job. |
| `PATCH /alerts/:id/resolve` | `{resolutionNote}` 3–500 trimmed. `200 Alert`; `409 invalid_transition` from PENDING; idempotent 200 when already RESOLVED. |
| `GET /alerts/history` | `page≥1`, `limit` 1–100 (default 25), `status` CSV, `from`/`to` ISO 8601, `studentName` substring. `200 {data:HistoryRow[], pagination:{page,limit,total,totalPages}}`. |
| `GET /alerts/history.csv` | same filters; streamed `text/csv`. |
| `GET /alerts/:id/escalation-status` | `200 {scheduled,jobState,firedAt}`; `503 escalation_status_unavailable`. Optional for the app (dashboard does not call it). |

`Alert` shape (exact field names):

```
id, studentId, organizationId, type, status,
latitude, longitude, locationAccuracy,
createdAt, acknowledgedAt, acknowledgedBy, resolvedAt, resolutionNote,
escalatedAt,
student: { id, name, roomNumber, emergencyContact, medicalConditions }
```

`type` values from SOS: `MEDICAL | FIRE | SECURITY | MENTAL_HEALTH | OTHER`.
Leave-SOS alerts use `OFF_CAMPUS_LEAVE:<TYPE>` — the app must render unknown
types without crashing.

`HistoryRow`: `id, type, status, createdAt, acknowledgedAt, resolvedAt,
resolutionNote, acknowledgedByName, student{id,name,roomNumber}`.

### 4.3 Leaves (warden)

| Call | Notes |
|---|---|
| `GET /leaves/stats` | `{pendingApprovals, currentlyAway, approvedPasses, overdueCount}` |
| `GET /leaves?page&limit&status&type&studentName&from&to` | `200 {data:Leave[], pagination}`; limit ≤ 100 |
| `GET /leaves/active` | status `DEPARTED`, `expectedReturn asc` |
| `GET /leaves/overdue` | `OVERDUE`, or `DEPARTED` past `expectedReturn` |
| `PATCH /leaves/:id/review` | `{status:"APPROVED"|"REJECTED", reviewRemarks?≤500}`; only from `SUBMITTED`, else `409`; approve returns `gatePassCode` (`HG-XXXXXX`) + `gatePassQr` |
| `POST /leaves/:id/gate-departure` | `{gatePassCode}`; requires `APPROVED`; wrong code → `400`; sets `DEPARTED` + `actualDeparture` |
| `POST /leaves/:id/gate-return` | no body; requires `DEPARTED|OVERDUE`; sets `RETURNED` + `actualReturn` |

All leave paths also exist under `/leave` (alias mount). The app will use
`/leaves` only.

`Leave` shape (exact):

```
id, studentId, type, reason, destination, emergencyContact,
departureTime, expectedReturn, actualDeparture, actualReturn, status,
parentConsent, gatePassCode, gatePassQr, reviewedBy, reviewedAt,
reviewRemarks, createdAt, updatedAt,
student: { id, name, email, roomNumber, emergencyContact, medicalConditions },
reviewer: { id, name, email, hostelBlock } | null
```

Statuses: `SUBMITTED, APPROVED, REJECTED, DEPARTED, RETURNED, OVERDUE,
CANCELLED`. Types: `DAY_OUTING, NIGHT_OUT, HOME_VISIT, MEDICAL`.

### 4.4 Push token registration

| Call | Body | Success |
|---|---|---|
| `POST /wardens/fcm-token` | `{token, userAgent?}` (token ≤4096) | `200 {ok:true, id}` — upsert by unique token, updates `lastSeenAt`, reassigns `wardenId` to the caller |
| `DELETE /wardens/fcm-token` | `{token}` **body required** | `200 {ok:true, deleted:n}` |

`DELETE` with a JSON body is unusual; Flutter's `http.delete(..., body:)` sends
it correctly, and nginx passes it through. If a future proxy drops DELETE
bodies, unregistration would silently no-op — recorded as a risk (§15).

### 4.5 Error contract

- Errors are `{error: string}`; only `invalid_transition`, `rate_limited`,
  `escalation_status_unavailable` are machine-readable codes.
- There is **no zod** in the backend; validation is hand-written. Do not assume
  a field-level error map.
- `429` from the auth limiter carries `retryAfter` seconds and a `Retry-After`
  header. Global-limiter 429s carry only the generic body.

---

## 5. Socket.IO contract

- URL: same origin, `wss://` when the API base is `https://`.
- Options: `transports:["websocket"]`, `withCredentials:true`, `autoConnect:false`,
  auth via a **callback** returning `{token}` so every reconnect re-reads the
  current token (same as `warden-dashboard/src/lib/socket.ts:8-13`).
- Handshake: rate-limited (in-memory, 10/60 s/IP) **before** auth; invalid or
  missing token → `connect_error` with `UNAUTHORIZED`. The app must treat
  `UNAUTHORIZED` as "session expired" and not retry-loop.
- On connect the server joins the socket to room `wardens` and emits
  `connected {id, role, socketId}`.

Events consumed:

| Event | Payload | Use |
|---|---|---|
| `alert:new` | full `Alert` (leave-SOS adds `offCampusLeave{leaveId,destination,reason,emergencyContact,expectedReturn}`) | prepend if unseen, count for banner, beep + local notification if in foreground |
| `alert:updated` | full `Alert` | replace row (ack, and student-side updates) |
| `alert:resolved` | full `Alert` | replace row, exit Active |
| `alert:escalated` | `{alertId, sentAt, outcome:"sent"}` | set `escalatedAt = sentAt` → show "SMS sent" pill |
| `alert:escalation_failed` | `{alertId, sentAt, outcome:"failed"}` | persistent in-app warning, **do not** clear an existing pill |
| `leave:created` | full `Leave` | banner + refetch |
| `leave:updated` | full `Leave` | refetch |
| `leave:departed` | full `Leave` | refetch |
| `leave:returned` | full `Leave` | refetch |
| `leave:cancelled` | `{id, studentId}` (wardens room) | refetch |

Reconnect rule: on every `connect`, refetch `/alerts` (and the active tab's leave
lists) to close the gap the web dashboard leaves open after a reconnect.

---

## 6. Data model facts that matter to the client

- `DeviceToken`: `id` (int PK), `wardenId` FK (cascade), `token` **unique**,
  `userAgent?`, `createdAt`, `lastSeenAt`, index on `wardenId`. One token row can
  be reassigned to a different warden if two people sign in on one device —
  the last login wins, which matches the dashboard.
- Push fan-out is **global**: every `DeviceToken` row receives every alert; no
  per-warden or per-block targeting.
- Dead tokens are deleted server-side on
  `messaging/registration-token-not-registered`, `invalid-registration-token`,
  `invalid-argument`, `sender-id-mismatch`.
- Alerts and leaves are not tenant-scoped in queries; `organizationId` is only
  written for leave-SOS. The app shows all alerts, like the dashboard.
- No enums in Prisma — statuses/types are plain strings. The client must be
  tolerant of unknown values.

---

## 7. Push design

### 7.1 Today (verified in code and env)

- `backend/src/config/firebase.ts:29-81`: single Admin app from
  `FIREBASE_SERVICE_ACCOUNT_B64`; unset → `messaging = null` + warn; success →
  `[firebase] FCM messaging initialized`.
- `backend/src/services/push.service.ts:82-105` builds:
  - `notification`: hardcoded title `🚨 Medical Emergency`, body
    `"<student> · Room <room> · <type>"`;
  - `data`: `alertId, studentId, type, latitude, longitude, url:"/alerts/<id>"`;
  - `android`: `{priority:'high'}` only;
  - `webpush`: `Urgency:high`, `TTL:'300'`, plus `fcmOptions.link` when
    `DASHBOARD_URL` is https.
- Sends in chunks of 500, retries retryable codes with 1/2/4 s jittered backoff,
  increments `fcm_sent_total{status=success|failed|stale_token}`.
- With FCM unset the app simply gets no push; sockets still work.

### 7.2 Required additive change (only backend code change)

In `buildBaseMessage`, extend `android` — nothing else changes:

```ts
android: {
  priority: "high",
  ttl: 300_000,                     // seconds→ms per firebase-admin type; 300 s, matches webpush TTL
  notification: {
    channelId: "warden_alerts",
    sound: "default",
    priority: "max",                // Android channel importance is what really decides heads-up
    visibility: "PUBLIC",
    tag: `alert-${alert.id}`,       // one tray entry per alert, updates replace it
  },
},
```

- `webpush` stays byte-identical; `notification` and `data` stay identical.
- Tests to add: `android.notification.channelId === "warden_alerts"`,
  `sound === "default"`, `ttl === 300000`, webpush TTL still `"300"`, data keys
  unchanged, title/body unchanged.
- Reason it is additive-only: the current client is a web PWA that ignores
  `android.*`; native clients need it to get a heads-up on a named channel.

### 7.3 Client-side notification rules

- Create channel `warden_alerts` ("Emergency alerts", importance **max**,
  sound default, vibration, red light, lockscreen public) on first launch,
  **before** requesting a token. FCM cannot raise the importance of a channel it
  auto-creates; the channel must exist first.
- Android 13+: request `POST_NOTIFICATIONS` after login. Denied → in-app banner
  ("Notifications blocked — background alerts will not ring"), same intent as
  the dashboard's denied banner. Do not block login or the board.
- Foreground: `onMessage` → local notification on the same channel (so sound and
  importance match background) **and** in-app banner + beep, deduped by alert id
  in a 5 s window (parity with `warden-dashboard/src/lib/beep.ts:31-54`).
- Background/killed: the system tray entry comes from the FCM `notification`
  block. Data-only was rejected: delivery to a killed app is not guaranteed and
  would lose the alarm.
- Tap: prefer `message.data.alertId`; fall back to `data.url` (`/alerts/<id>`).
  Handle cold start (`getInitialMessage`), warm (`onMessageOpenedApp`) and
  in-app banner taps. Always refetch the alert before showing detail (the tray
  payload can be stale).
- TTL 300 s on both transports; if the phone was offline >5 min the alert is
  dropped by design (same as today's web push).
- The notification title is hardcoded "Medical Emergency" for every type. Fixing
  that would change shared push content beyond the additive scope, so it stays;
  the in-app UI always shows the real `type`. Recorded in §15.

---

## 8. Screen plan (parity + native deltas)

1. **Login** — email/password, role hardcoded `WARDEN`, inline error, 429 shows
   "try again in N min". Demo hint line only in debug builds. On success:
   persist session, register FCM token (best-effort, never blocking).
2. **Alerts board** — segmented filter Active / Resolved / All (Active =
   PENDING + ACKNOWLEDGED), counters Active / Responding / Resolved today
   (local calendar day), alert list (type, student, room, time HH:mm:ss, GPS
   badge, status pill), selected-detail panel on tablets / full-screen detail on
   phones. Pull-to-refresh. Connection indicator Live / Reconnecting /
   Disconnected. Red unseen-PENDING banner while on a non-Active filter; tapping
   switches to Active; the alarm cue still fires.
3. **Alert detail** — student + room, type, status, elapsed time, coordinates to
   5 dp + `±Nm`, map, emergency contact with `tel:` tap-to-call, medical notes,
   Acknowledge (PENDING only), Resolve (ACKNOWLEDGED only, dialog, 3–500 chars,
   live counter), "SMS sent" pill from `escalatedAt`, escalation-failure banner.
4. **History** — date/time, student, room, type, status, acknowledged-by,
   resolved-at, note; filters status / from / to / student name; server-side
   paging 25; CSV export via share sheet.
5. **Leaves** — 4 stat cards, tabs Pending / Approved / Currently away /
   Overdue / History (pills All/Rejected/Cancelled/Returned); review modal
   (destination, contact, times, reason, note ≤500) with Approve/Reject and the
   returned gate code; gate-departure modal with code (uppercased) and
   gate-return action; new-request banner; refetch after every leave event.
6. **Settings (native-only, minimal)** — account, notification permission state,
   channel shortcut (system settings), connection state, app version, logout
   (unregister token + clear session).

Deliberate native deltas from the web app (each documented in the app):
strict server-confirmed mutations (§11), refetch on socket reconnect, local-day
(not UTC) history date filters, secure token storage, no CSV download-to-disk
(share sheet instead), no browser deep-link routing (Firebase message taps).

---

## 9. Client architecture

```
warden_app/
  lib/
    main.dart                 // init Firebase, create notification channel, AuthGate
    config.dart               // API_BASE_URL dart-define + socket URL, app version
    theme.dart                // dark board theme, status colours
    models/                   // alert.dart, leave.dart, history.dart, session.dart
    services/
      api.dart                // HTTP client, ApiException(status,code,retryAfter)
      session.dart            // secure storage, login/logout, 401 hook
      socket.dart             // single socket, callback auth, event fan-out
      push.dart               // FCM token, channel, permission state, tap routing
      notifications.dart      // flutter_local_notifications channel + foreground show
      beep.dart               // asset tone + 5 s dedupe (foreground FCM/socket)
      formatting.dart         // intl date/time, lateBy, elapsed
    state/
      alerts_controller.dart  // list, filters, counters, unseen banner, actions
      leaves_controller.dart  // stats, four lists, history, actions
      connection.dart         // socket state
    screens/                  // login, board, alert_detail, history, leaves, settings
    widgets/                  // alert_card, status_pill, escalation_pill, map,
                              // connection_dot, empty_state, error_banner
  android/
    app/google-services.json  // gitignored, generated from the approved project
    app/build.gradle.kts      // applicationId, minSdk 24, release = debug signing (dev)
```

Dependencies (project-local only; no system-wide installs):
`http`, `socket_io_client`, `flutter_secure_storage`, `shared_preferences`,
`firebase_core`, `firebase_messaging`, `flutter_local_notifications`, `intl`,
`flutter_map` + `latlong2`, `url_launcher`, `share_plus`, `package_info_plus`.

State: `ChangeNotifier` controllers + a small service locator. No state-management
framework, no code generation — keeps the app auditable and keeps the build fast.

Identity: `applicationId com.hostelguard.warden`, label `HostelGuard Warden`,
`minSdk 24`, `targetSdk 36`, `compileSdk 36`, version `1.0.0+1`. Dev builds sign
with the debug keystore (same approach as `student_app`); a real release keystore
is a separate, later approval.

Networking: one `http.Client`, 15 s timeout, JSON decode, `ApiException` carrying
status + server `error` + `retryAfter`; 401 → clear session + login; 409 →
surface the transition message and refetch; 429 → countdown on the action.
No retry of mutating calls (avoids double acknowledge/resolve); GETs retried
once on socket/timeout only.

Deep-link/no-network behaviour: cached last board snapshot in
`shared_preferences` (non-sensitive) so a cold start without network shows the
last state with a "stale" badge; the app never fabricates alert state.

---

## 10. Build, sign, distribute

```
flutter create --org com.hostelguard --project-name warden_app --platforms android warden_app
flutter pub get
flutter analyze
flutter test
flutter build apk --release --dart-define=API_BASE_URL=https://as7us.tailc07926.ts.net
```

- Default `API_BASE_URL` is `http://10.0.2.2:3001` (emulator); device builds pass
  the public URL. Cleartext HTTP is debug-only; release requires https.
- Output: `build/app/outputs/flutter-apk/app-release.apk`; report size + SHA-256,
  publish under `warden-dashboard/dist/` (that directory is build output and
  gitignored — the served artifacts live there, the source tree is untouched),
  and generate a QR like the student APKs. Serving files from `dist/` is a
  deployment artifact step, not a dashboard source change; it is listed at the
  gate.
- Install is manual by the user (`adb install -r` only when a device appears).

Verification that must be shown as real output, not claimed:

1. `flutter analyze` clean, `flutter test` green.
2. Backend `npm run build` + `npm test` green after the push change.
3. `[firebase] FCM messaging initialized` in the API and worker logs after restart.
4. A real device token registered (`POST /wardens/fcm-token` → row in
   `DeviceToken`) and an alert producing a tray notification with sound on the
   channel, plus tap-through to the right alert.
5. Acknowledge → pill/resolve flow observed against the live board, socket
   updates visible within ~1 s.

---

## 11. Deliberate deviations from the web dashboard

| Area | Web | Native | Why |
|---|---|---|---|
| Resolve | optimistic + rollback | wait for 200, then apply | "server-confirmed UI states" requirement; avoids the transient wrong card |
| After socket reconnect | no refetch | refetch board + leaves | closes a real staleness gap |
| History date filter | date → UTC day bounds | local day bounds → ISO with offset | web bug shifts ranges for non-UTC users |
| Token storage | `localStorage` | Android Keystore via `flutter_secure_storage` | token is a bearer credential |
| CSV | blob download | share sheet | no filesystem downloads on Android |
| Notification denied | banner | banner + link to system settings | Android needs a settings intent |
| Session expiry | message only | force logout on 401/UNAUTHORIZED | stateless JWT has no refresh |

---

## 12. Contract contradictions found in Step 0

Code and docs disagree in these places. The app follows **code**, not prose.

1. **"Native warden app is out of scope"** — architecture doc `:150-156, :291`
   and `docs/FUTURE_WORK.md:57-58` say a warden mobile app is future work; this
   task supersedes that. Docs must be updated in the same change set, or the
   repo will contradict itself.
2. **`DeviceToken` is not "token + userAgent only"** — also `id`, `wardenId`,
   `createdAt`, `lastSeenAt`, plus an index (`schema.prisma:91-101`).
3. **Server accepts polling** — `transports` is unset server-side
   (`app.ts:309-314`); "websocket-only" is a client and nginx convention only.
   Keep the native client WebSocket-only.
4. **Push has no `channelId`/`sound`/`android.ttl`** — confirmed
   (`push.service.ts:99-103`); that is exactly the additive change in §7.2.
5. **No zod** — validation is manual; error bodies are prose, not field maps.
6. **Resolve note length** — code/UI 3–500; roadmap/progress say 10–500
   (`PROJECT_ROADMAP.md:45`, `progress.md:236`).
7. **`DELETE /wardens/fcm-token` needs a body** — proxies that strip DELETE
   bodies would break unregistration.
8. **`POST /leaves/:id/emergency` bypasses `sosLimiter`** and is still subject to
   the global 100/60 s limiter, so an SOS can get a generic 429 from the global
   limiter. Server-side issue; not changed here.
9. **`escalation-status.firedAt`** is BullMQ `processedOn` (job start), not send
   completion, despite the comment (`alert.routes.ts:977-998`).
10. **`google-services.json` is not gitignored** while the brief assumes it is
    handled; the pre-commit hook scans for Google API keys, so a committed
    `google-services.json` would be flagged. Needs an ignore rule (§14).
11. **Stale port 4000** in `progress.md:352-365` and `docs/MANUAL_TESTS.md:16`;
    the real port is 3001.
12. **Rabbit-hole to avoid**: docs describe FCM *web* push for the dashboard;
    native FCM is a new delivery path and does not enable dashboard push.

---

## 13. Test plan (phased, evidence-based)

| Level | What | How |
|---|---|---|
| Unit | models from real payload fixtures; formatting; filter/counter logic; unseen banner; error mapping (401/409/429) | `flutter test` |
| Widget | login validation, board filters, resolve dialog bounds, leave review/gate modals | `flutter test` |
| Contract | one live round-trip per endpoint against local nginx using a warden JWT; assert exact field names | scripted + shown output |
| Socket | `alert:new/updated/resolved/escalated/failed` and leave events; reconnect refetch; UNAUTHORIZED logout | live local stack |
| Push | token register/unregister; foreground vs background; channel sound; tap routing cold/warm | requires a real Android device |
| Regression | backend `npm test` (121 declarations baseline), build, coverage ≥70 | local |

Device coverage: one physical Android phone (nothing else is available; no
emulator). Android 13+ notification permission path must be exercised. If no
device is available, push and tray behaviour stay **unverified** and will be
reported as such.

---

## 14. Firebase/GCP provisioning plan — needs the gate

**Discovered projects:** `StudySync` and `positive-force-dw1xt`. Neither belongs
to HostelGuard; both are off-limits.

Recommended: **create a new, dedicated project** (proposed id
`hostelguard-warden`, console will suffix if taken) on the free Spark plan.

Mutations that require approval (each done once, in this order):

1. Create the new Firebase project (no billing, no plan change).
2. Register Android app `com.hostelguard.warden` (nickname `HostelGuard Warden`),
   download `google-services.json`.
3. Create a service account `fcm-warden-push` restricted to Firebase Cloud
   Messaging, download its JSON key **once**.
4. Base64 the key into `backend/.env` via a non-echoing script in the temp dir:
   `git check-ignore` first, never print, secure-delete the temp copy.
5. Add ignore rules: `google-services.json` (root + app), and the temp key path.
   Root `.gitignore` only; no dashboard/student-app file is touched.
6. Restart PM2 `api` + `worker` so `firebase.ts` re-initialises; expect
   `[firebase] FCM messaging initialized` and `push.service` resolving the new
   config.

Rejected alternatives: reusing `StudySync`/`positive-force-dw1xt` (unrelated
projects, shared blast radius, and it would require entering projects the brief
forbids touching).

No global CLI install is needed: project, Android app and service account can all
be created in the Firebase console. If you prefer `firebase-tools`/`gcloud`,
that is a separate system-wide install approval.

Explicitly won't happen: billing/Blaze upgrade, Owner/Editor grants, key
commits, disabling 2FA, deleting resources, touching the two existing projects,
changing dashboard Firebase placeholders.

### 14.1 Provisioning record (executed 2026-11-27, approved at the gate)

| Item | Value |
|---|---|
| Firebase project | `hostelguard-warden` ("HostelGuard Warden"), Spark plan, no organisation, Analytics and Gemini disabled |
| Project number | `528341685927` |
| Android app | `com.hostelguard.warden`, app id `1:528341685927:android:8e73c9f5a20c73dd616d82` |
| Config file | `google-services.json` generated, kept outside git, installed at `warden_app/android/app/` |
| Service account | `fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com`, role **Firebase Cloud Messaging API admin** only |
| Key | one JSON key, id `c65e0fbf4b3a…`, base64 in `backend/.env` as `FIREBASE_SERVICE_ACCOUNT_B64`, temp copy overwritten and deleted |
| Ignore rule | root `.gitignore` now ignores `google-services.json` |
| Restart | PM2 `api`×3 + `worker`; each API logged `[firebase] FCM messaging initialized` with `"project":"hostelguard-warden"` |
| Verified | `git check-ignore` covers `.env` and `google-services.json`; `/health` ok on 3001–3003 and `https://as7us.tailc07926.ts.net/health` ok from an external network |

Note: the laptop rebooted mid-provisioning (08:48). Docker, PM2 and nginx do
not auto-start; they were restarted manually and the FCM key survived.

---

## 15. Risk register

| # | Risk | Impact | Mitigation | State |
|---|---|---|---|---|
| R1 | No Android device and no emulator | push, tray, tap-through, install cannot be verified | user connects a phone with USB debugging, or installs the APK manually; otherwise report push as unverified | **open** |
| R2 | Nothing OS / OEM battery managers kill FCM | missed alarms | document battery "unrestricted" setting; in-app foreground socket still updates while open; server SMS escalation remains the backstop | open |
| R3 | FCM auto-creates the channel at lower importance | no heads-up | create `warden_alerts` at max importance on first launch, before token registration | designed |
| R4 | Notification title says "Medical Emergency" for all types | misleading tray text | in-app UI shows real type; title change is out of additive scope, flagged | accepted |
| R5 | Hardcoded 3–500 resolve note vs docs 10–500 | rejected submits if client copied docs | client uses 3–500 | designed |
| R6 | `DELETE` body stripped by a proxy | stale tokens accumulate | send body via `http.delete`; dead-token cleanup on send; verify against nginx | open |
| R7 | Shared-IP rate limits (CGNAT/hostel Wi-Fi) | login 429, global 429 | socket-first, manual refresh, no polling; surface `retryAfter` | open |
| R8 | JWT expires during a shift; no refresh | forced re-login, socket `UNAUTHORIZED` loop | detect 401/`UNAUTHORIZED`, clear session, single redirect to login | designed |
| R9 | OS denies `POST_NOTIFICATIONS` | silent background alerts | permission prompt after login + persistent in-app banner | designed |
| R10 | `google-services.json` accidentally committed | secret-scan failure / key leak | ignore rules at root and app level; pre-commit check before first commit | **must fix at gate** |
| R11 | OSM tile policy / offline map | map blank or blocked | `userAgentPackageName`, attribution, graceful "map unavailable" | open |
| R12 | Global alert fan-out (no per-warden targeting) | every warden's phone rings for every alert | parity with dashboard; documented, not changed | accepted |
| R13 | Docs still say native warden app is out of scope | reviewer confusion | update architecture/FUTURE_WORK/roadmap in the same change set | planned |
| R14 | Release signing uses the debug key | not store-distributable | dev-only APK now; real keystore is a later, separate approval | accepted |
| R15 | Two wardens on one device reassign the token | the other warden stops receiving push | matches existing server behaviour; unregister on logout | accepted |

---

## 16. Phased execution plan (after the gate)

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | This doc + gate answers | approved |
| 1 | Firebase project, Android app, service account, `.env`, ignore rules, PM2 restart | `[firebase] FCM messaging initialized`; key never printed/committed |
| 2 | `warden_app/` skeleton: theme, config, session, API client, models, login | analyze clean; login against live API; token persisted securely |
| 3 | Alerts board + detail + acknowledge/resolve + map + call | live board matches `/alerts`; 409 handled; no optimistic drift |
| 4 | Socket layer + banners + escalation pill + reconnect refetch | events applied within ~1 s; `UNAUTHORIZED` logs out |
| 5 | Push: channel, permission, token register/unregister, foreground/background, tap | real tray notification with sound; tap lands on the right alert |
| 6 | History (filters, paging, CSV share) + Leaves (stats, review, gate) | parity checklist passes |
| 7 | Backend additive push change + tests | `npm test` green; payload asserted |
| 8 | Release APK, hash, QR, install/verification record | user-confirmed install; evidence pasted |
| 9 | Docs: README/HANDOFF/architecture/FUTURE_WORK/roadmap updates | no doc says "native app out of scope" |

Each phase ends with real command output; nothing is reported as working without
it.

---

## 17. Gate questions (answers recorded before Phase 1)

1. Firebase project: **create `hostelguard-warden`** (recommended) / reuse one of
   the two existing projects / different name.
2. Approve the six provisioning mutations in §14 (project, Android app, service
   account, `.env` write, ignore rules, PM2 restart) — yes/no.
3. Confirm `applicationId com.hostelguard.warden` (or supply another).
