/**
 * WHY THIS FILE EXISTS
 * GET /health is the load balancer's only signal and the multi-instance
 * test's readiness probe. This suite pins its shape (instanceId / redis / db)
 * and the port-resolution rules that make each instance identifiable.
 *
 * WHAT IT PROTECTS AGAINST
 * - The health payload silently changing shape (LB probes break).
 * - instanceId not reflecting PORT or NODE_APP_INSTANCE, which would make
 *   load balancing invisible and the multi-instance test unable to tell
 *   instances apart.
 * - Health reporting 200 when Redis/Postgres cannot be reached (only the
 *   healthy path is asserted here; dependency-failure paths require taking
 *   Redis/Postgres down and are covered by the manual runbook).
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabaseOnly } from './helpers/db';
import { startTestServer, type TestServer } from './helpers/testServer';

let server!: TestServer;
const originalPort = process.env.PORT;
const originalInstance = process.env.NODE_APP_INSTANCE;

beforeAll(async () => {
  await resetDatabaseOnly();
  server = await startTestServer();
}, 60_000);

afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;

  if (originalInstance === undefined) delete process.env.NODE_APP_INSTANCE;
  else process.env.NODE_APP_INSTANCE = originalInstance;
});

afterAll(async () => {
  await server.close();
});

describe('GET /health', () => {
  it('reports ok, the instance identity, Redis and Postgres', async () => {
    process.env.PORT = '4100';
    delete process.env.NODE_APP_INSTANCE;

    const response = await request(server.app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      instanceId: '4100',
      redis: 'ok',
      db: 'ok',
    });
  });

  it('derives instanceId from NODE_APP_INSTANCE when PORT is unset', async () => {
    delete process.env.PORT;
    process.env.NODE_APP_INSTANCE = '1';

    const response = await request(server.app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.instanceId).toBe('3002');
  });

  it('falls back to 4000 when neither PORT nor NODE_APP_INSTANCE is set', async () => {
    delete process.env.PORT;
    delete process.env.NODE_APP_INSTANCE;

    const response = await request(server.app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.instanceId).toBe('4000');
  });
});
