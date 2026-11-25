import http from 'http';
import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { logger } from '../config/logger';
import { register } from '../config/metrics';
import type { EscalationJobData } from '../queues/escalation.queue';
import { processEscalationJob } from './escalation.processor';

/**
 * Escalation worker — an INDEPENDENT process (npm run worker / worker:dev).
 * It must never import from src/index.ts: no Express, no Socket.IO, no
 * getters into the API's runtime. It talks to Postgres (Prisma) and sends
 * SMS. That keeps it independently startable/deployable.
 *
 * Uses its OWN Redis connection — a BullMQ Worker requires a dedicated,
 * separate connection (blocking commands); sharing one with the Queue is
 * undefined behavior.
 *
 * The job body lives in ./escalation.processor.ts so tests can call it
 * directly (see tests/escalation.test.ts).
 *
 * WHY THE WORKER RUNS ITS OWN /metrics HTTP SERVER (WORKER_METRICS_PORT,
 * default 4001):
 * Prometheus scrapes the three API instances (3001-3003). Counters that
 * increment inside THIS process — escalations_fired_total,
 * sms_sent_total{...} — live in this process's registry and would never be
 * scraped without an endpoint of its own. It is protected by the same
 * METRICS_TOKEN (?token=...) scheme as the API's /metrics endpoint.
 */
const WORKER_METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 4001);

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
    !timingSafeEqualStrings(provided, expected)
  ) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'METRICS_TOKEN missing or invalid (?token=...)' }));
    return;
  }

  logger.info({ port: WORKER_METRICS_PORT }, '[worker] metrics scraped');

  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
});

/** Length-independent constant-time compare (same scheme as src/app.ts). */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return aBuf.equals(bBuf);
}

metricsServer.listen(WORKER_METRICS_PORT, () => {
  logger.info(
    { port: WORKER_METRICS_PORT },
    '[worker] /metrics listening (scrape target for Prometheus)',
  );
});

const workerConnection = createRedisConnection();

const worker = new Worker<EscalationJobData>('escalation', processEscalationJob, {
  connection: workerConnection,
  // Keep the concurrency modest: SMS sends are slow and must not
  // interleave retries in confusing ways during a live demo.
  concurrency: 1,
});

worker.on('ready', () => {
  logger.info({ queue: 'escalation' }, '[worker] Escalation worker ready');
});

worker.on('failed', (job, error) => {
  // THE alarm feeding channel: removeOnFail keeps these jobs and the
  // API-side bullmq_jobs{state="failed"} gauge + EscalationFailuresHigh
  // alert fire from them.
  logger.error(
    { jobId: job?.id ?? '?', err: error.message },
    `[worker] escalation job ${job?.id ?? '?'} failed: ${error.message}`,
  );
});

worker.on('error', (error) => {
  // Failed *attempts* surface as 'failed'; this catches internal worker
  // problems (e.g. a Redis hiccup) without killing the process.
  logger.error({ err: error.message }, '[worker] worker error');
});
