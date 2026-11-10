/**
 * WHY THIS FILE EXISTS
 * Escalation is the highest-risk path in the system: it is the only code that
 * sends an SMS to a human, it races acknowledgement, and it depends on Redis
 * being up. A regression here is either a missed emergency or SMS spam at an
 * already-acknowledged alert.
 *
 * HOW IT WORKS
 * Real Postgres, real Redis (DB 1), a REAL BullMQ Worker consuming the real
 * queue, and a real delayed job at ESCALATION_DELAY_MS=500. Only Twilio is
 * mocked, so the timing and the BullMQ mechanics are genuine. The worker is
 * started in beforeAll; if Redis is down, waitUntilReady() throws and the
 * suite fails loudly instead of silently testing nothing.
 *
 * WHAT IT PROTECTS AGAINST
 * - A PENDING alert quietly never escalating.
 * - An acknowledged alert still sending an SMS after the delay.
 * - The cancel/ack race: acknowledge just before the deadline must win.
 * - The worker's idempotency guard regressing (unit-level handler test).
 * - Redis being down blocking the SOS endpoint (the endpoint is sacred).
 * - cancelEscalation throwing when the job already fired.
 * - A non-deterministic job id producing duplicate jobs / duplicate SMS.
 *
 * TIMING NOTE: the "just before the deadline" test acknowledges at 400ms, not
 * 490ms. A 500ms delay leaves ~10ms for an HTTP round trip plus a DB write;
 * on Windows that is not deterministically before the worker promotes the
 * job, and the system is explicitly allowed to send if the ack has not been
 * committed. 400ms preserves the intent (ack close to the deadline) while
 * keeping the test deterministic.
 */
import { Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { prisma } from '../src/config/prisma';
import { createRedisConnection } from '../src/config/redis';
import {
  cancelEscalation,
  enqueueEscalation,
  escalationJobId,
  escalationQueue,
} from '../src/queues/escalation.queue';
import { processEscalationJob } from '../src/workers/escalation.processor';
import { sendEscalationSms } from '../src/services/sms.service';
import { clearAlertsAndQueue, resetDatabaseOnly } from './helpers/db';
import { bearer, createAlert, createStudent, createWarden, tokenFor } from './helpers/factories';
import { startTestServer, type TestServer } from './helpers/testServer';
import { resetTwilioMock, twilioMock } from './helpers/twilioMock';

/**
 * The queue module is partially mocked so ONE test can simulate Redis being
 * unreachable without touching the real queue the other tests depend on.
 * By default the wrapper delegates to the real enqueueEscalation.
 */
const queueControl = vi.hoisted(() => ({
  enqueueImpl: null as null | ((alertId: string) => Promise<void>),
}));

vi.mock('twilio', async () => {
  const { createTwilioModuleMock } = await import('./helpers/twilioMock');
  return createTwilioModuleMock();
});

vi.mock('../src/queues/escalation.queue', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/queues/escalation.queue')>();
  return {
    ...actual,
    enqueueEscalation: (alertId: string) =>
      queueControl.enqueueImpl
        ? queueControl.enqueueImpl(alertId)
        : actual.enqueueEscalation(alertId),
  };
});

let server!: TestServer;
let worker!: Worker;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function postAlert(token: string) {
  return request(server.app)
    .post('/alerts')
    .set('Authorization', bearer(token))
    .send({ type: 'MEDICAL' });
}

function acknowledge(alertId: string, token: string) {
  return request(server.app)
    .patch(`/alerts/${alertId}/acknowledge`)
    .set('Authorization', bearer(token));
}

beforeAll(async () => {
  expect(Number(process.env.ESCALATION_DELAY_MS)).toBe(500);

  await resetDatabaseOnly();
  server = await startTestServer();

  worker = new Worker('escalation', processEscalationJob, {
    connection: createRedisConnection(),
    concurrency: 1,
  });
  worker.on('error', (error) => {
    console.error('[test-worker] error:', error.message);
  });

  // Fails the suite (loudly) if Redis is unreachable or the worker cannot
  // start — never let escalation tests pass while testing no worker at all.
  await worker.waitUntilReady();
}, 60_000);

beforeEach(async () => {
  resetTwilioMock();
  queueControl.enqueueImpl = null;
  await clearAlertsAndQueue();
});

afterAll(async () => {
  await worker.close();
  await server.close();
});

describe('escalation timing', () => {
  it('sends the SMS when an alert stays PENDING for the full delay', async () => {
    const student = await createStudent();
    const studentToken = tokenFor(student, 'STUDENT');

    const response = await postAlert(studentToken);
    expect(response.status).toBe(201);

    await vi.waitFor(
      () => {
        expect(twilioMock.createMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 8_000, interval: 50 },
    );

    expect(twilioMock.sent[0]).toMatchObject({ to: '+15005550007' });
    expect(twilioMock.sent[0].body).toContain(student.name);
    expect(twilioMock.sent[0].body).toContain('NO ACKNOWLEDGEMENT');

    // Escalation does not change the alert's status in phase 1; the row stays
    // PENDING for the dashboard and for the idempotency guard.
    const stored = await prisma.emergencyAlert.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.status).toBe('PENDING');
  });

  it('cancels the SMS when the alert is acknowledged well before the delay', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const studentToken = tokenFor(student, 'STUDENT');

    const created = await postAlert(studentToken);
    await sleep(250);

    const ack = await acknowledge(created.body.id, tokenFor(warden, 'WARDEN'));
    expect(ack.status).toBe(200);

    await sleep(900);
    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });

  it('cancels the SMS when the alert is acknowledged just before the delay fires', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const studentToken = tokenFor(student, 'STUDENT');

    const created = await postAlert(studentToken);
    await sleep(400);

    const ack = await acknowledge(created.body.id, tokenFor(warden, 'WARDEN'));
    expect(ack.status).toBe(200);

    await sleep(900);
    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });
});

