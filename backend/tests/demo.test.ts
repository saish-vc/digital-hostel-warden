/**
 * WHY THIS FILE EXISTS
 * The resolve flow closes the alert lifecycle (PENDING -> ACKNOWLEDGED ->
 * RESOLVED) and the history endpoints are the viva's audit-trail slide.
 * This suite pins the contract the demo script narrates:
 *
 * 1. A PENDING alert CANNOT be resolved: 409 invalid_transition.
 * 2. ACKNOWLEDGED -> resolve -> RESOLVED, resolvedAt set (200).
 * 3. Double-resolve is idempotent (200 again, counter unchanged).
 * 4. The student's private room receives the RESOLVED alert via the SAME
 *    alert:updated event the acknowledge flow uses (no new client code).
 * 5. /alerts/history filters (status/date/name), paginates.
 * 6. /alerts/history.csv streams text/csv with the 8 table columns.
 *
 * Isolation follows the house pattern: resetDatabaseOnly + factories with
 * UUID emails, clearAlertsAndQueue between tests.
 */
import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alertsResolvedTotal,
  resetMetricsForTests,
} from '../src/config/metrics';
import { prisma } from '../src/config/prisma';
import {
  clearAlertsAndQueue,
  resetDatabaseOnly,
} from './helpers/db';
import {
  bearer,
  createAlert,
  createStudent,
  createWarden,
  tokenFor,
} from './helpers/factories';
import { connectAs, disconnectAll, waitForEvent } from './helpers/socketClient';
import { startTestServer, type TestServer } from './helpers/testServer';

let server!: TestServer;
const sockets: Socket[] = [];

let wardenToken!: string;
let warden2Token!: string;
let studentToken!: string;
let studentId!: string;

/**
 * Create an alert straight through the API (keeps the created counter and
 * the room emissions exactly like production), optionally acknowledge it.
 */
async function makeAlert(status: 'PENDING' | 'ACKNOWLEDGED'): Promise<string> {
  const response = await request(server.app)
    .post('/alerts')
    .set('Authorization', bearer(studentToken))
    .send({ type: 'MEDICAL' });
  expect(response.status).toBe(201);
  const id = (response.body as { id: string }).id;

  if (status === 'ACKNOWLEDGED') {
    const ack = await request(server.app)
      .patch(`/alerts/${id}/acknowledge`)
      .set('Authorization', bearer(wardenToken));
    expect(ack.status).toBe(200);
  }
  return id;
}

beforeAll(async () => {
  await resetDatabaseOnly();
  server = await startTestServer();

  const warden = await createWarden({ email: 'demo.w1@test.hostel' });
  const warden2 = await createWarden({ email: 'demo.w2@test.hostel' });
  const student = await createStudent();

  wardenToken = tokenFor(warden, 'WARDEN');
  warden2Token = tokenFor(warden2, 'WARDEN');
  studentToken = tokenFor(student, 'STUDENT');
  studentId = student.id;
}, 60_000);

beforeEach(async () => {
  resetMetricsForTests();
});

afterEach(async () => {
  disconnectAll(sockets);
  sockets.length = 0;
  await clearAlertsAndQueue();
});

afterAll(async () => {
  await server.close();
});

