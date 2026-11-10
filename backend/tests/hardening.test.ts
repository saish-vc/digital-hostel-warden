/**
 * WHY THIS FILE EXISTS
 * This is the smoke suite for the hardening stage. The three pillars it
 * pins down:
 *
 * 1. /metrics protection — the endpoint must NEVER be publicly readable
 *    (it enumerates students' alert volume and queue state); without
 *    METRICS_TOKEN the answer is 401, with it, valid Prometheus format.
 * 2. Rate limiting — Redis-backed per-student (SOS) and per-IP (login)
 *    budgets actually engage, AND the SOS break-glass override allows the
 *    6th SOS through (an emergency is never silently dropped — it is
 *    accounted via sos_overrides_total instead).
 * 3. The security pass — 10kb body limit rejects oversized payloads with
 *    413, and /health stays open (the load balancer probes it).
 *
 * HOW IT ISOLATES ITSELF
 * - testEnv.ts forces RATE_LIMIT_ENABLED=0 for the whole suite; this file
 *   flips it to '1' in beforeAll. The flag is evaluated PER REQUEST
 *   (src/middleware/rateLimiters.ts) inside the SAME process/module graph,
 *   so no second app assembly is needed.
 * - The limiter counters and the metrics registry are global state:
 *   beforeEach flushes the test Redis DB (limiter buckets) and
 *   resetMetricsForTests() (prom-client values).
 * - METRICS_TOKEN is set here; the check reads the env at request time.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import {
  resetMetricsForTests,
  sosOverridesTotal,
} from '../src/config/metrics';
import { closeRateLimiter } from '../src/middleware/rateLimiters';
import { createStudent, TEST_PASSWORD, tokenFor } from './helpers/factories';
import { resetDatabaseOnly } from './helpers/db';
import { flushTestRedis } from './helpers/redisCleanup';
import { startTestServer, type TestServer } from './helpers/testServer';

const METRICS_TOKEN = 'hardening-test-metrics-token';

let server!: TestServer;
let studentToken!: string;

beforeAll(async () => {
  // The hardening knobs — read at REQUEST time by the app, so setting them
  // here (after modules loaded) is sufficient and affects only this file.
  process.env.RATE_LIMIT_ENABLED = '1';
  process.env.METRICS_TOKEN = METRICS_TOKEN;

  await resetDatabaseOnly();
  server = await startTestServer();

  const student = await createStudent();
  studentToken = tokenFor(student, 'STUDENT');
}, 60_000);

afterEach(async () => {
  // Iterate the suites in THIS file independently of one another:
  // limiter buckets live in Redis, metrics values live in prom-client.
  await flushTestRedis();
  resetMetricsForTests();
});

afterAll(async () => {
  process.env.RATE_LIMIT_ENABLED = '0';
  await server.close(); // closes Socket.IO + BullMQ queue + prisma (helper)
  await closeRateLimiter(); // close() does NOT own the limiter client
  await prisma.$disconnect().catch(() => undefined);
});

async function counterValue(
  get: () => Promise<{ values: Array<{ value: number }> }>,
): Promise<number> {
  const snapshot = await get();
  return snapshot.values[0]?.value ?? 0;
}

describe('GET /health', () => {
  it('stays open and healthy for the load balancer', async () => {
    const response = await request(server.app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', redis: 'ok', db: 'ok' });
  });
});

describe('GET /metrics', () => {
  it('rejects scrapers without the token (401)', async () => {
    const response = await request(server.app).get('/metrics');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: 'METRICS_TOKEN missing or invalid (?token=...)',
    });
  });

  it('serves valid Prometheus exposition with the token', async () => {
    const response = await request(server.app).get(
      `/metrics?token=${encodeURIComponent(METRICS_TOKEN)}`,
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('# HELP http_requests_total');
    expect(response.text).toContain('# TYPE http_requests_total counter');
  });
});

describe('POST /auth/login rate limit', () => {
  it('returns 429 on the 11th attempt inside 15 minutes', async () => {
    const login = () =>
      request(server.app)
        .post('/auth/login')
        .send({
          email: `ratelimit.${Date.now()}@no-such-user.hostel`,
          password: 'wrong-password',
          role: 'STUDENT',
        });


    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await login();
      expect(response.status).toBe(401); // limiter passes through, auth rejects
    }

    // 11th attempt: the Redis-backed budget (10 / 15min / IP) answers.
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: 'rate_limited',
      retryAfter: expect.any(Number),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('POST /alerts SOS limiter + break-glass', () => {
  it('allows the 5 in-window SOSes, then OVERRIDES (never 429) and counts it', async () => {
    const bearer = `Bearer ${studentToken}`;

    for (let i = 0; i < 5; i++) {
      const response = await request(server.app)
        .post('/alerts')
        .set('Authorization', bearer)
        .send({ type: 'MEDICAL' });
      expect(response.status).toBe(201);
    }

    // 6th SOS: the limiter tripped, but the break-glass override ALLOWS the
    // request, logs sos_rate_limit_overridden and bumps sos_overrides_total.
    const sixth = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer)
      .send({ type: 'MEDICAL' });
    expect(sixth.status).toBe(201);
    expect(sixth.body).toMatchObject({ type: 'MEDICAL', status: 'PENDING' });

    expect(await counterValue(() => sosOverridesTotal.get())).toBe(1);

    // The metric is also visible in the exposition Prometheus would scrape.
    const metrics = await request(server.app).get(
      `/metrics?token=${encodeURIComponent(METRICS_TOKEN)}`,
    );
    expect(metrics.text).toContain('sos_overrides_total 1');
  });
});

describe('Request body size limit', () => {
  it('returns 413 for a 100kb payload', async () => {

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', `Bearer ${studentToken}`)
      .set('Content-Type', 'application/json')
      .send(`{"padding":"${'a'.repeat(102_400)}"}`);

    expect(response.status).toBe(413);
    expect(response.body.error).toMatch(/10kb/);
  });
});
