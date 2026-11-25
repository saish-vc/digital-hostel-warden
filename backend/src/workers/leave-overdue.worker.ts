import http from 'http';
import { Worker, Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { leaveOverdueTotal, leaveCurrentlyAway, register } from '../config/metrics';

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
    const now = new Date();

    // Find all DEPARTED leaves whose expectedReturn has passed
    const overdueLeaves = await prisma.leaveRequest.findMany({
      where: {
        status: 'DEPARTED',
        expectedReturn: { lt: now },
      },
      select: { id: true, studentId: true, expectedReturn: true },
    });

    if (overdueLeaves.length === 0) {
      logger.debug('[leave-worker] no overdue leaves found');
      return;
    }

    // Batch update to OVERDUE
    const ids = overdueLeaves.map((l) => l.id);
    const result = await prisma.leaveRequest.updateMany({
      where: { id: { in: ids }, status: 'DEPARTED' },
      data: {
        status: 'OVERDUE',
        overdueNotifiedAt: now,
      },
    });

    leaveOverdueTotal.inc(result.count);

    // Refresh currently-away gauge
    const awayCount = await prisma.leaveRequest.count({
      where: { status: 'DEPARTED' },
    });
    leaveCurrentlyAway.set(awayCount);

    logger.warn(
      { count: result.count, ids },
      '[leave-worker] marked leaves as OVERDUE',
    );
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
