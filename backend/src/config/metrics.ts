import type { Queue } from 'bullmq';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { logger } from './logger';

/**
 * THE Prometheus registry + every custom metric the system exposes.
 *
 * One Registry per PROCESS (module singleton). The three API instances each
 * own an in-memory registry scraped via GET /metrics?token=... (see app.ts),
 * and the escalation worker exposes its own registry through a tiny HTTP
 * server on WORKER_METRICS_PORT (see escalation.worker.ts) — because the
 * counters it owns (escalations_fired_total, sms_sent_total) are incremented
 * in the WORKER process and would otherwise never be scraped by Prometheus,
 * which only polls the API ports.
 *
 * Why prom-client (10.x @prometheus-io/client deprecation note): it is the
 * de-facto standard, stable, and the Grafana queries below are written
 * against its classic /metrics exposition format. Not switching stacks in a
 * hardening stage.
 *
 * NOTE on `route` cardinality: HTTP metrics use the ROUTE TEMPLATE
 * (`/alerts/:id/acknowledge`), never the raw URL, so alert IDs cannot blow
 * up the label cardinality. See routeLabel() in src/app.ts.
 */

export const register = new Registry();

// Node runtime gauges (event loop lag, heap, handles...) — free context for
// panels like "is this instance busy or hung?".
collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** method, route, status_code — the bread-and-butter traffic counter. */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by method, route template and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

/** Latency histogram. 10ms → 5s buckets cover the whole demo-latency range. */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds by method, route template and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

/** No labels: dashboards sum(this) across instances for "connected wardens". */
export const socketIoConnected = new Gauge({
  name: 'socket_io_connected',
  help: 'Currently open Socket.IO connections on this instance',
  registers: [register],
});