describe('worker idempotency guard', () => {
  it('does not send an SMS when the handler runs against an ACKNOWLEDGED alert', async () => {
    const student = await createStudent();
    const warden = await createWarden();

    const alert = await createAlert(student.id, {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      acknowledgedBy: warden.id,
    });

    const fakeJob = { id: 'unit-test-job', data: { alertId: alert.id } } as Job<{
      alertId: string;
    }>;

    await processEscalationJob(fakeJob);

    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });

  it('does not throw for an alert that no longer exists', async () => {
    const fakeJob = {
      id: 'missing-alert-job',
      data: { alertId: '00000000-0000-0000-0000-000000000000' },
    } as Job<{ alertId: string }>;

    await expect(processEscalationJob(fakeJob)).resolves.toBeUndefined();
    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });
});

describe('SMS service failure modes', () => {
  const SMS_ENV_KEYS = [
    'SMS_PROVIDER',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'WARDEN_ONCALL_PHONE',
  ] as const;
  const originalSmsEnv = Object.fromEntries(
    SMS_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof SMS_ENV_KEYS)[number], string | undefined>;

  const smsAlert = {
    id: 'alert-sms-unit',
    type: 'MEDICAL',
    student: { name: 'Test Student', roomNumber: 'B-201' },
  };

  afterEach(() => {
    for (const key of SMS_ENV_KEYS) {
      const value = originalSmsEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('refuses an unimplemented SMS provider', async () => {
    process.env.SMS_PROVIDER = 'msg91';

    await expect(sendEscalationSms(smsAlert)).rejects.toThrow(/not implemented/);
    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });

  it('refuses to send without Twilio credentials', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;

    await expect(sendEscalationSms(smsAlert)).rejects.toThrow(/not configured/);
    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });

  it('refuses a malformed on-call phone number', async () => {
    process.env.WARDEN_ONCALL_PHONE = 'not-a-phone';

    await expect(sendEscalationSms(smsAlert)).rejects.toThrow(/E\.164/);
    expect(twilioMock.createMessage).not.toHaveBeenCalled();
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    twilioMock.createMessage.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );

    const result = await sendEscalationSms(smsAlert);

    expect(result.receiptId).toBe('SM_test_receipt_0001');
    expect(twilioMock.createMessage).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does not retry a hard 4xx (invalid number)', async () => {
    twilioMock.createMessage.mockRejectedValueOnce(
      Object.assign(new Error('invalid To number'), { status: 400 }),
    );

    await expect(sendEscalationSms(smsAlert)).rejects.toThrow('invalid To number');
    expect(twilioMock.createMessage).toHaveBeenCalledTimes(1);
  });
});

describe('resilience', () => {
  it('still returns 201 when enqueueing the escalation fails (Redis down)', async () => {
    const student = await createStudent();
    const studentToken = tokenFor(student, 'STUDENT');

    queueControl.enqueueImpl = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    const response = await postAlert(studentToken);

    expect(response.status).toBe(201);
    expect(queueControl.enqueueImpl).toHaveBeenCalledWith(response.body.id);

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.status).toBe('PENDING');
  });

  it('cancelEscalation does not throw when the job already fired and was removed', async () => {
    const student = await createStudent();
    const alert = await createAlert(student.id);

    await enqueueEscalation(alert.id);
    await vi.waitFor(
      () => {
        expect(twilioMock.createMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 8_000, interval: 50 },
    );

    // removeOnComplete only runs once the processor resolves, which is later
    // than the Twilio call. Removing a still-locked job throws, so wait for
    // the job to actually disappear before asserting cancel is a no-op.
    await vi.waitFor(
      async () => {
        expect(await escalationQueue.getJob(escalationJobId(alert.id))).toBeUndefined();
      },
      { timeout: 8_000, interval: 50 },
    );

    await expect(cancelEscalation(alert.id)).resolves.toEqual(expect.any(Boolean));
    await expect(cancelEscalation(alert.id)).resolves.toBe(false);
  });

  it('uses a deterministic job id so enqueueing twice yields one job', async () => {
    const student = await createStudent();
    const alert = await createAlert(student.id);

    await enqueueEscalation(alert.id);
    await enqueueEscalation(alert.id);

    expect(await escalationQueue.getDelayedCount()).toBe(1);
    expect(await escalationQueue.getJob(escalationJobId(alert.id))).toBeTruthy();

    // Clean up so the worker cannot fire this job into the next test.
    const job = await escalationQueue.getJob(escalationJobId(alert.id));
    await job?.remove();
  });
});
