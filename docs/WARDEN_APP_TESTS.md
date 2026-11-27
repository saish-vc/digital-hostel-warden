# Warden App — Test Evidence

Date: 2026-11-27. Host: Windows 11, Flutter 3.47.2 / Dart 3.13.2, Java 17,
compileSdk 36, Node 24, backend on localhost (PM2 + Docker Postgres/Redis).

Verdict: **code verification PASS. Physical-device and delivery drills are
SKIP because no Android device or emulator exists on this machine.**
`adb` and `emulator` are not on PATH (`adb: command not found`,
`emulator: command not found`). Nothing below is reported as passing on a phone.

## 1. Automated checks actually run

| Check | Command | Result | Evidence |
|---|---|---|---|
| Flutter static analysis | `flutter analyze` | **PASS** | `No issues found! (ran in 26.5s)` |
| Flutter unit/widget tests | `flutter test` | **PASS 16/16** | `00:02 +16: All tests passed!` |
| Backend TypeScript build | `npm run build` | **PASS** | `tsc` exits 0 |
| Backend suite on this branch | `npx vitest run --exclude tests/startup-guard.test.ts` | **PASS 111, SKIP 1** (112) | `Tests 111 passed | 1 skipped (112)`; the skip is the opt-in `tests/index.test.ts`. A plain `npm test` on the working tree reported 120 because 9 unrelated, uncommitted `startup-guard` tests were present; they are not part of this branch. |
| Push payload suite | `npx vitest run tests/push.test.ts` | **PASS 7/7** | includes `targets the native alert channel, sound and 5-minute TTL` |
| Firebase project preflight | `node warden_app/tools/check_firebase.mjs` | **PASS** | backend project `hostelguard-warden` = google-services project; package `com.hostelguard.warden` = Gradle applicationId |
| Debug APK | `flutter build apk --debug` | **PASS** | `Built build/app/outputs/flutter-apk/app-debug.apk` (182 MB) |
| Release APK with R8 | `flutter build apk --release --dart-define=API_BASE_URL=https://as7us.tailc07926.ts.net` | **PASS** | `app-release.apk (54.9MB)`, SHA-256 `7014034c4d5aa2a4cf7ab22196d940247e8f9add96492a4b7756121c8359f7a0` |
| Staged secret scan | `gitleaks git --staged --config .gitleaks.toml` | **PASS — 0 findings** | `no leaks found` |
| Repo scanner | `node backend/scripts/secret-scan-check.cjs` | **PASS — CLEAN 0** | `SECRET SCAN: CLEAN — 0 hits` |
| Dashboard/student untouched | `git status --porcelain warden-dashboard student_app` | **PASS** | 0 lines |
| Firebase credential ignored | `git check-ignore -v ...` | **PASS** | `warden_app/.gitignore:3:google-services.json`, `backend/.gitignore:5:.env` |

Flutter test coverage: tolerant alert/leave parsing (unknown type, missing
optional fields, leave-SOS block), board counters, unseen banner, server-
confirmed acknowledge, 409 conflict, resolve, `alert:new` dedupe,
`alert:escalated`, `alert:escalation_failed`, formatting and the
escalation-pill honesty rule.

Backend push assertions: `android.priority=high`, `android.ttl=300000`,
`channelId=warden_alerts`, `sound=default`, `priority=max`,
`visibility=public`, `tag=alert-<id>`, and the unchanged
`webpush.headers {Urgency:high, TTL:"300"}`. Web Push payload construction is
proven unchanged; actual dashboard web push was not exercised (its
`VITE_FIREBASE_*` values are placeholders).

## 2. Drill table

| # | Drill | Result | Evidence / reason |
|---|---|---|---|
| 1 | Flutter analyze / tests | **PASS** | §1 |
| 2 | Backend build + full suite + push tests | **PASS** | §1 |
| 3 | Debug and R8 release APK compile | **PASS** | §1 |
| 4 | Firebase projects/packages match | **PASS** | §1 |
| 5 | Android payload adds channel/sound/TTL, web payload unchanged | **PASS** | §1 unit assertion |
| 6 | No secrets staged; real Firebase config ignored | **PASS** | §1 |
| 7 | Login from a device against the local backend | **SKIP** | no device/emulator; `adb` unavailable |
| 8 | Auth 429 shows Retry-After minutes | **SKIP** | code path present; not exercised live (10/15 min limiter would be tripped) |
| 9 | FCM token registered / refreshed / deleted on logout | **SKIP** | needs a device; backend endpoints are covered by the suite |
| 10 | SOS notification foreground / background / killed | **SKIP** | needs a device |
| 11 | Notification tap lands on the right alert (cold + warm) | **SKIP** | needs a device |
| 12 | Stale push after resolve shows "already handled" | **SKIP** | `AlarmScreen` refetches before trusting the payload; not observed on device |
| 13 | Duplicate suppression | **PARTIAL** | controller dedupe PASS in unit test; deterministic tray id not device-tested |
| 14 | `FIREBASE_SERVICE_ACCOUNT_B64` unset still returns 201 + app shows "not registered" | **SKIP** | requires restarting the live PM2 services (confirmation gate); startup warning path is unchanged from baseline |
| 15 | Ack from the phone updates the web dashboard live | **SKIP** | needs a device |
| 16 | Two-warden race (409 shown, no crash) | **SKIP** | controller handles 409 (unit PASS); no second device |
| 17 | Resolve with a 3–500 note | **SKIP** | dialog enforces bounds; not submitted from a device |
| 18 | Ack cancels the 60 s escalation | **PARTIAL** | proven by the existing backend suite; not re-observed from the phone |
| 19 | Redis down still returns 201 for POST /alerts | **SKIP** | not re-run in this change set; baseline evidence in `docs/DRY_RUN_REPORT_V2.md` |
| 20 | Airplane mode → reconnect refetch | **SKIP** | needs a device |
| 21 | Doze via `adb deviceidle` | **SKIP** | `adb` unavailable |
| 22 | Channel muted / notifications denied banner | **SKIP** | UI implemented; not seen on a device |
| 23 | Battery-optimisation status + exemption flow | **SKIP** | native method compiles; OEM behaviour unverified |
| 24 | On-duty foreground service | **SKIP** | compiles into both APKs; not run on a device |
| 25 | Full-screen alarm + sound while screen off | **SKIP** | compiles; Android 14+ full-screen-intent permission still unverified |
| 26 | Release denies cleartext | **PARTIAL** | release network security config denies cleartext by inspection; runtime block not observed |
| 27 | FCM delivery end to end | **SKIP** | no device/emulator, and no test token was registered |
| 28 | OEM battery killers (Xiaomi/Oppo/Samsung) | **SKIP** | requires physical OEM hardware |

No SKIP hides a code failure. Rows 7–28 need a phone (and for 27, a real FCM
token); everything that can be verified without one is PASS.

## 3. Before any rollout

1. Connect one physical Android phone with USB debugging (or install the APK
   manually) and run rows 7–12, 14–17, 19–22, 26–27.
2. Run row 25 with the screen locked and the app swiped away.
3. Run row 22 with the channel muted and with notifications denied.
4. Run row 24 for a full shift, including backgrounding and a reboot.
5. Only then run rows 23 and 28 on each OEM model, and only then plan the
   production Firebase project (`docs/WARDEN_APP_RUNBOOK.md` §3–§4).
