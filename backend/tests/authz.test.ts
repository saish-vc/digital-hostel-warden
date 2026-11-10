/**
 * WHY THIS FILE EXISTS
 * Role checks are tested per-route in auth.test.ts; this file tests the
 * cross-cutting rules that do not belong to a single route's happy path:
 * one student cannot act on another student's alert, a warden cannot act as a
 * student, and identity always comes from the JWT — never from the body.
 *
 * WHAT IT PROTECTS AGAINST
 * - A student acknowledging someone else's emergency (403).
 * - A warden creating an SOS attributed to a student (403).
 * - A warden registering an FCM token onto another warden's account by
 *   passing a `wardenId` in the request body (the route must ignore it).
 */
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
  await prisma.deviceToken.deleteMany();
});

afterAll(async () => {
  await server.close();
});

describe('cross-student authorization', () => {
  it('forbids Student A from acknowledging Student B’s alert', async () => {
    const studentA = await createStudent();
    const studentB = await createStudent();
    const alert = await createAlert(studentB.id);

    const response = await request(server.app)
      .patch(`/alerts/${alert.id}/acknowledge`)
      .set('Authorization', bearer(tokenFor(studentA, 'STUDENT')));

    expect(response.status).toBe(403);

    const stored = await prisma.emergencyAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.status).toBe('PENDING');
    expect(stored.acknowledgedBy).toBeNull();
  });
});

describe('warden role boundaries', () => {
  it('forbids a warden from creating an alert as a student', async () => {
    const warden = await createWarden();

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')))
      .send({ type: 'MEDICAL' });

    expect(response.status).toBe(403);
    expect(await prisma.emergencyAlert.count()).toBe(0);
  });

  it('ignores a body wardenId when registering an FCM token', async () => {
    const wardenA = await createWarden();
    const wardenB = await createWarden();

    const response = await request(server.app)
      .post('/wardens/fcm-token')
      .set('Authorization', bearer(tokenFor(wardenA, 'WARDEN')))
      .send({ token: 'token-identity-test', wardenId: wardenB.id });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    const stored = await prisma.deviceToken.findUniqueOrThrow({
      where: { token: 'token-identity-test' },
    });
    expect(stored.wardenId).toBe(wardenA.id);
    expect(stored.wardenId).not.toBe(wardenB.id);
  });

  it('refuses an FCM token registration from a student', async () => {
    const student = await createStudent();

    const response = await request(server.app)
      .post('/wardens/fcm-token')
      .set('Authorization', bearer(tokenFor(student, 'STUDENT')))
      .send({ token: 'token-from-student' });

    expect(response.status).toBe(403);
    expect(await prisma.deviceToken.count()).toBe(0);
  });

  it('rejects an empty or whitespace-only FCM token with 400', async () => {
    const warden = await createWarden();

    const response = await request(server.app)
      .post('/wardens/fcm-token')
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')))
      .send({ token: '   ' });

    expect(response.status).toBe(400);
  });

  it('rejects an over-long FCM token with 400', async () => {
    const warden = await createWarden();

    const response = await request(server.app)
      .post('/wardens/fcm-token')
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')))
      .send({ token: 'x'.repeat(5_000) });

    expect(response.status).toBe(400);
  });
});

describe('device token ownership', () => {
  it('deletes the calling warden’s own token on logout', async () => {
    const warden = await createWarden();
    await prisma.deviceToken.create({
      data: { wardenId: warden.id, token: 'token-to-delete' },
    });

    const response = await request(server.app)
      .delete('/wardens/fcm-token')
      .set('Authorization', bearer(tokenFor(warden, 'WARDEN')))
      .send({ token: 'token-to-delete' });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(1);
    expect(await prisma.deviceToken.count({ where: { token: 'token-to-delete' } })).toBe(0);
  });

  it('does not delete a token that belongs to another warden', async () => {
    const wardenA = await createWarden();
    const wardenB = await createWarden();
    await prisma.deviceToken.create({
      data: { wardenId: wardenB.id, token: 'token-owned-by-b' },
    });

    const response = await request(server.app)
      .delete('/wardens/fcm-token')
      .set('Authorization', bearer(tokenFor(wardenA, 'WARDEN')))
      .send({ token: 'token-owned-by-b' });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(0);
    expect(
      await prisma.deviceToken.count({ where: { token: 'token-owned-by-b' } }),
    ).toBe(1);
  });
});
