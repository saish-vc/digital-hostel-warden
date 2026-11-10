import 'dotenv/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { createApp } from './app';
import { resolvePort, instanceId } from './config/instance';
import { logger } from './config/logger';
import {
  setAlertsByStatus,
  startQueueMetrics,
  stopQueueMetrics,
} from './config/metrics';
import { prisma } from './config/prisma';
import { createAdapterConnection } from './config/redis';
import { closeRateLimiter } from './middleware/rateLimiters';
import { escalationQueue } from './queues/escalation.queue';

const PORT = resolvePort();
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

logger.info(
  { port: PORT, corsOrigin: CORS_ORIGIN, redis: process.env.REDIS_URL ?? '(default)' },
  '[api] booting',
);

// ---------------------------------------------------------------------------
// Redis Socket.IO adapter clients
// ---------------------------------------------------------------------------
// TWO fresh connections, independent from the BullMQ connection:
//   adapter PUB — publishes events to the Redis channel
//   adapter SUB — psubscribes to that channel (subscriber mode)
// Plus the BullMQ Queue connection imported by the alert route, the lazy
// /health ping client and the (lazy) rate-limit store client. See the
// connection budget in src/config/redis.ts.
const adapterPubClient = createAdapterConnection();
const adapterSubClient = adapterPubClient.duplicate();

adapterPubClient.on('error', (error) => {
  logger.error({ err: error.message }, '[redis:adapter:pub] error');
});
adapterSubClient.on('error', (error) => {
  logger.error({ err: error.message }, '[redis:adapter:sub] error');
});

const { httpServer, io } = createApp();

// ---------------------------------------------------------------------------
// CRITICAL ORDERING — ATTACH THE ADAPTER BEFORE server.listen()
// ---------------------------------------------------------------------------
// io.adapter() must be called before the HTTP server starts accepting
// connections. Attaching it afterwards leaves already-connected sockets on
// the in-memory adapter: they will never receive events emitted by another
// instance, which is the exact bug this change exists to fix.
// Do not move this call below httpServer.listen().
io.adapter(createAdapter(adapterPubClient, adapterSubClient));

// ---------------------------------------------------------------------------
// Prometheus: refresh bullmq_jobs + alerts_by_status every 15s
// ---------------------------------------------------------------------------
// Gauges only refresh on this interval, which matches the Prometheus scrape
// interval (monitoring/prometheus.yml) 1:1 — no scrape ever sees data older
// than one period. The alerts snapshot uses a Prisma groupBy (3 rows, tiny).
async function refreshAlertsByStatus(): Promise<void> {
  const rows = await prisma.emergencyAlert.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  setAlertsByStatus(
    rows.map((row) => ({ status: row.status, count: row._count._all })),
  );
}

startQueueMetrics(escalationQueue, 15_000, refreshAlertsByStatus);

// Fail fast on a misconfigured production deployment: without a token the
// metrics endpoint 401s EVERY scrape and Grafana would silently report
// "no data" while the process looks perfectly healthy.
if (process.env.NODE_ENV === 'production' && !process.env.METRICS_TOKEN) {
  logger.warn(
    'METRICS_TOKEN is not set — /metrics will return 401 to every scrape. ' +
      'Set METRICS_TOKEN in .env and the same value in monitoring/prometheus.yml.',
  );
}

httpServer.listen(PORT, () => {
  logger.info(
    { port: PORT, instanceId: instanceId() },
    '[api] listening (Socket.IO Redis adapter attached, pub + sub)',
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal, instanceId: instanceId() }, '[api] shutting down');
  await new Promise<void>((resolve) => io.close(() => resolve()));

  if (httpServer.listening) {
    httpServer.close();
  }

  stopQueueMetrics();

  // Adapter clients + the rate-limit store are separate connections; closing
  // them avoids leaving half-open sockets on a rolling restart.
  await Promise.allSettled([
    adapterPubClient.quit(),
    adapterSubClient.quit(),
    closeRateLimiter(),
  ]);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
