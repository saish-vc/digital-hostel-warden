/**
 * WHY THIS FILE EXISTS
 * Realtime delivery is the primary notification path for wardens, and the
 * room topology is also the privacy boundary for students. This suite opens
 * REAL Socket.IO connections against the REAL server on a random port — no
 * socket mocks — because room joins, handshake auth, and emit targeting are
 * exactly the parts a mock would not exercise.
 *
 * WHAT IT PROTECTS AGAINST
 * - An SOS not reaching every connected warden.
 * - A student not being told when their own alert is acknowledged.
 * - A student receiving another student's alert (cross-student data leak).
 * - A student receiving warden-only `alert:new` events.
 * - Unauthenticated or malformed-JWT sockets being admitted.
 * - Listener leaks on connect/disconnect (MaxListenersExceededWarning).
 */
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAlertsAndQueue, resetDatabaseOnly } from './helpers/db';
import { bearer, createStudent, createWarden, tokenFor } from './helpers/factories';
import {
  connectAs,
  createSocket,
  disconnectAll,
  expectHandshakeRejection,
  recordEvents,
  waitForEvent,
} from './helpers/socketClient';
import { startTestServer, type TestServer } from './helpers/testServer';

let server!: TestServer;
const sockets: Socket[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(token: string): Promise<Socket> {
  const socket = await connectAs(server.url, token);
  sockets.push(socket);
  return socket;
}

function postAlert(token: string, body: Record<string, unknown> = { type: 'MEDICAL' }) {
  return request(server.app).post('/alerts').set('Authorization', bearer(token)).send(body);
}

beforeAll(async () => {
  await resetDatabaseOnly();
  server = await startTestServer();
}, 60_000);

beforeEach(async () => {
  await clearAlertsAndQueue();
});

afterEach(() => {
  disconnectAll(sockets);
  sockets.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('warden fan-out', () => {
  it('delivers alert:new to every connected warden', async () => {
    const wardenA = await createWarden();
    const wardenB = await createWarden();
    const student = await createStudent();

    const socketA = await connect(tokenFor(wardenA, 'WARDEN'));
    const socketB = await connect(tokenFor(wardenB, 'WARDEN'));
    await connect(tokenFor(student, 'STUDENT'));

    const receivedA = waitForEvent<{ id: string }>(socketA, 'alert:new');
    const receivedB = waitForEvent<{ id: string }>(socketB, 'alert:new');

    const response = await postAlert(tokenFor(student, 'STUDENT'));
    expect(response.status).toBe(201);

    const [alertA, alertB] = await Promise.all([receivedA, receivedB]);
    expect(alertA.id).toBe(response.body.id);
    expect(alertB.id).toBe(response.body.id);
  });

  it('delivers alert:updated to the student whose alert was acknowledged', async () => {
    const student = await createStudent();
    const warden = await createWarden();

    const studentSocket = await connect(tokenFor(student, 'STUDENT'));
    await connect(tokenFor(warden, 'WARDEN'));

    const created = await postAlert(tokenFor(student, 'STUDENT'));
    const updated = waitForEvent<{ id: string; status: string }>(
      studentSocket,
      'alert:updated',
    );

    const ack = await request(server.app)
      .patch(`/alerts/${created.body.id}/acknowledge`)
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')));
    expect(ack.status).toBe(200);

    expect(await updated).toMatchObject({
      id: created.body.id,
      status: 'ACKNOWLEDGED',
    });
  });
});

describe('student isolation', () => {
  it('does not deliver alert:new to a student socket', async () => {
    const studentA = await createStudent();
    const studentB = await createStudent();

    const socketA = await connect(tokenFor(studentA, 'STUDENT'));
    const eventsForA = recordEvents(socketA, 'alert:new');

    const response = await postAlert(tokenFor(studentB, 'STUDENT'));
    expect(response.status).toBe(201);

    await sleep(400);
    expect(eventsForA).toEqual([]);
  });

  it('does not deliver alert:updated for another student’s alert', async () => {
    const studentA = await createStudent();
    const studentB = await createStudent();
    const warden = await createWarden();

    const socketA = await connect(tokenFor(studentA, 'STUDENT'));
    const eventsForA = recordEvents(socketA, 'alert:updated');

    const created = await postAlert(tokenFor(studentB, 'STUDENT'));
    const ack = await request(server.app)
      .patch(`/alerts/${created.body.id}/acknowledge`)
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')));
    expect(ack.status).toBe(200);

    await sleep(400);
    expect(eventsForA).toEqual([]);
  });
});

describe('handshake authentication', () => {
  it('rejects a socket with an invalid JWT', async () => {
    await expect(expectHandshakeRejection(server.url, { token: 'not-a-valid-jwt' })).resolves.toBe(
      'UNAUTHORIZED',
    );
  });

  it('rejects a socket with no JWT', async () => {
    await expect(expectHandshakeRejection(server.url)).resolves.toBe('UNAUTHORIZED');
  });

  it('rejects a socket whose JWT has expired', async () => {
    const jwt = await import('jsonwebtoken');
    const student = await createStudent();
    const expired = jwt.default.sign(
      { id: student.id, role: 'STUDENT' },
      process.env.JWT_SECRET!,
      { expiresIn: '-10s' },
    );

    await expect(expectHandshakeRejection(server.url, { token: expired })).resolves.toBe(
      'UNAUTHORIZED',
    );
  });
});

describe('connection lifecycle', () => {
  it('connects and disconnects repeatedly without MaxListenersExceededWarning', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');

    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);

    try {
      for (let i = 0; i < 12; i++) {
        await connect(token);
      }

      disconnectAll(sockets);
      sockets.length = 0;
      await sleep(250);

      const maxListenerWarnings = warnings.filter(
        (warning) => warning.name === 'MaxListenersExceededWarning',
      );
      expect(maxListenerWarnings).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('still accepts a fresh connection after many disconnects', async () => {
    const student = await createStudent();

    for (let i = 0; i < 5; i++) {
      const socket = createSocket(server.url, { token: tokenFor(student, 'STUDENT') });
      await waitForEvent(socket, 'connected');
      socket.disconnect();
    }

    const socket = await connect(tokenFor(student, 'STUDENT'));
    expect(socket.connected).toBe(true);
  });
});