describe('PATCH /alerts/:id/resolve', () => {
  it('refuses to resolve a PENDING alert (409 invalid_transition)', async () => {
    const id = await makeAlert('PENDING');

    const response = await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'Told the student to drink water and rest.' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'invalid_transition',
      current: 'PENDING',
      allowed: ['ACKNOWLEDGED'],
    });
  });

  it('validates the resolution note (10-500 chars)', async () => {
    const id = await makeAlert('PENDING');
    const ack = await request(server.app)
      .patch(`/alerts/${id}/acknowledge`)
      .set('Authorization', bearer(wardenToken));
    expect(ack.status).toBe(200);

    const tooShort = await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'ok' });
    expect(tooShort.status).toBe(400);

    const tooLong = await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'a'.repeat(501) });
    expect(tooLong.status).toBe(400);
  });

  it('ACKNOWLEDGED -> resolve -> RESOLVED with resolvedAt, counter runs', async () => {
    const id = await makeAlert('ACKNOWLEDGED');

    const response = await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'Escorted to campus clinic, stable' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'RESOLVED' });
    expect(response.body.resolvedAt).toEqual(expect.any(String));
    expect(response.body.resolutionNote).toBe('Escorted to campus clinic, stable');

    expect(await alertsResolvedTotal.get()).toMatchObject({
      values: [{ value: 1 }],
    });
  });

  it('double-resolve is idempotent: 200, no counter bump', async () => {
    const id = await makeAlert('ACKNOWLEDGED');
    const first = await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'Escorted to campus clinic, stable' });
    expect(first.status).toBe(200);

    const second = await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(warden2Token))
      .send({ resolutionNote: 'Escorted to campus clinic, stable, follow-up done' });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id, status: 'RESOLVED' });

    // The idempotent repeat must NOT have incremented again.
    expect(await alertsResolvedTotal.get()).toMatchObject({
      values: [{ value: 1 }],
    });
  });

  it('tells the STUDENT about the resolution via alert:updated', async () => {
    const id = await makeAlert('ACKNOWLEDGED');

    const studentSocket = await connectAs(server.url, studentToken);
    sockets.push(studentSocket);
    const updated = waitForEvent<{ id: string; status: string }>(
      studentSocket,
      'alert:updated',
    );

    await request(server.app)
      .patch(`/alerts/${id}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'Escorted to campus clinic, stable' });

    const payload = await updated;
    expect(payload).toMatchObject({ id, status: 'RESOLVED' });
  });
});

describe('GET /alerts/history', () => {
  it('returns RESOLVED + active rows newest-first and paginates', async () => {
    const resolvedId = await makeAlert('ACKNOWLEDGED');
    await request(server.app)
      .patch(`/alerts/${resolvedId}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'Escorted to campus clinic, stable' });
    const pendingId = await makeAlert('PENDING');

    // Default: every status, createdAt DESC -> pending first.
    const all = await request(server.app)
      .get('/alerts/history')
      .set('Authorization', bearer(wardenToken));
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBe(2);
    expect(all.body.data.map((r: { id: string }) => r.id)).toEqual([pendingId, resolvedId]);

    // status=RESOLVED filter.
    const resolved = await request(server.app)
      .get('/alerts/history?status=RESOLVED')
      .set('Authorization', bearer(wardenToken));
    expect(resolved.body.data).toHaveLength(1);
    expect(resolved.body.data[0]).toMatchObject({
      id: resolvedId,
      status: 'RESOLVED',
      acknowledgedByName: expect.any(String),
      student: { id: studentId },
    });

    // Page 2 with limit 1 -> the second-newest row (= the first is pending).
    const page2 = await request(server.app)
      .get('/alerts/history?limit=1&page=2')
      .set('Authorization', bearer(wardenToken));
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].id).toBe(resolvedId);
    expect(page2.body.pagination.page).toBe(2);
  });

  it('filters by date range and student name, rejects bad input', async () => {
    await makeAlert('PENDING');

    const future = await request(server.app)
      .get(`/alerts/history?from=${new Date(Date.now() + 60_000).toISOString()}`)
      .set('Authorization', bearer(wardenToken));
    expect(future.body.pagination.total).toBe(0);

    const byName = await request(server.app)
      .get('/alerts/history?studentName=zJobsNoMatch')
      .set('Authorization', bearer(wardenToken));
    expect(byName.body.pagination.total).toBe(0);

    // A real substring must MATCH. Regression guard for the fix that moved
    // the name predicate INSIDE each status branch: filtering it after the
    // branch LIMIT silently dropped genuine matches.
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    const byRealName = await request(server.app)
      .get(`/alerts/history?studentName=${encodeURIComponent(student.name.slice(0, 4))}`)
      .set('Authorization', bearer(wardenToken));
    expect(byRealName.body.pagination.total).toBe(1);
    expect(byRealName.body.data[0]).toMatchObject({ student: { id: studentId } });

    const badStatus = await request(server.app)
      .get('/alerts/history?status=DISMISSED')
      .set('Authorization', bearer(wardenToken));
    expect(badStatus.status).toBe(400);

    const badDate = await request(server.app)
      .get('/alerts/history?from=not-a-date')
      .set('Authorization', bearer(wardenToken));
    expect(badDate.status).toBe(400);
  });

  it('rejects non-wardens (student token)', async () => {
    const response = await request(server.app)
      .get('/alerts/history')
      .set('Authorization', bearer(studentToken));
    expect(response.status).toBe(403);
  });
});

describe('GET /alerts/history.csv', () => {
  it('streams text/csv with the 8 audit columns', async () => {
    const resolvedId = await makeAlert('ACKNOWLEDGED');
    await request(server.app)
      .patch(`/alerts/${resolvedId}/resolve`)
      .set('Authorization', bearer(wardenToken))
      .send({ resolutionNote: 'Note, with commas "and quotes"' });

    const response = await request(server.app)
      .get('/alerts/history.csv')
      .set('Authorization', bearer(wardenToken));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');

    const lines = response.text.trim().split('\r\n');
    // Header + 1 row.
    expect(lines).toHaveLength(2);
    // Date/Time, Student, Room, Type, Status, Acknowledged by, Resolved at, Resolution note
    expect(lines[0]).toBe(
      'Date/Time,Student,Room,Type,Status,Acknowledged by,Resolved at,Resolution note',
    );
    // The comma+quote note escaped per RFC 4180.
    expect(lines[1]).toContain('"Note, with commas ""and quotes"""');
  });

  it('student tokens are refused like every other warden read', async () => {
    const response = await request(server.app)
      .get('/alerts/history.csv')
      .set('Authorization', bearer(studentToken));
    expect(response.status).toBe(403);
  });
});
