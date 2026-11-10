import { Router } from 'express';
import type { Redis } from 'ioredis';
import { instanceId } from '../config/instance';
import { prisma } from '../config/prisma';
import { createAdapterConnection } from '../config/redis';

/**
 * GET /health — liveness. Unauthenticated, used by the load balancer and by
 * the multi-instance test.
 *
 * Returns the identity of the instance that answered, so hitting the LB
 * repeatedly visibly rotates between 3001 / 3002 / 3003.
 *
 * E6: liveness is about "the process can serve SOS", not "every dependency is
 * perfect". A Redis outage degrades escalation/rate limiting but SOS still
 * works, so /health stays 200 and reports the degraded component. Only a
 * Postgres outage is fatal (no alert can be persisted) and returns 503.
 *
 * - 200 `{ status: "ok",       instanceId, redis: "ok",   db: "ok"   }`
 * - 200 `{ status: "degraded", instanceId, redis: "down", db: "ok"   }`
 * - 503 `{ status: "unhealthy",instanceId, redis,         db: "down" }`
 *
 * GET /health/ready — readiness. 503 when Redis OR Postgres is down. Use this
 * for "should traffic be routed here", not for liveness restarts. Prometheus
 * scrapes /metrics (not /health), so counter collection is unaffected by
 * either status.
 *
 * The Redis ping uses its own lazily-created client. It is NOT the BullMQ
 * connection and NOT either adapter client: ping/quit are the only commands
 * safe to run on a subscriber connection, and we do not want health traffic
 * competing with queue commands. This is connection #4 in the per-instance
 * budget documented in src/config/redis.ts.
 */
const router = Router();

let healthRedis: Redis | null = null;

function getHealthRedis(): Redis {
  if (!healthRedis) {
    healthRedis = createAdapterConnection();
  }
  return healthRedis;
}

/** Bound the ping: a down Redis must not hang the health endpoint. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type DependencyStatus = 'ok' | 'down';

interface HealthBody {
  status: 'ok' | 'degraded' | 'unhealthy';
  instanceId: string;
  redis: DependencyStatus;
  db: DependencyStatus;
}

async function probe(): Promise<HealthBody> {
  let redis: DependencyStatus = 'ok';
  try {
    await withTimeout(getHealthRedis().ping(), 1_000);
  } catch {
    redis = 'down';
  }

  let db: DependencyStatus = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'down';
  }

  const status = db === 'down' ? 'unhealthy' : redis === 'down' ? 'degraded' : 'ok';
  return { status, instanceId: instanceId(), redis, db };
}

router.get('/health', async (_req, res) => {
  const body = await probe();
  // Liveness: 200 unless the alert store itself is unavailable.
  res.status(body.db === 'ok' ? 200 : 503).json(body);
});

router.get('/health/ready', async (_req, res) => {
  const body = await probe();
  const ready = body.redis === 'ok' && body.db === 'ok';
  res.status(ready ? 200 : 503).json(body);
});

export default router;