export const socketIoConnectionsTotal = new Counter({
  name: 'socket_io_connections_total',
  help: 'Total Socket.IO handshakes by role (STUDENT | WARDEN)',
  labelNames: ['role'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Alert pipeline
// ---------------------------------------------------------------------------

export const alertsCreatedTotal = new Counter({
  name: 'alerts_created_total',
  help: 'Total SOS alerts created, by alert type',
  labelNames: ['type'] as const,
  registers: [register],
});

export const alertsAcknowledgedTotal = new Counter({
  name: 'alerts_acknowledged_total',
  help: 'Total alerts moved PENDING -> ACKNOWLEDGED by a warden',
  registers: [register],
});

/**
 * Introduced with the resolve flow: ACKNOWLEDGED -> RESOLVED
 * (PATCH /alerts/:id/resolve in alert.routes.ts). No labels — the pipeline
 * counters (created / acknowledged / resolved) are meant to be summed and
 * diffed side by side in Grafana: resolved should converge to acknowledged
 * over the course of a shift, and a growing gap means cases are being
 * acknowledged and then forgotten.
 */
export const alertsResolvedTotal = new Counter({
  name: 'alerts_resolved_total',
  help: 'Total alerts moved ACKNOWLEDGED -> RESOLVED by a warden',
  registers: [register],
});

/**
 * Pipeline snapshot for the Grafana "Alert pipeline" panel. Refreshed every
 * 15s together with the BullMQ counts (startQueueMetrics → collectExtra →
 * refreshAlertsByStatus in src/index.ts). A Prometheus gauge of DB state is
 * simpler and cheaper than a bespoke JSON endpoint, and it composes with
 * Grafana the same way as every other series.
 */
export const alertsByStatus = new Gauge({
  name: 'alerts_by_status',
  help: 'Current number of alerts per status (PENDING | ACKNOWLEDGED | RESOLVED)',
  labelNames: ['status'] as const,
  registers: [register],
});

/**
 * SOS break-glass override counter (see sosLimiter in
 * src/middleware/rateLimiters.ts). Any value > 0 in a window where
 * sosLimiter tripped means a real emergency pushed through — the dashboard
 * panel drills in Section 7 verify it appears in Prometheus.
 */
export const sosOverridesTotal = new Counter({
  name: 'sos_overrides_total',
  help: 'SOS requests allowed through the 5/60s limiter via the break-glass override',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Incremented in the escalation PROCESSOR (runs in the worker process). */
export const escalationsFiredTotal = new Counter({
  name: 'escalations_fired_total',
  help: 'Escalation SMS that were actually sent (alert still PENDING at T+60s)',
  registers: [register],
});

/** Incremented on a successful cancelEscalation (runs in the API process). */
export const escalationsCancelledTotal = new Counter({
  name: 'escalations_cancelled_total',
  help: 'Scheduled escalations cancelled because a warden acknowledged first',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Delivery channels
// ---------------------------------------------------------------------------

export const smsSentTotal = new Counter({
  name: 'sms_sent_total',
  help: 'Twilio escalation SMS outcomes by status (success | failed)',
  labelNames: ['status'] as const,
  registers: [register],
});

export const fcmSentTotal = new Counter({
  name: 'fcm_sent_total',
  help: 'FCM push outcomes by token status (success | failed | stale_token)',
  labelNames: ['status'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// BullMQ
// ---------------------------------------------------------------------------

/**
 * Refreshed every 15s from queue.getJobCounts() by startQueueMetrics.
 *
 * THE MOST IMPORTANT SERIES IN THE SYSTEM: bullmq_jobs{state="failed"}.
 * RemoveOnFail keeps the last 100 failed jobs, so this gauge is the only
 * signal that the escalation guarantee ("nobody answers in 60s -> SMS")
 * is actually being delivered. Grafana panel #1 and the
 * EscalationFailuresHigh alert are both wired to it.
 */
export const bullmqJobs = new Gauge({
  name: 'bullmq_jobs',
  help: 'Current BullMQ job counts per queue and state, refreshed every 15s',
  labelNames: ['queue', 'state'] as const,
  registers: [register],
});

const QUEUE_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;

interface AlertsStatusRow {
  status: string;
  count: number;
}

/** Set (and re-set) the alerts_by_status gauge from a groupBy result. */
export function setAlertsByStatus(rows: readonly AlertsStatusRow[]): void {
  // reset() first so statuses that dropped back to 0 disappear instead of
  // reporting the previous refresh's value forever.
  alertsByStatus.reset();
  for (const row of rows) {
    alertsByStatus.set({ status: row.status }, row.count);
  }
}

/**
 * Start the 15s BullMQ + alerts-by-status refresh loop.
 *
 * @param queue the escalationQueue (passed in by the caller rather than
 *   imported to avoid a module cycle: metrics must be importable from
 *   everywhere — workers, routes, services — without dragging the queue in).
 * @param intervalMs refresh cadence. 15s matches the Prometheus scrape
 *   interval, so cadence ({ scrape, refresh }) is 1:1 and no scrape sees
 *   stale gauges for more than one interval.
 * @param collectExtra optional hook that refreshes DB-backed gauges —
 *   src/index.ts passes refreshAlertsByStatus() (Prisma groupBy). Kept as an
 *   injection point so metrics.ts never has to know about Prisma.
 */
export function startQueueMetrics(
  queue: Queue,
  intervalMs = 15_000,
  collectExtra?: () => Promise<void>,
): void {
  if (queueMetricsTimer) {
    return; // idempotent: safe to call once more than once
  }

  const refresh = async (): Promise<void> => {
    try {
      const counts = await queue.getJobCounts();
      for (const state of QUEUE_STATES) {
        bullmqJobs.set(
          { queue: queue.name, state },
          Number(counts[state] ?? 0),
        );
      }
      if (collectExtra) {
        await collectExtra();
      }
    } catch (error) {
      // Redis hiccup while counting must NEVER crash the process.
      // Prometheus keeps seeing the last successful values; after a few
      // failed refreshes InstanceDown/panels will show the anomaly anyway.
      logger.warn(
        { err: error instanceof Error ? error.message : error },
        '[metrics] queue refresh failed',
      );
    }
  };

  void refresh();
  queueMetricsTimer = setInterval(() => {
    void refresh();
  }, intervalMs);
  // Never hold the event loop open just for metrics.
  queueMetricsTimer.unref();
}

let queueMetricsTimer: NodeJS.Timeout | null = null;

/** Stop the refresh loop (called from index.ts on SIGINT/SIGTERM). */
export function stopQueueMetrics(): void {
  if (queueMetricsTimer) {
    clearInterval(queueMetricsTimer);
    queueMetricsTimer = null;
  }
}

/**
 * Test isolation: prom-client counters/Gauges/Histograms are process-level
 * singletons. Vitest shares one module instance per test file, so
 * tests/hardening.test.ts calls this in beforeEach — otherwise a test that
 * reads sos_overrides_total could see increments from an earlier test.
 */
export function resetMetricsForTests(): void {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();
  socketIoConnected.reset();
  socketIoConnectionsTotal.reset();
  alertsCreatedTotal.reset();
  alertsAcknowledgedTotal.reset();
  alertsResolvedTotal.reset();
  alertsByStatus.reset();
  sosOverridesTotal.reset();
  escalationsFiredTotal.reset();
  escalationsCancelledTotal.reset();
  smsSentTotal.reset();
  fcmSentTotal.reset();
  bullmqJobs.reset();
}
