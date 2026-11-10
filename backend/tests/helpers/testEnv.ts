import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Loads .env.test and maps TEST_* onto the variables the application reads.
 *
 * This module MUST be the first thing a test process evaluates: src/config/jwt.ts
 * throws when JWT_SECRET is missing, and src/queues/escalation.queue.ts reads
 * ESCALATION_DELAY_MS at module load. It is imported by the setupFiles entry
 * (before any test file) and by globalSetup (before migrations).
 */

const envCandidates = [
  resolve(process.cwd(), '.env.test'),
  resolve(process.cwd(), 'backend', '.env.test'),
];

for (const candidate of envCandidates) {
  if (existsSync(candidate)) {
    config({ path: candidate });
    break;
  }
}

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/hostel_emergency_test?schema=public';

export const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function redisDbIndex(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path === '' ? 0 : Number(path);
  } catch {
    return 0;
  }
}

/**
 * Guard rail. The suite TRUNCATEs every table and FLUSHDBs Redis before each
 * file; pointing it at a dev or production target would destroy real data.
 * Failing here is the whole point: a misconfigured test run must stop, not
 * "helpfully" clean up the wrong database.
 */
function assertSafeTargets(): void {
  if (process.env.ALLOW_UNSAFE_TEST_TARGETS === '1') {
    return;
  }

  const dbName = databaseName(TEST_DATABASE_URL);
  if (!/_test$/.test(dbName)) {
    throw new Error(
      `Refusing to run tests against database "${dbName || '(unparseable)'}": ` +
        'TEST_DATABASE_URL must name a database ending in _test ' +
        '(e.g. hostel_emergency_test). Set ALLOW_UNSAFE_TEST_TARGETS=1 only ' +
        'if you are certain this database is disposable.',
    );
  }

  if (redisDbIndex(TEST_REDIS_URL) === 0) {
    throw new Error(
      'Refusing to run tests against Redis DB index 0: the suite FLUSHDBs ' +
        'its target. Use a dedicated index such as redis://localhost:6379/1 ' +
        'in TEST_REDIS_URL.',
    );
  }
}

assertSafeTargets();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
// schema.prisma declares directUrl = env("DIRECT_DATABASE_URL"), used by
// `prisma migrate`. Tests must migrate the disposable test database, so this
// is FORCED (not defaulted) — a production DIRECT_DATABASE_URL in the shell
// must never be reachable from a test run.
process.env.DIRECT_DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-only-jwt-secret-do-not-use-outside-tests';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1h';

// Forced, not defaulted: escalation tests measure real wall-clock behaviour
// and a stray 60000 from the shell would turn a 60s suite into a 10min one.
process.env.ESCALATION_DELAY_MS = '500';

// The Twilio SDK is always mocked; these values only satisfy the service's
// own configuration checks.
process.env.SMS_PROVIDER = 'twilio';
process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_FROM_NUMBER = '+15005550006';
process.env.WARDEN_ONCALL_PHONE = '+15005550007';

// Push is mocked explicitly in tests/push.test.ts; everything else should
// exercise the real "push disabled" path rather than initialize Firebase.
process.env.FIREBASE_SERVICE_ACCOUNT_B64 = '';
process.env.DASHBOARD_URL = '';

// Rate limiting is OFF for the whole suite: sockets.test.ts opens many
// sockets in a second from one IP (would trip the handshake limiter), and
// integration suites do rapid logins/alarms by design. The gating is
// evaluated PER REQUEST (see src/middleware/rateLimiters.ts), so
// tests/hardening.test.ts flips RATE_LIMIT_ENABLED=1 in its beforeAll and
// exercises the real limits in the same process.
process.env.RATE_LIMIT_ENABLED = '0';
