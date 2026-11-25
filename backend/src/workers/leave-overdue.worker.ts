import http from 'http';
import { Worker, Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { logger } from '../config/logger';
import { register } from '../config/metrics';
import { markOverdueLeaves } from './leave-overdue.processor';

/**
 * Leave-overdue worker — scans for DEPARTED leaves whose expectedReturn
 * has passed and marks them OVERDUE every 5 minutes via a BullMQ repeatable job.
 *
 * Independent process, same pattern as escalation.worker.ts.
 */

const WORKER_METRICS_PORT = Number(process.env.LEAVE_WORKER_METRICS_PORT ?? 4002);

// ---------------------------------------------------------------------------
// Metrics HTTP server (same pattern as escalation worker)
// ---------------------------------------------------------------------------
const metricsServer = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');

  if (requestUrl.pathname !== '/metrics') {
    res.writeHead(404).end();
    return;
  }

  const provided = requestUrl.searchParams.get('token');
  const expected = process.env.METRICS_TOKEN;
  if (
    !expected ||
    !provided ||
    provided.length === 0 ||
    provided !== expected
  ) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'METRICS_TOKEN missing or invalid (?token=...)' }));
    return;
  }

  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
});

metricsServer.listen(WORKER_METRICS_PORT, () => {
  logger.info(
    { port: WORKER_METRICS_PORT },
    '[leave-worker] /metrics listening',
  );
});

// ---------------------------------------------------------------------------
// Queue + Worker
// ---------------------------------------------------------------------------
const connection = createRedisConnection();

const leaveOverdueQueue = new Queue('leave-overdue', { connection: connection.duplicate() });

// Add a repeatable job that fires every 5 minutes
void leaveOverdueQueue.upsertJobScheduler(
  'scan-overdue-returns',
  { every: 5 * 60 * 1000 },
  {
    name: 'scan-overdue',
    opts: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  },
).then(() => {
  logger.info('[leave-worker] repeatable overdue scan scheduled (every 5m)');
}).catch((err) => {
  logger.error({ err }, '[leave-worker] failed to register repeatable job');
});

const worker = new Worker(
  'leave-overdue',
  async () => {
    await markOverdueLeaves();
  },
  { connection, concurrency: 1 },
);

worker.on('ready', () => {
  logger.info('[leave-worker] leave-overdue worker ready');
});

worker.on('failed', (job, error) => {
  logger.error(
    { jobId: job?.id ?? '?', err: error.message },
    `[leave-worker] job failed: ${error.message}`,
  );
});

worker.on('error', (error) => {
  logger.error({ err: error.message }, '[leave-worker] worker error');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[leave-worker] shutting down');
  metricsServer.close();
  try {
    await worker.close();
    await leaveOverdueQueue.close();
  } finally {
    prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
