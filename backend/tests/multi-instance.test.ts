/**
 * WHY THIS FILE EXISTS
 * This is the acceptance test for the multi-instance change. Everything else
 * can be green with an in-memory adapter and still fail in production the
 * moment two API processes exist: an alert created on instance A would only
 * reach wardens whose sockets are attached to A.
 *
 * WHAT IT PROVES
 * - A socket connected to :3001 and a socket connected to :3002 both receive
 *   `alert:new` emitted by :3001 within 500ms (Redis adapter pub/sub works).
 * - Acknowledge on :3002 reaches the socket on :3001 within 500ms.
 * - Each instance reports its own identity from GET /health.
 *
 * HOW IT RUNS
 * The test spawns two real API processes (`node --import tsx src/index.ts`)
 * on ports 3001 and 3002. They inherit the test DATABASE_URL / REDIS_URL from
 * tests/helpers/testEnv.ts, so they use the disposable test Postgres and
 * Redis DB 1 — never dev. Processes are killed in afterAll.
 *
 * It is excluded from `npm test` (see vitest.config.ts) because it is slower
 * and owns fixed ports. Run it standalone:
 *
 *   npm run test:multi-instance
 *   # or
 *   npm run test -- tests/multi-instance.test.ts
 *
 * Prerequisite: Postgres + Redis up (`npm run test:db:up`) and ports
 * 3001/3002 free. There is intentionally no worker process: the delayed
 * escalation job merely sits in Redis (well beyond the 500ms test window),
 * so no SMS is attempted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { bearer, createStudent, createWarden, tokenFor } from './helpers/factories';
import { flushTestRedis } from './helpers/redisCleanup';
import {
  connectAs,
  disconnectAll,
  waitForEvent,
} from './helpers/socketClient';

const API_A = 'http://127.0.0.1:3001';
const API_B = 'http://127.0.0.1:3002';

interface Instance {
  port: number;
  child: ChildProcess;
  logs: string[];
}

const instances: Instance[] = [];
const sockets: Socket[] = [];
let studentId: string | null = null;
let wardenAId: string | null = null;
let wardenBId: string | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnInstance(port: number): Instance {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));

  return { port, child, logs };
}

async function waitForHealth(instance: Instance, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(
        `API instance on :${instance.port} exited with code ${instance.child.exitCode}:\n` +
          instance.logs.join(''),
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/health`);
      if (response.ok) {
        const body = (await response.json()) as { instanceId?: string };
        if (body.instanceId === String(instance.port)) {
          return;
        }
      }
    } catch {
      // Not listening yet.
    }

    await sleep(200);
  }

  throw new Error(
    `API instance on :${instance.port} did not become healthy in ${timeoutMs}ms.\n` +
      instance.logs.join(''),
  );
}

async function stopInstance(instance: Instance): Promise<void> {
  if (instance.child.exitCode !== null) {
    return;
  }

  instance.child.kill('SIGTERM');
  await Promise.race([once(instance.child, 'exit'), sleep(5_000)]);

  if (instance.child.exitCode === null) {
    instance.child.kill('SIGKILL');
  }
}

beforeAll(async () => {
  // Start from an empty queue: leftover delayed jobs from an earlier run
  // must not be picked up by anything during this test.
  await flushTestRedis();

  const student = await createStudent();
  const wardenA = await createWarden();
  const wardenB = await createWarden();
  studentId = student.id;
  wardenAId = wardenA.id;
  wardenBId = wardenB.id;

  instances.push(spawnInstance(3001), spawnInstance(3002));
  await Promise.all(instances.map((instance) => waitForHealth(instance)));
}, 90_000);

afterAll(async () => {
  disconnectAll(sockets);
  sockets.length = 0;

  await Promise.all(instances.map((instance) => stopInstance(instance)));

  if (studentId) {
    await prisma.emergencyAlert.deleteMany({ where: { studentId } }).catch(() => undefined);
    await prisma.student.deleteMany({ where: { id: studentId } }).catch(() => undefined);
  }
  if (wardenAId || wardenBId) {
    await prisma.warden
      .deleteMany({ where: { id: { in: [wardenAId!, wardenBId!] } } })
      .catch(() => undefined);
  }

  await prisma.$disconnect();
}, 30_000);

describe('multi-instance Socket.IO fan-out', () => {
  it('delivers alert:new and alert:updated across instances within 500ms', async () => {
    // Prove the two ports are genuinely different processes.
    const healthA = (await (await fetch(`${API_A}/health`)).json()) as { instanceId: string };
    const healthB = (await (await fetch(`${API_B}/health`)).json()) as { instanceId: string };
    expect(healthA).toMatchObject({ status: 'ok', instanceId: '3001', redis: 'ok', db: 'ok' });
    expect(healthB).toMatchObject({ status: 'ok', instanceId: '3002', redis: 'ok', db: 'ok' });

    const wardenA = await prisma.warden.findUniqueOrThrow({ where: { id: wardenAId! } });
    const wardenB = await prisma.warden.findUniqueOrThrow({ where: { id: wardenBId! } });
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId! } });

    // Warden A -> instance 3001, Warden B -> instance 3002.
    const socketA = await connectAs(API_A, tokenFor(wardenA, 'WARDEN'));
    const socketB = await connectAs(API_B, tokenFor(wardenB, 'WARDEN'));
    sockets.push(socketA, socketB);

    // Register listeners BEFORE the POST so a fast adapter event cannot be
    // missed, and give each a hard 500ms deadline.
    const newOnA = waitForEvent<{ id: string }>(socketA, 'alert:new', 500);
    const newOnB = waitForEvent<{ id: string }>(socketB, 'alert:new', 500);

    // SOS hits 3001 only.
    const createResponse = await fetch(`${API_A}/alerts`, {
      method: 'POST',
      headers: {
        Authorization: bearer(tokenFor(student, 'STUDENT')),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'MEDICAL' }),
    });
    expect(createResponse.status).toBe(201);
    const alert = (await createResponse.json()) as { id: string };

    const [alertOnA, alertOnB] = await Promise.all([newOnA, newOnB]);
    expect(alertOnA.id).toBe(alert.id);
    expect(alertOnB.id).toBe(alert.id);

    // Acknowledge hits 3002 only; both sockets must still be updated.
    const updatedOnA = waitForEvent<{ id: string; status: string }>(
      socketA,
      'alert:updated',
      500,
    );
    const updatedOnB = waitForEvent<{ id: string; status: string }>(
      socketB,
      'alert:updated',
      500,
    );

    const ackResponse = await fetch(`${API_B}/alerts/${alert.id}/acknowledge`, {
      method: 'PATCH',
      headers: {
        Authorization: bearer(tokenFor(wardenB, 'WARDEN')),
        'Content-Type': 'application/json',
      },
    });
    expect(ackResponse.status).toBe(200);

    const [updatedA, updatedB] = await Promise.all([updatedOnA, updatedOnB]);
    expect(updatedA).toMatchObject({ id: alert.id, status: 'ACKNOWLEDGED' });
    expect(updatedB).toMatchObject({ id: alert.id, status: 'ACKNOWLEDGED' });
  }, 60_000);
});
