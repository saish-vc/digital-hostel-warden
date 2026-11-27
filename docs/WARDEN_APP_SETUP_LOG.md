# Warden App — Setup Log

Actions taken to give the native warden app a working FCM path. Every row names
the actor (`agent-run` = executed here, `user-completed` = a human answered a
sign-in/consent screen that an agent must not perform), the non-secret result,
and the rollback. No key material, email addresses, or tokens are recorded.

Date: 2026-11-27. Firebase project: `hostelguard-warden`. Branch:
`wardedn-application`.

> `firebase` and `gcloud` CLIs are **not installed** on this laptop. Provisioning
> was done through the already signed-in Firebase console, so the rollback
> commands below are documented rather than executed. Install
> `google-cloud-sdk`/`firebase-tools` first if you need to run them.

| # | Actor | Action | Result (non-secret) | Rollback |
|---|---|---|---|---|
| 1 | user-completed | Signed in to the Firebase console in the existing browser session | Session available; 2 unrelated projects visible and untouched (`StudySync`, `positive-force-dw1xt`) | Sign out; no change to those projects |
| 2 | agent-run (approved at gate) | Created project **HostelGuard Warden** (`hostelguard-warden`), Spark plan, no organisation, Analytics and Gemini disabled | Project id `hostelguard-warden`, number `528341685927` | `gcloud projects delete hostelguard-warden` (destructive; not run) |
| 3 | agent-run (approved) | Registered Android app `com.hostelguard.warden`, nickname "HostelGuard Warden" | App id `1:528341685927:android:8e73c9f5a20c73dd616d82` | Firebase console → Project settings → Your apps → delete app, or `firebase apps:delete 1:528341685927:android:8e73c9f5a20c73dd616d82 --project hostelguard-warden --force` |
| 4 | agent-run (approved) | Downloaded `google-services.json` to `warden_app/android/app/` | File present, gitignored; project id matches backend | Delete the local file; it can be regenerated from the console |
| 5 | agent-run (approved) | Created service account `fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com` and granted only **Firebase Cloud Messaging API Admin** | Role `roles/firebasecloudmessaging.admin`; no Owner/Editor | `gcloud projects remove-iam-policy-binding hostelguard-warden --member="serviceAccount:fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com" --role="roles/firebasecloudmessaging.admin"` then `gcloud iam service-accounts delete fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com` |
| 6 | agent-run (approved) | Created one JSON key, id `c65e0fbf4b3a…`, base64-encoded into `backend/.env` as `FIREBASE_SERVICE_ACCOUNT_B64` after `git check-ignore backend/.env` passed; temp key overwritten and deleted | Key never printed; env var present; no key file in the repo | `gcloud iam service-accounts keys list --iam-account=fcm-warden-push@hostelguard-warden.iam.gserviceaccount.com`, then delete the key id; remove the env line without echoing it and restart PM2 |
| 7 | agent-run (approved) | Added the ignore rule `google-services.json` to root `.gitignore` (app-level rules in `warden_app/.gitignore`); added a fake-value `google-services.json.example` | `git check-ignore` covers `.env` and `google-services.json` | Revert the ignore commit (never commit the real file) |
| 8 | agent-run (approved) | Restarted PM2 `api` ×3 and `worker` | Each API logged `[firebase] FCM messaging initialized` with `"project":"hostelguard-warden"` | `pm2 restart api worker` (returns to the previous env if the env line is removed) |
| 9 | agent-run | Verified the backend account and Android config point at the same project | `node warden_app/tools/check_firebase.mjs` → PASS on project **and** package | — |
| 10 | agent-run | Verified `/health` after the restart | ok on 3001–3003 and through the public Funnel | — |

Notes

- The laptop rebooted at 08:48 during provisioning. Docker, PM2 and nginx do
  not auto-start on this host; they were restarted manually and the FCM key
  survived in `backend/.env`.
- Not done, by design: billing/Blaze upgrade, Owner/Editor grants, Analytics,
  key commits, 2FA changes, deletions, or any change to the two unrelated
  projects.
- No production Firebase project exists yet. See
  `docs/WARDEN_APP_RUNBOOK.md` §3 for the dev/prod table and what a production
  project still needs.
