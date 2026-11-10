import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { escalationsCancelledTotal } from '../config/metrics';

export const ESCALATION_DELAY_MS = Number(
  process.env.ESCALATION_DELAY_MS ?? 60_000,
);

export interface EscalationJobData {
  // Prisma EmergencyAlert.id — a String UUID in this schema.
  alertId: string;
}

/**
 * Deterministic per-alert job ID: REQUIRED for cancellation. Without it,
 * cancelling means scanning every job and races produce duplicate SMS.
 *
 * DEVIATION from the original spec (`escalation:${alertId}`): BullMQ 6
 * refuses custom job ids containing ':' at enqueue time (it throws
 * "Custom Id cannot contain :"), so the separator is '-'. The property that
 * matters is preserved verbatim: the alertId is the deterministic suffix,
 * so cancellation by ID works and retried requests reuse the same slot.
 */
export function escalationJobId(alertId: string): string {
  return `escalation-${alertId}`;
}

//
// IMPORTANT (BullMQ rule): the Queue gets its OWN connection. The Worker in
// src/workers/escalation.worker.ts must create another one via
// createRedisConnection() — never share one connection between a Queue and
// its Worker, BullMQ uses blocking commands on the worker side.
//
export const escalationQueueConnection = createRedisConnection();

export const escalationQueue = new Queue<EscalationJobData>('escalation', {
  connection: escalationQueueConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { count: 100 },
  },
});

/**
 * Fire-and-forget-friendly: schedule the 60s escalation for one alert.
 * The caller (POST /alerts) wraps this in .catch() — a Redis outage must
 * never fail the SOS itself.
 */
export async function enqueueEscalation(alertId: string): Promise<void> {
  await escalationQueue.add(
    'escalation',
    { alertId },
    {
      delay: ESCALATION_DELAY_MS,
      jobId: escalationJobId(alertId),
    },
  );
}

/**
 * Remove the pending escalation job when an alert is acknowledged.
 * Fetches the job first, then removes it — the "remove" shorthand does not
 * work for delayed jobs (it assumes movable state that delayed jobs don't
 * have until they are promoted). Returns true if a job was removed.
 */
export async function cancelEscalation(alertId: string): Promise<boolean> {
  const job = await escalationQueue.getJob(escalationJobId(alertId));
  if (!job) {
    return false;
  }
  await job.remove();
  // METRIC (escalations_cancelled_total): acknowledged-before-60s. The
  // Grafana panel "Escalations fired vs cancelled" draws fired (worker
  // process) and cancelled (API process) side by side — the ideal end state
  // is cancellations ≫ fired.
  escalationsCancelledTotal.inc();
  return true;
}
