/**
 * WHY THIS FILE EXISTS
 * Authentication is the only thing standing between an anonymous caller and
 * a student's medical data. This suite pins the login contract (status codes,
 * token payload, no token on failure) and the role gate on every alert route.
 *
 * WHAT IT PROTECTS AGAINST
 * - Login leaking whether an email exists (must be 401, never 404).
 * - A token without a role reaching a protected route.
 * - Accepting malformed or expired JWTs.
 * - A student reading the warden alert board, or a warden creating an SOS.
 *
 * CONTRACT NOTE: this codebase uses UPPERCASE roles ("STUDENT" / "WARDEN")
 * in both the login request body and the JWT payload. The phase-1 clients all
 * send uppercase, so the tests assert the real contract, not the lowercase
 * spelling used loosely in planning notes.
 */
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { resetDatabaseAndQueue } from './helpers/db';
import { TEST_PASSWORD } from './helpers/factories';
import { startTestServer, type TestServer } from './helpers/testServer';

let server!: TestServer;
let student!: { id: string; email: string };
let warden!: { id: string; email: string };

beforeAll(async () => {
  await resetDatabaseAndQueue();
  student = await prisma.student.findFirstOrThrow({ orderBy: { email: 'asc' } });
  warden = await prisma.warden.findFirstOrThrow({ orderBy: { email: 'asc' } });
  server = await startTestServer();
}, 60_000);

afterAll(async () => {
  await server.close();
});

function login(email: string, password: string, role: 'STUDENT' | 'WARDEN') {
  return request(server.app).post('/auth/login').send({ email, password, role });
}

describe('POST /auth/login', () => {
  it('returns 200 and a JWT carrying { id, role } for a valid student', async () => {
    const response = await login(student.email, TEST_PASSWORD, 'STUDENT');

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: student.id, role: 'STUDENT' });

    const decoded = jwt.decode(response.body.token) as Record<string, unknown> | null;
    expect(decoded).toMatchObject({ id: student.id, role: 'STUDENT' });
  });

  it('returns 200 and a JWT carrying { id, role } for a valid warden', async () => {
    const response = await login(warden.email, TEST_PASSWORD, 'WARDEN');

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: warden.id, role: 'WARDEN' });

    const decoded = jwt.decode(response.body.token) as Record<string, unknown> | null;
    expect(decoded).toMatchObject({ id: warden.id, role: 'WARDEN' });
  });

  it('returns 401 with no token for a wrong password', async () => {
    const response = await login(student.email, 'definitely-the-wrong-password', 'STUDENT');

    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty('token');
  });

  it('returns 401 (never 404) for a nonexistent email, so user existence does not leak', async () => {
    const response = await login('nobody@test.hostel', TEST_PASSWORD, 'STUDENT');

    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty('token');
    expect(response.body.error).toBe('Invalid credentials');
  });
});

describe('JWT coverage on /alerts', () => {
  it('rejects a student JWT on GET /alerts with 403', async () => {
    const loginResponse = await login(student.email, TEST_PASSWORD, 'STUDENT');

    const response = await request(server.app)
      .get('/alerts')
      .set('Authorization', `Bearer ${loginResponse.body.token}`);

    expect(response.status).toBe(403);
  });

  it('rejects a warden JWT on POST /alerts with 403', async () => {
    const loginResponse = await login(warden.email, TEST_PASSWORD, 'WARDEN');

    const response = await request(server.app)
      .post('/alerts')
      .set('Authorization', `Bearer ${loginResponse.body.token}`)
      .send({ type: 'MEDICAL' });

    expect(response.status).toBe(403);
  });

  it('rejects a request with no Authorization header with 401', async () => {
    const response = await request(server.app).get('/alerts');

    expect(response.status).toBe(401);
  });

  it('rejects a malformed JWT with 401', async () => {
    const response = await request(server.app)
      .get('/alerts')
      .set('Authorization', 'Bearer this.is.not.a.jwt');

    expect(response.status).toBe(401);
  });

  it('rejects a correctly signed JWT whose payload has an unknown role', async () => {
    const forged = jwt.sign(
      { id: student.id, role: 'ADMIN' },
      process.env.JWT_SECRET!,
    );

    const response = await request(server.app)
      .get('/alerts')
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });

  it('rejects an expired JWT with 401', async () => {
    const expired = jwt.sign(
      { id: student.id, role: 'STUDENT' },
      process.env.JWT_SECRET!,
      { expiresIn: '-10s' },
    );

    const response = await request(server.app)
      .get('/alerts')
      .set('Authorization', `Bearer ${expired}`);

    expect(response.status).toBe(401);
  });
});
