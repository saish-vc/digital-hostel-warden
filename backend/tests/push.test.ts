/**
 * WHY THIS FILE EXISTS
 * Push notification bugs are invisible in normal testing: the HTTP 201 is
 * returned before FCM is even called, so a broken payload or a bad token
 * cleanup only shows up at 2 a.m. when nobody's dashboard rings. This suite
 * mocks firebase-admin (never the real API) and asserts the exact multicast
 * call the service makes.
 *
 * WHAT IT PROTECTS AGAINST
 * - No push at all, or one push per token instead of one batch.
 * - Non-string values in the FCM data payload (FCM rejects the whole message;
 *   this is the single most common FCM bug).
 * - Dead registration tokens never being removed, so every SOS retries them.
 * - A push failure turning the SOS response into a 500.
 * - Token chunking above FCM's 500-token limit (three tokens must be one call).
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { logger } from '../src/config/logger';
import { clearAlertsAndQueue, resetDatabaseOnly } from './helpers/db';
import { bearer, createStudent, createWarden, tokenFor } from './helpers/factories';
import { fcmMock, resetFcmMock } from './helpers/fcmMock';
import { startTestServer, type TestServer } from './helpers/testServer';

// Replace firebase-admin's messaging export with the configurable mock. The
// push service reads fcmMessaging at call time, so no other change is needed.
vi.mock('../src/config/firebase', async () => {
  const { createFirebaseConfigMock } = await import('./helpers/fcmMock');
  return createFirebaseConfigMock();
});

let server!: TestServer;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function registerToken(wardenToken: string, token: string) {
  return request(server.app)
    .post('/wardens/fcm-token')
    .set('Authorization', bearer(wardenToken))
    .send({ token, userAgent: 'vitest' });
}

function postAlert(token: string) {
  return request(server.app)
    .post('/alerts')
    .set('Authorization', bearer(token))
    .send({ type: 'MEDICAL', latitude: 12.34, longitude: 77.56 });
}

function lastMulticastMessage() {
  const calls = fcmMock.messaging.sendEachForMulticast.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]![0] as {
    tokens?: string[];
    data?: Record<string, string>;
    notification?: { title?: string; body?: string };
    android?: {
      priority?: string;
      ttl?: number;
      notification?: {
        channelId?: string;
        sound?: string;
        priority?: string;
        visibility?: string;
        tag?: string;
      };
    };
    webpush?: {
      headers?: Record<string, string>;
      fcmOptions?: { link?: string };
    };
  };
}

beforeAll(async () => {
  await resetDatabaseOnly();
  server = await startTestServer();
}, 60_000);

beforeEach(async () => {
  resetFcmMock();
  await clearAlertsAndQueue();
  await prisma.deviceToken.deleteMany();
});

afterAll(async () => {
  await server.close();
});

describe('FCM multicast dispatch', () => {
  it('sends one multicast containing every registered warden token', async () => {
    const warden = await createWarden();
    const student = await createStudent();
    const wardenToken = tokenFor(warden, 'WARDEN');

    await registerToken(wardenToken, 'token-alpha');
    await registerToken(wardenToken, 'token-beta');

    const response = await postAlert(tokenFor(student, 'STUDENT'));
    expect(response.status).toBe(201);

    await vi.waitFor(
      () => {
        expect(fcmMock.messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
      },
      { timeout: 4_000, interval: 25 },
    );

    const message = lastMulticastMessage();
    expect(message.tokens).toEqual(expect.arrayContaining(['token-alpha', 'token-beta']));
    expect(message.notification?.title).toContain('Medical Emergency');
    expect(message.notification?.body).toContain(student.name);
  });

  it('sends all data payload values as strings', async () => {
    const warden = await createWarden();
    const student = await createStudent();

    await registerToken(tokenFor(warden, 'WARDEN'), 'token-payload');

    const response = await postAlert(tokenFor(student, 'STUDENT'));
    expect(response.status).toBe(201);

    await vi.waitFor(
      () => {
        expect(fcmMock.messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
      },
      { timeout: 4_000, interval: 25 },
    );

    const data = lastMulticastMessage().data ?? {};
    expect(Object.keys(data).length).toBeGreaterThan(0);

    for (const [key, value] of Object.entries(data)) {
      expect(typeof value, `FCM data.${key} must be a string`).toBe('string');
    }

    expect(data).toMatchObject({
      alertId: response.body.id,
      studentId: student.id,
      type: 'MEDICAL',
      latitude: '12.34',
      longitude: '77.56',
    });
  });

  it('targets the native alert channel, sound and 5-minute TTL', async () => {
    const warden = await createWarden();
    const student = await createStudent();

    await registerToken(tokenFor(warden, 'WARDEN'), 'token-android');

    const response = await postAlert(tokenFor(student, 'STUDENT'));
    expect(response.status).toBe(201);
    const alertId = response.body.id as string;

    await vi.waitFor(
      () => {
        expect(fcmMock.messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
      },
      { timeout: 4_000, interval: 25 },
    );

    const message = lastMulticastMessage();
    expect(message.android?.priority).toBe('high');
    // firebase-admin takes milliseconds even though FCM's REST API says seconds.
    expect(message.android?.ttl).toBe(300_000);
    expect(message.android?.notification).toMatchObject({
      channelId: 'warden_alerts',
      sound: 'default',
      priority: 'max',
      visibility: 'public',
      tag: `alert-${alertId}`,
    });

    // The web client must be byte-for-byte unchanged by the Android addition.
    expect(message.webpush?.headers).toMatchObject({ Urgency: 'high', TTL: '300' });
  });

  it('batches three tokens for two wardens into one call', async () => {
    const wardenA = await createWarden();
    const wardenB = await createWarden();
    const student = await createStudent();

    await registerToken(tokenFor(wardenA, 'WARDEN'), 'token-a1');
    await registerToken(tokenFor(wardenA, 'WARDEN'), 'token-a2');
    await registerToken(tokenFor(wardenB, 'WARDEN'), 'token-b1');

    const response = await postAlert(tokenFor(student, 'STUDENT'));
    expect(response.status).toBe(201);

    await vi.waitFor(
      () => {
        expect(fcmMock.messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
      },
      { timeout: 4_000, interval: 25 },
    );

    const message = lastMulticastMessage();
    expect(message.tokens).toHaveLength(3);
    expect(message.tokens).toEqual(
      expect.arrayContaining(['token-a1', 'token-a2', 'token-b1']),
    );
  });
});

describe('stale and failing tokens', () => {
  it('deletes a stale token and keeps accepting SOSes afterwards', async () => {
    const warden = await createWarden();
    const student = await createStudent();

    await registerToken(tokenFor(warden, 'WARDEN'), 'token-stale');

    fcmMock.messaging.sendEachForMulticast.mockResolvedValueOnce({
      successCount: 0,
      failureCount: 1,
      responses: [
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
      ],
    });

    const first = await postAlert(tokenFor(student, 'STUDENT'));
    expect(first.status).toBe(201);

    await vi.waitFor(
      async () => {
        expect(await prisma.deviceToken.count({ where: { token: 'token-stale' } })).toBe(0);
      },
      { timeout: 4_000, interval: 25 },
    );

    // A new token registers fine and the next SOS still succeeds.
    await registerToken(tokenFor(warden, 'WARDEN'), 'token-fresh');
    const second = await postAlert(tokenFor(student, 'STUDENT'));
    expect(second.status).toBe(201);
  });

  it('returns 201 and logs when the FCM call throws', async () => {
    const warden = await createWarden();
    const student = await createStudent();
    await registerToken(tokenFor(warden, 'WARDEN'), 'token-boom');

    // The service logs through the structured logger (pino) — spying on
    // logger.error asserts the failure is REPORTED without caring where
    // it is later shipped to.
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    // A hard, non-retryable error, so the service logs immediately instead of
    // sitting through ~1s+2s+4s of backoff. Real hard failures look like this
    // (bad credentials / malformed request).
    fcmMock.messaging.sendEachForMulticast.mockRejectedValueOnce(
      Object.assign(new Error('invalid credential'), {
        code: 'messaging/invalid-credential',
      }),
    );

    try {
      const response = await postAlert(tokenFor(student, 'STUDENT'));
      expect(response.status).toBe(201);

      await vi.waitFor(
        () => {
          expect(loggerError).toHaveBeenCalled();
        },
        { timeout: 4_000, interval: 25 },
      );
    } finally {
      loggerError.mockRestore();
    }
  });
});

describe('push disabled', () => {
  it('does not attempt a send when there are no registered tokens', async () => {
    const student = await createStudent();

    const response = await postAlert(tokenFor(student, 'STUDENT'));
    expect(response.status).toBe(201);

    await sleep(200);
    expect(fcmMock.messaging.sendEachForMulticast).not.toHaveBeenCalled();
  });
});
