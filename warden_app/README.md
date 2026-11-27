# HostelGuard Warden (Android)

Native Flutter warden client for the HostelGuard emergency system. It is the
phone-side companion to `warden-dashboard/`: live SOS board, acknowledge and
resolve, history, leave review and gate passes, plus Firebase Cloud Messaging
so an alert rings when the app is not open.

Safety rule for every screen: **the UI only states what the server has
confirmed.** The "SMS sent" pill renders from `escalatedAt`; acknowledge and
resolve apply only after a 2xx; a push payload is re-fetched before the alarm
trusts it.

## What it does

| Area | Behaviour |
|---|---|
| Auth | `POST /auth/login` with role `WARDEN`, JWT in Android Keystore (`flutter_secure_storage`), 401/UNAUTHORIZED clears the session |
| Board | Active / Resolved / All, pending-dominant counters, unseen-PENDING banner on non-active filters, pull-to-refresh, Live/Connecting/Offline socket dot |
| Alert detail | Student, room, medical notes, map, tap-to-call, Acknowledge (PENDING), Resolve dialog 3–500 chars (ACKNOWLEDGED), server-driven escalation pill |
| Realtime | One WebSocket-only socket, re-auth on every reconnect, full refetch after reconnect and on resume |
| Push | FCM high-priority notification on the `warden_alerts` channel (max importance, alarm audio attributes, full-screen intent), deterministic notification id per alert, tap routes to the alert |
| Alarm | Foreground alerts raise a full-screen alarm that rings until acknowledged or dismissed; a resolved alert shows "already handled" |
| Leaves | Stats, pending/approved/away/overdue/history, review with gate code, gate departure/return |
| History | Server-side paging and filters, CSV export via share sheet |
| Reliability | On-duty foreground service, battery-optimisation status + exemption, notification/channel/DND/full-screen settings links, persistent degraded banner |

Deliberate differences from the web dashboard: strict server-confirmed
mutations, refetch on reconnect (the web client does not), local-day history
filters, Android Keystore instead of `localStorage`, share sheet instead of a
browser download.

## Build

```bash
cd warden_app
flutter pub get

# Android emulator (default API base http://10.0.2.2:3001)
flutter run

# Physical phone on the LAN through nginx (:8080)
flutter run --dart-define=API_BASE_URL=http://192.168.31.34:8080

# Release APK against the public tunnel
flutter build apk --release \
  --dart-define=API_BASE_URL=https://as7us.tailc07926.ts.net
```

`API_BASE_URL` is compile-time. Debug builds may use cleartext HTTP via
`android/app/src/debug/res/xml/network_security_config.xml`; release builds
deny cleartext and a release build without `--dart-define=API_BASE_URL` fails
fast at startup instead of silently pointing at an emulator.

Output: `build/app/outputs/flutter-apk/app-debug.apk` (or `app-release.apk`).
Dev builds sign with the debug key — a store keystore is a separate decision.
`applicationId` is `com.hostelguard.warden` and must not change: it is
registered with Firebase.

## Firebase / FCM

- One Firebase project per environment, shared by the backend and this app.
  The backend initialises a single Admin app from
  `FIREBASE_SERVICE_ACCOUNT_B64`, so a mismatch means every push is rejected.
- `android/app/google-services.json` is generated from the approved project and
  **never committed** (root and app `.gitignore`). The tracked template is
  `google-services.json.example` with fake values.
- The app creates `warden_alerts` (max importance, alarm audio) on first launch,
  before requesting a token. The backend targets the same channel via the
  additive `android.notification` block in `push.service.ts`.
- Preflight, prints only project ids and package names:

```bash
node warden_app/tools/check_firebase.mjs
```

- Isolate "FCM broken" from "app broken" with one real push (uses the backend's
  installed firebase-admin, prints only the token suffix):

```bash
node warden_app/tools/send_test_push.mjs <device-token> "Test" "From the tool"
```

Never commit service-account JSON, its base64, `google-services.json`,
keystores, `key.properties` or `.env` files.

## Tests

```bash
flutter analyze
flutter test
```

Unit coverage: tolerant alert/leave parsing, board counters, unseen banner,
server-confirmed acknowledge/resolve, 409 handling, socket dedupe, escalation
events, formatting, escalation-pill honesty. Device-only behaviours (tray,
sound, tap-through, Doze, OEM battery managers) are tracked in
`docs/WARDEN_APP_TESTS.md`; they are not claimed as verified without a phone.

## Phone setup (do this on every duty phone)

1. Sign in once so the FCM token registers; confirm Settings says
   "Server registration: Registered".
2. Allow notifications. On Android 13+ accept the prompt.
3. Settings → Delivery reliability → **Battery exemption**. On Xiaomi/Redmi,
   also enable Autostart; on Oppo/Realme/Vivo, allow auto-start and disable
   battery optimisation; on Samsung, set the app to Unrestricted.
4. Turn on **On-duty mode** for the shift (persistent low-importance
   notification, keeps the socket alive).
5. Optional: **Hide screen in recents** blocks screenshots of medical data.
6. Keep the web dashboard open as redundancy. The SMS escalation is
   server-side and still runs if the phone is offline or muted.

## Known limits

- No iOS target. Critical Alerts need an Apple entitlement; background sockets
  are not possible.
- Push fan-out is global: every registered device receives every alert.
- The notification title is hard-coded "Medical Emergency" by the existing
  backend payload; the app always renders the real type.
- One Firebase project is provisioned (`hostelguard-warden`) and debug builds
  have no `.dev` suffix, because that app id was never registered. A production
  project and a separate debug app registration remain rollout work.
- The on-duty service uses `dataSync`; Android 15 limits that type to six hours
  per 24 h. The socket and push still work without it.
