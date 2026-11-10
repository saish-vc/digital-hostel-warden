# Security pass — what's protected, what's not, what's next

Status: hardening stage complete. This is the honest checklist for the demo
and the report.

## What is protected (and by what)

| Surface | Protection | Where |
| --- | --- | --- |
| Passwords | bcrypt (cost ≥ 10 seeded, 4 in tests for speed) | `prisma/seed.ts`, `tests/helpers/factories.ts` |
| Tokens | JWT, HS256, `expiresIn: 7d` (see decision below) | `src/config/jwt.ts` |
| Unauthenticated reads | `authenticate` + `requireRole(...)` on every alert/warden route | `src/routes/*.ts` |
| CORS | locked allowlist from `CORS_ORIGIN` (comma-separated), `credentials: true`, methods GET/POST/PATCH/DELETE, everything else logged as `cors_origin_rejected` | `src/app.ts` |
| Request bodies | `express.json({ limit: '10kb' })` → **413** above the limit | `src/app.ts` + error handler |
| Security headers | helmet, CSP off (separate dashboard origin in dev; prod CSP directives documented in `src/app.ts`) | `src/app.ts` |
| Rate limiting (SOS) | Redis-backed 5/60s per STUDENT + break-glass override (never 429; logs `sos_rate_limit_overridden`, bumps `sos_overrides_total`) | `src/middleware/rateLimiters.ts`, `src/routes/alert.routes.ts` |
| Rate limiting (login) | Redis-backed 10/15min per IP → 429 + `Retry-After` | `src/middleware/rateLimiters.ts`, `src/routes/auth.routes.ts` |
| Rate limiting (global) | Redis-backed 100/60s per IP, `/health` + `/metrics` skipped | `src/middleware/rateLimiters.ts` |
| Socket floods | handshake limiter >10 sockets/min/IP rejects before JWT verify | `src/middleware/rateLimiters.ts`, `src/app.ts` |
| `/metrics` | METRICS_TOKEN (`?token=…`), timing-safe compare, 401 otherwise | `src/app.ts`, `src/workers/escalation.worker.ts` |
| Secrets | `.env` gitignored + pre-commit secret scan (shape-based patterns) | `backend/.env.example`, `backend/.husky/pre-commit` |
| Log redaction | passwordHash/password/token/authorization/TWILIO_AUTH_TOKEN/FIREBASE_SERVICE_ACCOUNT_B64 ⇢ `[redacted]` on every line | `src/config/logger.ts` |
| HTTPS | production-only 308 redirect when `X-Forwarded-Proto ≠ https` (nginx terminates TLS) | `src/app.ts` |
| Firebase credentials | base64 in `.env`, scoped to FCM in the console | `src/config/firebase.ts` |

## JWT expiry decision (kept at 7d)

- "12h" would be more secure (a stolen token dies sooner) but is worse UX
  for wardens who leave the dashboard open overnight and lose their session
  mid-shift at the worst possible moment.
- **Demo: 7d** (`JWT_EXPIRES_IN` in `.env.example`, default in
  `src/config/jwt.ts`), with the token in memory (not localStorage) on the
  dashboard side.
- **Production note:** proper answer is a short-lived access token (12h) +
  a refresh token (rotated, revocable, stored server-side). Explicitly out
  of scope for this stage — listed under future work.

## `/metrics` protection model — why METRICS_TOKEN instead of 127.0.0.1

The monitoring stack (Prometheus) runs INSIDE a docker-compose container
and scrapes every API instance at `http://host.docker.internal:3001-3/metrics`
plus the worker at `:4001`. A metrics endpoint bound to `127.0.0.1` would be
unreachable from Prometheus — "protect by not listening" breaks the entire
monitoring stage. So we protect by AUTHENTICATION instead: shared
`METRICS_TOKEN`, compared via hashed timing-safe equality, returning 401 to
the public. The token lives in `backend/.env` AND
`monitoring/prometheus.yml` (`params.token`) — change both together, and
`InstanceDown` will tell you if the scrape token stopped matching.

## Verifying "no secret in git"

```sh
# the automated check (the hook runs the same patterns pre-commit)
cd backend
git ls-files | xargs grep -nE \
  '(JWT_SECRET|METRICS_TOKEN|TWILIO_AUTH_TOKEN|TWILIO_ACCOUNT_SID)[[:space:]]*=[^[:space:]]|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# EXPECTED: failure-free (grep exit 1 = no matches = CLEAN)

# GitHub's own scanner (one-time setup, catches historical leaks too):
#   git secrets --install && git secrets --register-aws
#   git secrets --scan
# (git-secrets bundles AWS patterns; the hook above covers Twilio/JWT/Firebase.)
```

If anything matches: rotate the credential FIRST (Twilio console → Auth
Tokens, Firebase console → service accounts, JWT_SECRET in `.env`), THEN
remove it from the file. History scrubbing (git filter-repo) matters less
than rotating — assume anything ever pushed is known.

## Explicitly NOT in this stage (future work)

- No APM (Datadog/Sentry) — Prometheus + pino logs are enough at 500 students.
- No distributed tracing (OpenTelemetry/Jaeger) — `X-Request-Id` in every log
  line is the lightweight version that already answers "what happened to this
  request".
- No log aggregation (ELK/Loki) — `pm2 logs` + grep <request-id> covers the
  demo; pino JSON output is already aggregator-ready if we add one later.
- No secret manager (Vault/AWS SM) — `.env` + gitignore + pre-commit scan is
  the scope; the rotation cadence in `.env.example` documents the trade.
- No WAF / Cloudflare / DDoS layers — nginx `limit_req` is the ceiling we'd
  add next if the hostel demo goes public.
- No OAuth/SSO/MFA — bcrypt + JWT only; OAuth is the natural next step for
  warden accounts and wardens' phones get lost.
- No refresh-token flow (see JWT decision above).
- No CSP in production yet — the directives to enable are written into
  `src/app.ts` next to the helmet call; they only make sense once the
  dashboard is served from the same origin as the API or through nginx.
