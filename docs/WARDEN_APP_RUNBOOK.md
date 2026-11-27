# Warden App — Runbook

For "the phone is not ringing" and for rotating the Firebase credential.
Work top to bottom; stop at the first failing check. Never paste a token, key,
or service-account content into chat, an issue, or a log.

## 1. Alerts stopped arriving — check in this order

1. **Backend still logs FCM as initialized** (the most common cause is a
   restart with the env var missing):

   ```bash
   pm2 logs api --lines 200 --nostream | grep -i "firebase"
   # expected: [firebase] FCM messaging initialized ... "project":"hostelguard-warden"
   ```

   `FIREBASE_SERVICE_ACCOUNT_B64 is not set` or `failed to parse` means push is
   disabled but SOS still works (201). Fix the env, then restart `api` **and**
   `worker`.

2. **Env var present and ignored by git** (value never printed):

   ```bash
   git check-ignore backend/.env && echo "ignored"
   grep -c '^FIREBASE_SERVICE_ACCOUNT_B64=' backend/.env   # 1 expected
   ```

3. **Projects match**:

   ```bash
   node warden_app/tools/check_firebase.mjs
   ```

   Any mismatch is fatal for push: the Admin SDK and `google-services.json`
   must be the same project, and the package must be `com.hostelguard.warden`.

4. **The phone has a live token row** (read-only, truncated token):

   ```bash
   docker exec backend-postgres-1 psql -U postgres -d hostel_emergency \
     -c 'select id, "wardenId", "userAgent", "lastSeenAt", left(token, 12)
         from "DeviceToken" order by "lastSeenAt" desc limit 5;'
   ```

   No row → the warden never granted notifications or the token POST failed;
   open the app, Settings → Server registration. Re-register by signing in
   again or toggling notification permission.

5. **Sends are succeeding**:

   ```bash
   curl -s -H "Authorization: Bearer $METRICS_TOKEN" \
     http://localhost:3001/metrics | grep '^fcm_sent_total'
   ```

   `status="success"` climbing = FCM accepted the message; the problem is on
   the device. `status="failed"` climbing with a hard code = check the API log
   for `[push] chunk send refused` (credential/IAM problem).
   `status="stale_token"` = dead token deleted; re-register on the device.

6. **Device state** — in the app, Settings → Push notifications:
   Firebase permission, Android notifications, Server registration, Channel.
   Then Settings → Delivery reliability: battery optimisation must be
   Unrestricted and DND must not block the channel. Use **Send test
   notification** to prove the channel and sound locally.

7. **Isolate the path** — send one alert-shaped push to the token:

   ```bash
   node warden_app/tools/send_test_push.mjs <token> "Test" "Runbook check"
   ```

   Arrives → FCM is fine, the app/alert path is the issue. Does not arrive →
   FCM/IAM/project is the issue.

8. **OEM battery manager** — Xiaomi/Redmi: Autostart + no battery restriction.
   Oppo/Realme/Vivo: allow auto-start, disable optimisation. Samsung:
   Unrestricted. Leave the web dashboard open as redundancy.

The SMS escalation is server-side. A muted or offline phone does not stop it,
and the dashboard pill is the authoritative "SMS sent" signal.

## 2. Key rotation

The service account is `fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com`
with only `roles/firebasecloudmessaging.admin`. Two keys are not required:
create the new one, deploy it, verify, then delete the old one.

```bash
# 1. New key into the OS temp dir, never the repo
gcloud iam service-accounts keys create "$TEMP/fcm-new.json" \
  --iam-account=fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com

# 2. Base64 into backend/.env without echoing it (PowerShell example).
#    Verify git check-ignore backend/.env first.
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\fcm-new.json"))
# edit backend/.env by hand/script so FIREBASE_SERVICE_ACCOUNT_B64 holds $b64

# 3. Securely remove the temp copy, then restart and verify
Remove-Item -Force "$env:TEMP\fcm-new.json"
pm2 restart api worker
pm2 logs api --lines 100 --nostream | grep -i "FCM messaging initialized"

# 4. Delete the OLD key id (list first, never print key material)
gcloud iam service-accounts keys list \
  --iam-account=fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com
gcloud iam service-accounts keys delete <OLD_KEY_ID> \
  --iam-account=fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com
```

If a key leaks: delete it immediately (step 4), rotate, then check
`fcm_sent_total` and the API log for sends from an unknown source. Removing the
role instead of the key disables push entirely:

```bash
gcloud projects remove-iam-policy-binding hostelguard-warden \
  --member="serviceAccount:fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com" \
  --role="roles/firebasecloudmessaging.admin"
```

## 3. Environments

| | Dev / demo (current) | Production (not created) |
|---|---|---|
| Firebase project | `hostelguard-warden` | new project, e.g. `hostelguard-prod` |
| Application id | `com.hostelguard.warden` | same id, different project |
| Debug app id suffix | **none** — only this id is registered | register if a `.dev` variant is wanted |
| Backend credential | `fcm-warden-push` key in `backend/.env` | separate service account + key in the production secret store |
| Dashboard | placeholder `VITE_FIREBASE_*` (web push unconfigured) | its own web app registration, same production project |
| APK | debug/release built here | release keystore, distributed via MDM or direct install |

Never register a production phone against the dev project, and never point a
dev backend at the production service account. A single backend Admin app
means one project per environment.

Still required before a production project is usable: create the project and
Android app, download its `google-services.json` for the release build, create
the least-privilege service account, and repeat the `check_firebase.mjs`
preflight against the production values.

## 4. Rollout

1. Dev project + debug APK on one real phone; complete the drill table in
   `docs/WARDEN_APP_TESTS.md`.
2. Production project + release APK to one warden test account for a full
   shift.
3. Run in parallel with the web dashboard (never instead of it) for at least a
   week, comparing alert latency and missed alerts.
4. Add phones/OEMs one at a time. Keep a desktop dashboard open until the
   latency evidence is boring.

## 5. Rollback

- **App**: stop distributing the APK; uninstall from duty phones. The backend,
  dashboard and SMS escalation are unchanged.
- **Backend push change**: one commit (`push.service.ts` + `push.test.ts`).
  Revert it; web push behaviour is unchanged by the Android block either way.
- **Firebase**: delete the Android app and/or the service-account key with the
  commands above. Deleting the whole project (`gcloud projects delete
  hostelguard-warden`) is destructive and requires explicit approval.
- **Env**: remove `FIREBASE_SERVICE_ACCOUNT_B64` from `backend/.env`; the API
  keeps serving SOS with push disabled and logs the reason. Restart `api` and
  `worker`.
- **No migration, no route, no socket, no queue change** was made, so there is
  nothing else to roll back.

## 6. Health checks after any change

```bash
curl -s http://localhost:3001/health
curl -s http://localhost:8080/health
node warden_app/tools/check_firebase.mjs
pm2 status
```

Expect `db: ok`, `redis: ok`, matching Firebase projects, and no restart loop.
