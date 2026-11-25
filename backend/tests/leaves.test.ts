/**
 * WHY THIS FILE EXISTS
 * Leave approval is a supervisor-gated workflow: a student files a request,
 * a warden decides it, and a gate pass only exists after approval. Until now
 * that flow was only exercised by hand, so every rule here — ownership,
 * transitions, date sanity, role isolation — was one refactor away from
 * silently regressing.
 *
 * WHAT IT PROTECTS AGAINST
 * - A student filing a leave in the past, or a return before departure.
 * - A student cancelling someone else's request, or one already decided.
 * - A warden re-deciding an APPROVED/REJECTED request (double gate passes).
 * - A student calling warden endpoints, or reviewing their own leave.
 * - Realtime regressions: wardens must see new requests, students must see
 *   the decision, and students must never receive the warden-only fan-out.
 */
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { clearAlertsAndQueue, resetDatabaseOnly } from './helpers/db';
import { bearer, createStudent, createWarden, tokenFor } from './helpers/factories';
import {
  connectAs,
  disconnectAll,
  recordEvents,
  waitForEvent,
} from './helpers/socketClient';
import { startTestServer, type TestServer } from './helpers/testServer';

let server!: TestServer;
const sockets: Socket[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function futureWindow(hoursFromNow = 1): { departureTime: string; expectedReturn: string } {
  const departure = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const expectedReturn = new Date(departure.getTime() + 4 * 60 * 60 * 1000);
  return { departureTime: departure.toISOString(), expectedReturn: expectedReturn.toISOString() };
}

function leavePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'DAY_OUTING',
    reason: 'Family function at home',
    destination: 'Pune',
    ...futureWindow(),
    ...overrides,
  };
}

function submitLeave(token: string, overrides: Record<string, unknown> = {}) {
  return request(server.app)
    .post('/leaves')
    .set('Authorization', bearer(token))
    .send(leavePayload(overrides));
}

function review(
  token: string,
  leaveId: string,
  path: 'review' | 'approve' | 'reject',
  body: Record<string, unknown> = {},
) {
  return request(server.app)
    .patch(`/leaves/${leaveId}/${path}`)
    .set('Authorization', bearer(token))
    .send(path === 'review' ? { status: 'APPROVED', ...body } : body);
}

async function connect(token: string): Promise<Socket> {
  const socket = await connectAs(server.url, token);
  sockets.push(socket);
  return socket;
}

beforeAll(async () => {
  await resetDatabaseOnly();
  server = await startTestServer();
}, 60_000);

beforeEach(async () => {
  await prisma.leaveRequest.deleteMany();
  await clearAlertsAndQueue();
});

