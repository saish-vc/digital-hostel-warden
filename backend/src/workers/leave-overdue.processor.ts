import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { leaveCurrentlyAway, leaveOverdueTotal } from '../config/metrics';

export interface OverdueScanResult {
  marked: number;
  ids: string[];
}

/**
 * Mark every DEPARTED leave whose expectedReturn has passed as OVERDUE.
 * Extracted from the worker entrypoint so the scan can be tested directly.
 */
export async function markOverdueLeaves(now: Date = new Date()): Promise<OverdueScanResult> {
  const overdueLeaves = await prisma.leaveRequest.findMany({
    where: {
      status: 'DEPARTED',
      expectedReturn: { lt: now },
    },
    select: { id: true },
  });

  if (overdueLeaves.length === 0) {
    logger.debug('[leave-worker] no overdue leaves found');
    return { marked: 0, ids: [] };
  }

  const ids = overdueLeaves.map((leave) => leave.id);
  const result = await prisma.leaveRequest.updateMany({
    where: { id: { in: ids }, status: 'DEPARTED' },
    data: {
      status: 'OVERDUE',
      overdueNotifiedAt: now,
    },
  });

  leaveOverdueTotal.inc(result.count);

  const awayCount = await prisma.leaveRequest.count({
    where: { status: 'DEPARTED' },
  });
  leaveCurrentlyAway.set(awayCount);

  logger.warn({ count: result.count, ids }, '[leave-worker] marked leaves as OVERDUE');

  return { marked: result.count, ids };
}
