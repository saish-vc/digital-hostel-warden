import { pino } from 'pino';
import { instanceId } from './instance';

/**
 * THE application logger (pino).
 *
 * Why pino and not console.* / winston:
 * - Structured JSON to stdout: every line parses as JSON, so `pm2 logs` /
 *   `grep` / any future log aggregator can filter by field — this is what
 *   makes `pm2 logs | grep <X-Request-Id>` work in the verification drills.
 * - Redaction at serialization time: secrets are REPLACED in the output, so
 *   a logger call with a token in the object can never leak it (below).
 * - `base` binds `instanceId` into every line, so with 3 API instances + 1
 *   worker interleaved in `pm2 logs` you can always tell which process
 *   emitted a line.
 *
 * LOG_LEVEL: defaults to `info` in every environment. Set LOG_LEVEL=debug
 * in dev when chasing a bug. Do NOT set `silent` in production — the
 * break-glass override and EscalationFailuresHigh trails depend on warns
 * and errors reaching stdout.
 *
 * REDACTION IS NON-NEGOTIABLE. The paths below cover:
 * - structured fields at the top level ({ passwordHash, password, token,
 *   authorization })
 * - one level of nesting ({ auth: { token }, user: { password } })
 * - pino-http's `req.headers` serializer ({ req: { headers: { authorization } } })
 * - anyone accidentally logging whole env objects
 * Every occurrence is replaced with [redacted] in the output, never dropped
 * (the key stays visible, the value does not).
 *
 * %{CENSORED}% is used instead of removing the key on purpose: a missing key
 * is indistinguishable from "never logged it", while %{CENSORED}% visibly
 * proves redaction happened — which is what the secret-scan grep verifies.
 */
const CENSORED = '[redacted]';

const REDACT_PATHS: readonly string[] = [
  // Top-level structured fields.
  'passwordHash',
  'password',
  'token',
  'authorization',
  // If a whole env/config object is ever logged.
  'TWILIO_AUTH_TOKEN',
  'FIREBASE_SERVICE_ACCOUNT_B64',
  // One level of nesting.
  '*.passwordHash',
  '*.password',
  '*.token',
  '*.authorization',
  // pino-http request/response serializers (headers, auth headers).
  'req.headers.authorization',
  'req.headers.token',
  'req.headers["x-internal-token"]',
  'req.headers["x-loadtest-token"]',
  'res.headers["www-authenticate"]',
];

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

/**
 * Development only: pino-pretty (devDependency) runs pino's log lines
 * through a worker thread for coloured, human-readable output.
 *
 * - Node.js workers need the transport only in dev because pino-pretty is a
 *   devDependency and `transport` spawns a worker thread to keep pretty
 *   printing off the hot path.
 * - Production/PM2 stays plain JSON on stdout (machine-parseable).
 * - Tests stay silent: vitest already streams pass/fail lines, and JSON
 *   lines between them would make failures unreadable. The hardening
 *   assertions check METRICS and counters, never log text, so silencing
 *   costs nothing.
 */
export const logger = pino({
  level: isTest ? 'silent' : process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [...REDACT_PATHS],
    censor: CENSORED,
  },
  base: {
    // Every log line carries the instance identity (port / "worker") so
    // multi-instance logs are distinguishable in a shared `pm2 logs` stream.
    instanceId: instanceId(),
  },
  // Spread keeps `transport` absent outside development — no worker thread
  // in production or in the vitest threads pool.
  ...(isProd || isTest
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }),
});

export type Logger = typeof logger;