afterEach(() => {
  disconnectAll(sockets);
  sockets.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('POST /leaves — student creates a request', () => {
  it('creates a SUBMITTED request owned by the caller', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');

    const response = await submitLeave(token);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('SUBMITTED');
    expect(response.body.studentId).toBe(student.id);
    expect(response.body.gatePassCode).toBeNull();
    expect(response.body.student.email).toBe(student.email);

    const stored = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(stored.type).toBe('DAY_OUTING');
  });

  it('accepts the singular /leave alias', async () => {
    const student = await createStudent();

    const response = await request(server.app)
      .post('/leave')
      .set('Authorization', bearer(tokenFor(student, 'STUDENT')))
      .send(leavePayload());

    expect(response.status).toBe(201);
  });

  it('rejects missing required fields with 400', async () => {
    const student = await createStudent();

    const response = await submitLeave(tokenFor(student, 'STUDENT'), { reason: undefined });

    expect(response.status).toBe(400);
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it('rejects an unknown leave type with 400', async () => {
    const student = await createStudent();

    const response = await submitLeave(tokenFor(student, 'STUDENT'), { type: 'VACATION' });

    expect(response.status).toBe(400);
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it('rejects a return that is not after departure', async () => {
    const student = await createStudent();
    const window = futureWindow(3);

    const response = await submitLeave(tokenFor(student, 'STUDENT'), {
      departureTime: window.expectedReturn,
      expectedReturn: window.departureTime,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/expectedReturn must be after departureTime/);
  });

  it('rejects a departure in the past', async () => {
    const student = await createStudent();
    const past = new Date(Date.now() - 60 * 60 * 1000);

    const response = await submitLeave(tokenFor(student, 'STUDENT'), {
      departureTime: past.toISOString(),
      expectedReturn: new Date(past.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/must not be in the past/);
  });

  it('rejects an invalid date string with 400', async () => {
    const student = await createStudent();

    const response = await submitLeave(tokenFor(student, 'STUDENT'), {
      departureTime: 'tomorrow-ish',
    });

    expect(response.status).toBe(400);
  });

  it('rejects a too-short reason with 400', async () => {
    const student = await createStudent();

    const response = await submitLeave(tokenFor(student, 'STUDENT'), { reason: 'x' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/reason must be 3-500/);
  });

  it('forbids a warden from filing a leave as a student (403)', async () => {
    const warden = await createWarden();

    const response = await submitLeave(tokenFor(warden, 'WARDEN'));

    expect(response.status).toBe(403);
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it('requires authentication (401)', async () => {
    const response = await request(server.app).post('/leaves').send(leavePayload());
    expect(response.status).toBe(401);
  });
});

describe('GET /leaves/my + cancellation', () => {
  it('lists only the caller’s requests', async () => {
    const owner = await createStudent();
    const other = await createStudent();
    await submitLeave(tokenFor(owner, 'STUDENT'));
    await submitLeave(tokenFor(other, 'STUDENT'));

    const response = await request(server.app)
      .get('/leaves/my')
      .set('Authorization', bearer(tokenFor(owner, 'STUDENT')));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].studentId).toBe(owner.id);
  });

  it('cancels a SUBMITTED request via DELETE', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');
    const created = await submitLeave(token);

    const response = await request(server.app)
      .delete(`/leaves/${created.body.id}`)
      .set('Authorization', bearer(token));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
  });

  it('cancels via PATCH /:id/cancel (verb-style alias)', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');
    const created = await submitLeave(token);

    const response = await request(server.app)
      .patch(`/leaves/${created.body.id}/cancel`)
      .set('Authorization', bearer(token));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
  });

  it('refuses to cancel another student’s request (403)', async () => {
    const owner = await createStudent();
    const intruder = await createStudent();
    const created = await submitLeave(tokenFor(owner, 'STUDENT'));

    const response = await request(server.app)
      .delete(`/leaves/${created.body.id}`)
      .set('Authorization', bearer(tokenFor(intruder, 'STUDENT')));

    expect(response.status).toBe(403);
    const stored = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.status).toBe('SUBMITTED');
  });

  it('refuses to cancel after the warden has decided (409)', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const created = await submitLeave(tokenFor(student, 'STUDENT'));
    await review(tokenFor(warden, 'WARDEN'), created.body.id, 'approve');

    const response = await request(server.app)
      .delete(`/leaves/${created.body.id}`)
      .set('Authorization', bearer(tokenFor(student, 'STUDENT')));

    expect(response.status).toBe(409);
  });
});

describe('warden review', () => {
  it('approves with a gate pass and stamps the reviewer', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const created = await submitLeave(tokenFor(student, 'STUDENT'));

    const response = await review(tokenFor(warden, 'WARDEN'), created.body.id, 'approve');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('APPROVED');
    expect(response.body.gatePassCode).toMatch(/^HG-[0-9A-F]{6}$/);
    expect(response.body.reviewedBy).toBe(warden.id);
    expect(response.body.reviewedAt).not.toBeNull();
  });

  it('rejects and returns the decision note to the student view', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const created = await submitLeave(tokenFor(student, 'STUDENT'));

    const response = await review(tokenFor(warden, 'WARDEN'), created.body.id, 'reject', {
      decisionNote: 'Guardian consent not on file',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REJECTED');
    expect(response.body.reviewRemarks).toBe('Guardian consent not on file');
    expect(response.body.gatePassCode).toBeNull();
  });

  it('keeps the legacy review endpoint working with reviewRemarks', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const created = await submitLeave(tokenFor(student, 'STUDENT'));

    const response = await review(tokenFor(warden, 'WARDEN'), created.body.id, 'review', {
      status: 'REJECTED',
      reviewRemarks: 'Exam week',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REJECTED');
    expect(response.body.reviewRemarks).toBe('Exam week');
  });

  it('refuses a second decision on an already-decided request (409)', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const created = await submitLeave(tokenFor(student, 'STUDENT'));
    await review(tokenFor(warden, 'WARDEN'), created.body.id, 'approve');

    const response = await review(tokenFor(warden, 'WARDEN'), created.body.id, 'reject');

    expect(response.status).toBe(409);
    const stored = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.status).toBe('APPROVED');
  });

  it('forbids a student from approving a request (403)', async () => {
    const student = await createStudent();
    const created = await submitLeave(tokenFor(student, 'STUDENT'));

    const response = await review(tokenFor(student, 'STUDENT'), created.body.id, 'approve');

    expect(response.status).toBe(403);
  });

  it('returns 404 for an unknown leave id', async () => {
    const warden = await createWarden();

    const response = await review(
      tokenFor(warden, 'WARDEN'),
      '00000000-0000-0000-0000-000000000000',
      'approve',
    );

    expect(response.status).toBe(404);
  });
});

describe('warden list filters', () => {
  it('filters by status, type and departure window', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const token = tokenFor(student, 'STUDENT');

    const near = await submitLeave(token);
    const far = await submitLeave(token, { type: 'HOME_VISIT', ...futureWindow(24 * 30) });
    await review(tokenFor(warden, 'WARDEN'), near.body.id, 'approve');

    const wardenToken = tokenFor(warden, 'WARDEN');

    const pending = await request(server.app)
      .get('/leaves?status=SUBMITTED')
      .set('Authorization', bearer(wardenToken));
    expect(pending.status).toBe(200);
    expect(pending.body.data.map((row: { id: string }) => row.id)).toEqual([far.body.id]);

    const approved = await request(server.app)
      .get('/leaves?status=APPROVED&type=DAY_OUTING')
      .set('Authorization', bearer(wardenToken));
    expect(approved.status).toBe(200);
    expect(approved.body.data.map((row: { id: string }) => row.id)).toEqual([near.body.id]);

    const windowStart = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const withinWindow = await request(server.app)
      .get(`/leaves?from=${encodeURIComponent(windowStart)}&limit=100`)
      .set('Authorization', bearer(wardenToken));
    expect(withinWindow.status).toBe(200);
    expect(withinWindow.body.data.map((row: { id: string }) => row.id)).toEqual([far.body.id]);
  });

  it('rejects an invalid date filter with 400', async () => {
    const warden = await createWarden();

    const response = await request(server.app)
      .get('/leaves?from=not-a-date')
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')));

    expect(response.status).toBe(400);
  });

  it('forbids a student from listing all leaves (403)', async () => {
    const student = await createStudent();

    const response = await request(server.app)
      .get('/leaves')
      .set('Authorization', bearer(tokenFor(student, 'STUDENT')));

    expect(response.status).toBe(403);
  });
});

describe('realtime updates', () => {
  it('notifies wardens on create and the owning student on the decision', async () => {
    const student = await createStudent();
    const warden = await createWarden();

    const wardenSocket = await connect(tokenFor(warden, 'WARDEN'));
    const studentSocket = await connect(tokenFor(student, 'STUDENT'));

    const createdEvent = waitForEvent<{ id: string }>(wardenSocket, 'leave:created');
    const created = await submitLeave(tokenFor(student, 'STUDENT'));
    expect(created.status).toBe(201);
    expect((await createdEvent).id).toBe(created.body.id);

    const updatedEvent = waitForEvent<{ id: string; status: string }>(
      studentSocket,
      'leave:updated',
    );
    await review(tokenFor(warden, 'WARDEN'), created.body.id, 'approve');
    const decision = await updatedEvent;
    expect(decision.id).toBe(created.body.id);
    expect(decision.status).toBe('APPROVED');
  });

  it('never sends the warden-only create fan-out to students', async () => {
    const student = await createStudent();
    const warden = await createWarden();

    const studentSocket = await connect(tokenFor(student, 'STUDENT'));
    await connect(tokenFor(warden, 'WARDEN'));
    const leaked = recordEvents(studentSocket, 'leave:created');

    await submitLeave(tokenFor(student, 'STUDENT'));
    await sleep(200);

    expect(leaked).toHaveLength(0);
  });

  it('tells both wardens and the student when a request is cancelled', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const token = tokenFor(student, 'STUDENT');
    const created = await submitLeave(token);

    const wardenSocket = await connect(tokenFor(warden, 'WARDEN'));
    const studentSocket = await connect(token);

    const wardenEvent = waitForEvent<{ id: string }>(wardenSocket, 'leave:cancelled');
    const studentEvent = waitForEvent<{ id: string; status: string }>(
      studentSocket,
      'leave:cancelled',
    );

    await request(server.app)
      .patch(`/leaves/${created.body.id}/cancel`)
      .set('Authorization', bearer(token));

    expect((await wardenEvent).id).toBe(created.body.id);
    const forStudent = await studentEvent;
    expect(forStudent.id).toBe(created.body.id);
    expect(forStudent.status).toBe('CANCELLED');
  });
});
