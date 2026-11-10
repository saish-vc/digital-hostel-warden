/**
 * WHY THIS FILE EXISTS
 * The SOS row itself is the one thing that must never be lost. This suite
 * pins creation (with and without GPS), coordinate persistence, the
 * acknowledgement state transition, and the warden alert board.
 *
 * WHAT IT PROTECTS AGAINST
 * - A GPS failure blocking or rejecting an SOS.
 * - Coordinates silently disappearing between HTTP and Postgres.
 * - Acknowledge not recording who/when, or overwriting an existing
 *   acknowledgement (two wardens racing).
 * - Invalid alert types reaching the database (including SQL-injection-shaped
 *   strings) or corrupting it.
 *
 * ACKNOWLEDGE IDEMPOTENCY: the product preference is a 200 for a repeated
 * acknowledge in a medical system. The current implementation answers 409
 * ("Alert is already ACKNOWLEDGED") and does NOT overwrite the original
 * acknowledger. That is the behaviour this suite locks in; if the product
 * decision changes to 200-idempotent, this test is the one to update
 * deliberately (returning 200 with the existing row).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { clearAlertsAndQueue, resetDatabaseOnly } from './helpers/db';
import { bearer, createAlert, createStudent, createWarden, tokenFor } from './helpers/factories';
import { startTestServer, type TestServer } from './helpers/testServer';

let server!: TestServer;

beforeAll(async () => {
  await resetDatabaseOnly();
  server = await startTestServer();
}, 60_000);

beforeEach(async () => {
  await clearAlertsAndQueue();
});

afterAll(async () => {
  await server.close();
});

describe('POST /alerts', () => {
  it('creates a PENDING alert for the authenticated student', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer(token))
      .send({ type: 'MEDICAL' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      studentId: student.id,
      status: 'PENDING',
      type: 'MEDICAL',
    });

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.status).toBe('PENDING');
    expect(stored.studentId).toBe(student.id);
  });

  it('persists latitude, longitude and accuracy together', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer(token))
      .send({
        type: 'MEDICAL',
        latitude: 12.9716,
        longitude: 77.5946,
        locationAccuracy: 8.5,
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      latitude: 12.9716,
      longitude: 77.5946,
      locationAccuracy: 8.5,
    });

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.latitude).toBeCloseTo(12.9716, 4);
    expect(stored.longitude).toBeCloseTo(77.5946, 4);
    expect(stored.locationAccuracy).toBeCloseTo(8.5, 4);
  });

  it('accepts an alert without coordinates — a GPS failure must never block the SOS', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer(token))
      .send({ type: 'MEDICAL' });

    expect(response.status).toBe(201);
    expect(response.body.latitude).toBeNull();
    expect(response.body.longitude).toBeNull();

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.latitude).toBeNull();
    expect(stored.longitude).toBeNull();
  });

  it('normalises the Flutter client’s "Medical" type to MEDICAL', async () => {
    // The student app sends type: "Medical"; the dashboard and SMS templates
    // expect the canonical enum spelling.
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer(token))
      .send({ type: 'Medical' });

    expect(response.status).toBe(201);
    expect(response.body.type).toBe('MEDICAL');
  });

  it('rejects an invalid type (SQL injection attempt) with 400 and leaves the DB intact', async () => {
    const student = await createStudent();
    const token = tokenFor(student, 'STUDENT');
    const studentsBefore = await prisma.student.count();

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer(token))
      .send({ type: 'MEDICAL\'); DROP TABLE "Student"; --' });

    expect(response.status).toBe(400);
    expect(await prisma.emergencyAlert.count()).toBe(0);
    expect(await prisma.student.count()).toBe(studentsBefore);
  });
});

describe('PATCH /alerts/:id/acknowledge', () => {
  it('acknowledges a PENDING alert and records who and when', async () => {
    const student = await createStudent();
    const warden = await createWarden();
    const alert = await createAlert(student.id);

    const response = await request(server.app)
      .patch(`/alerts/${alert.id}/acknowledge`)
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: alert.id,
      status: 'ACKNOWLEDGED',
      acknowledgedBy: warden.id,
    });
    expect(response.body.acknowledgedAt).not.toBeNull();

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.status).toBe('ACKNOWLEDGED');
    expect(stored.acknowledgedBy).toBe(warden.id);
    expect(stored.acknowledgedAt).toBeInstanceOf(Date);
  });

  it('returns 404 for a nonexistent alert', async () => {
    const warden = await createWarden();

    const response = await request(server.app)
      .patch(`/alerts/${randomUUID()}/acknowledge`)
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')));

    expect(response.status).toBe(404);
  });

  it('returns 409 for an already-acknowledged alert and keeps the first acknowledger', async () => {
    const student = await createStudent();
    const firstWarden = await createWarden();
    const secondWarden = await createWarden();
    const alert = await createAlert(student.id, {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      acknowledgedBy: firstWarden.id,
    });

    const response = await request(server.app)
      .patch(`/alerts/${alert.id}/acknowledge`)
      .set('Authorization', bearer(tokenFor(secondWarden, 'WARDEN')));

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('already ACKNOWLEDGED');

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.acknowledgedBy).toBe(firstWarden.id);
  });
});

describe('GET /alerts', () => {
  it('returns every alert for a warden, newest first, with student details', async () => {
    const studentA = await createStudent({ name: 'Aarav Test', roomNumber: 'B-314' });
    const studentB = await createStudent({ name: 'Diya Test', roomNumber: 'A-102' });
    const warden = await createWarden();

    const older = await createAlert(studentA.id, { type: 'MEDICAL' });
    const newer = await createAlert(studentB.id, { type: 'FIRE' });

    const response = await request(server.app)
      .get('/alerts')
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(2);

    const byId = new Map(response.body.map((alert: { id: string }) => [alert.id, alert]));
    expect(byId.get(older.id).student).toMatchObject({
      id: studentA.id,
      name: 'Aarav Test',
      roomNumber: 'B-314',
      emergencyContact: studentA.emergencyContact,
    });
    expect(byId.get(newer.id).student).toMatchObject({
      id: studentB.id,
      name: 'Diya Test',
      roomNumber: 'A-102',
    });

    // The board is ordered newest first by createdAt.
    expect(response.body[0].id).toBe(newer.id);
    expect(response.body[1].id).toBe(older.id);
  });
});
