import crypto from 'node:crypto';
import { Router } from 'express';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';

const router = Router();

/**
 * POST /loadtest/cleanup — the self-cleanup step of load-test/sos.js.
 *
 * A k6 run creates hundreds of alerts. There is deliberately no general
 * "delete alert" API (the audit trail is append-only), so the load test
 * needs its own narrow door. Three independent guards keep it harmless:
 *
 * 1. Shared secret: `x-loadtest-token` must equal METRICS_TOKEN (an ops
 *    secret that already exists and is never shipped to a client). Compared
 *    timing-safe, exactly like GET /metrics.
 * 2. Production refusal: NODE_ENV=production returns 403 unless
 *    ALLOW_LOADTEST_CLEANUP=true is explicitly set.
 * 3. Blast radius: only alerts belonging to students whose email starts with
 *    `loadtest_student_` — the pool prisma/demo-reset.ts creates. A real
 *    student's alert can never match.
 *
 * Scheduled BullMQ escalation jobs for the deleted alerts still sit in Redis
 * until they fire (no worker is running during a load test); they exit
 * immediately via the worker's `status !== PENDING` idempotency guard, and
 * `npm run demo:reset` obliterates the queue between runs.
 */

const LOADTEST_EMAIL_PREFIX = 'loadtest_student_';

function tokenMatches(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected) {
    return false;
  }
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

router.post('/cleanup', async (req, res) => {
  if (!tokenMatches(req.header('x-loadtest-token'), process.env.METRICS_TOKEN)) {
    logger.warn({ ip: req.ip }, 'loadtest_cleanup_denied');
    res.status(401).json({ error: 'invalid or missing x-loadtest-token' });
    return;
  }

  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_LOADTEST_CLEANUP !== 'true'
  ) {
    res.status(403).json({
      error:
        'load-test cleanup is disabled in production (set ALLOW_LOADTEST_CLEANUP=true to override)',
    });
    return;
  }

  const students = await prisma.student.findMany({
    where: { email: { startsWith: LOADTEST_EMAIL_PREFIX } },
    select: { id: true },
  });

  if (students.length === 0) {
    res.json({ deleted: 0, students: 0 });
    return;
  }

  const result = await prisma.emergencyAlert.deleteMany({
    where: { studentId: { in: students.map((student) => student.id) } },
  });

  logger.info(
    { deleted: result.count, students: students.length },
    '[loadtest] cleanup complete',
  );
  res.json({ deleted: result.count, students: students.length });
});

export default router;
