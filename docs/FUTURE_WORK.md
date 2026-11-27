# Future work

Everything here is deliberately **out of scope** for the current stage. Each
item names the limit it addresses, so a reviewer can tell "not done yet" from
"not considered".

## 1. Sessions and identity

- **Refresh tokens / short-lived access tokens.** JWTs currently live 7 days
  (3 days would be better for a warden device that may be shared). Rotation,
  revocation and "log out all devices" need a token store — Redis is already
  deployed.
- **Per-warden MFA.** Warden accounts can currently sign in with a password
  only; a hostel duty phone should require a second factor.
- **Account provisioning.** Students and wardens are seeded. Real deployment
  needs an admin flow (or an SSO/IDP integration) rather than `seed.ts`.

## 2. Scaling the escalation path

- **Horizontal worker scaling.** `ecosystem.config.js` pins the worker to one
  fork process on purpose: BullMQ does not give us "exactly one SMS per alert"
  across two consumers. Scaling out needs a distributed lock (Redlock) or a
  job-ownership pattern, plus a test that races two workers on one alert.
- **Multi-region Redis / Postgres failover.** The system assumes one Redis and
  one Postgres. `noeviction` + AOF `everysec` are documented requirements, not
  enforced by code.
- **Alert storm control.** The SOS limiter has a break-glass override by
  design (never block a real emergency). A mass-casualty event still needs a
  warden-side triage queue rather than one card per alert.

## 3. Delivery channels

- **SMS provider abstraction.** Only Twilio is implemented; `SMS_PROVIDER` is
  a switch with one value. MSG91 (common in India) would need its own retry
  classification.
- **Escalation ladder.** One SMS to one on-call number after 60s. A real
  roster needs tiers (on-call → supervisor → security desk) and per-shift
  phone numbers.
- **Campus-wide push for FIRE/SECURITY.** Today push targets wardens only;
  students are not warned.

## 4. Data and compliance

- **Retention policy.** Alerts are kept forever. Medical data usually has a
  retention window and a deletion request path (GDPR/DPDP-style). No such
  endpoint exists.
- **Field-level encryption at rest.** `medicalConditions` and
  `emergencyContact` are plain columns; disk encryption is the only
  protection today.
- **Audit log for reads.** History exports are logged, but nothing records
  *which warden viewed which student's medical record*.
- **PII in logs.** Redaction covers secrets and auth headers; student names
  still appear in socket/SMS log lines.

## 5. Product / UX

- ~~**Warden mobile app.**~~ **Shipped for Android** in `warden_app/` (Flutter,
  FCM push, full-screen alarm, on-duty foreground service). Remaining work is
  iOS/Critical Alerts and production Firebase/keystore rollout; see
  `docs/WARDEN_APP_RUNBOOK.md`.
- **Two-way contact.** A warden cannot call or message the student from the
  dashboard beyond the `tel:` link.
- **Resolution templates.** `resolutionNote` is free text (10–500 chars);
  structured outcomes would make reporting possible.
- **Accessibility audit.** Focus states exist, but the map and alarm flows
  have not been tested with a screen reader.

## 6. Operations

- **nginx + TLS terminator config is documented but not run locally.**
  `backend/nginx.conf` carries 3 upstreams (3001/3002/3003), WebSocket
  upgrade headers, `proxy_buffering off`, a 3600s read timeout and passive
  health checks (`max_fails=3 fail_timeout=10s`). No nginx process runs in
  this environment and no TLS terminator is provisioned. The consequence is
  measured, not theoretical: the dashboard is pinned to one API port, so
  killing that instance leaves it `Disconnected` with no reconnect elsewhere
  (dry-run drill **F3**), and a POST to the dead port returns HTTP 000 while
  survivors only serve requests addressed to them directly (**F4**). Running
  the LB and re-running those two drills is a **production deployment
  verification step**, not a local dry-run step. What *is* proven locally is
  cross-instance broadcast through the Redis adapter (F1/F2 pass, and
  `tests/multi-instance.test.ts` asserts delivery in under 500ms).
- **Load-test automation in CI.** `load-test/sos.js` is manual. A nightly run
  against a disposable environment would catch latency regressions.
- **Backups and restore drills.** No backup job or documented restore has been
  exercised.
- **Secret rotation automation.** Rotation cadence is documented in
  `backend/docs/SECURITY.md`; it is a human process today.
- **Real alert receivers.** Alertmanager points at a placeholder webhook;
  wiring Slack/PagerDuty is deployment-specific.

## 7. Known deliberate trade-offs (do not "fix" casually)

- Acknowledge is **not** idempotent (second call returns 409) — two wardens
  racing on one pending alert is a real coordination event.
- Resolve **is** idempotent (returns 200, no counter bump) — closing an
  already-closed case is the same intent.
- The Socket.IO handshake limiter is in-memory (per instance), while the HTTP
  limiters are Redis-backed. Handshakes are per-connection events; a Redis
  round-trip in the handshake path buys nothing.
- Push is fire-and-forget everywhere: a total FCM outage must never fail an
  SOS.
