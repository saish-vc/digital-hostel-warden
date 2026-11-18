import type { Job } from 'bullmq';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { escalationsFiredTotal } from '../config/metrics';
import type { EscalationJobData } from '../queues/escalation.queue';
import { sendEscalationSms } from '../services/sms.service';

/**
 * Relay the real outcome to the API so the dashboard's escalation pill reports
 * delivery truth instead of a client-side 60s guess. The worker cannot emit
 * socket events itself (separate process, no Socket.IO server, and the Redis
 * adapter has no Emitter), so it POSTs to the API's internal door.
 *
 * No-op when INTERNAL_API_URL is unset: unit tests drive this processor
 * directly with no API to notify. Never throws — the SMS outcome, not the
 * notification, decides whether the job succeeded.
 */
async function notifyEscalationResult(
  alertId: string,
  studentId: string,
  outcome: 'sent' | 'failed',
): Promise<void> {
  const base = process.env.INTERNAL_API_URL;
  const token = process.env.METRICS_TOKEN;
  if (!base || !token) {
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(
        `${base.replace(/\/+$/, '')}/internal/escalation-result`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-token': token,
          },
          body: JSON.stringify({
            alertId,
            studentId,
            outcome,
            at: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (response.ok) {
        return;
      }
      logger.warn(
        { alertId, outcome, status: response.status, attempt },
        '[escalation] result relay rejected',
      );
    } catch (error) {
      logger.warn(
        { alertId, outcome, attempt, err: error instanceof Error ? error.message : error },
        '[escalation] result relay failed',
      );
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * The escalation job handler, extracted from the worker bootstrap so it can
 * be unit-tested directly (an already-acknowledged alert must never send an
 * SMS, even if the job somehow survived the cancel).
 *
 * This module must not import src/index.ts or create a Worker: it is pure
 * processing logic over Prisma + the SMS service.
 *
 * METRIC: escalations_fired_total is incremented HERE, inside the
 * processor, because both the real worker and the in-test worker call
 * this function — the counter counts an escalation the instant its SMS
 * actually went out, never earlier.
 */
export async function processEscalationJob(
  job: Job<EscalationJobData>,
): Promise<void> {
  const alertId = job.data.alertId;

  const alert = await prisma.emergencyAlert.findUnique({
    where: { id: alertId },
    include: { student: true },
  });

  if (!alert) {
    // The alert was deleted (or never existed); nothing to escalate.
    logger.warn(
      { jobId: job.id, alertId },
      `[worker] escalation job ${String(job.id)} skipped: alert ${alertId} not found`,
    );
    return;
  }

  // IDEMPOTENCY GUARD — must be the first check after the fetch.
  // If an acknowledge races this job (job already picked up when the
  // warden pressed acknowledge), the SMS must not fire. A cancelled job
  // that had already been promoted into processing also lands here and
  // exits silently because status is no longer PENDING.
  if (alert.status !== 'PENDING') {
    logger.info(
      { jobId: job.id, alertId, status: alert.status },
      `[worker] escalation job ${String(job.id)} skipped: alert ${alertId} is ${alert.status}, no SMS needed`,
    );
    return;
  }

  const student = alert.student;
  logger.info(
    { jobId: job.id, alertId, delayMs: process.env.ESCALATION_DELAY_MS ?? 60000 },
    `[worker] alert ${alertId} unacknowledged — sending escalation SMS`,
  );

  // Any throw here marks the job failed in BullMQ (removeOnFail keeps the
  // last 100 for inspection). Never swallow SMS failures: an unlogged
  // missed escalation is exactly the disaster this stage exists to prevent.
  let result: Awaited<ReturnType<typeof sendEscalationSms>>;
  try {
    result = await sendEscalationSms({
      id: alert.id,
      type: alert.type,
      student: {
        name: student.name,
        roomNumber: student.roomNumber,
      },
    });
  } catch (error) {
    await notifyEscalationResult(alert.id, alert.studentId, 'failed');
    throw error;
  }

  // METRIC: the escalation guarantee was exercised end to end.
  escalationsFiredTotal.inc();

  await notifyEscalationResult(alert.id, alert.studentId, 'sent');

  // Delivery receipt — this is the audit trail of the escalation.
  logger.info(
    { alertId, receiptId: result.receiptId, to: result.to },
    `[worker] escalation delivered for alert ${alertId}: ${result.receiptId} → ${result.to}`,
  );
}
