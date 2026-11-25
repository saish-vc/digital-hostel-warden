import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { markOverdueLeaves } from '../src/workers/leave-overdue.processor';
import { resetDatabaseOnly } from './helpers/db';
import { createStudent } from './helpers/factories';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

async function createLeave(studentId: string, status: string, expectedReturn: Date) {
  return prisma.leaveRequest.create({
    data: {
      studentId,
      type: 'DAY_OUTING',
      reason: 'Overdue scan test',
      destination: 'Pune',
      emergencyContact: '+919876543210',
      departureTime: new Date(expectedReturn.getTime() - 4 * HOUR),
      expectedReturn,
      status,
    },
  });
}

beforeAll(async () => {
  await resetDatabaseOnly();
}, 60_000);

beforeEach(async () => {
  await prisma.leaveRequest.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});

describe('markOverdueLeaves', () => {
  it('marks only DEPARTED leaves whose return time has passed', async () => {
    const student = await createStudent();
    const overdue = await createLeave(student.id, 'DEPARTED', new Date(NOW.getTime() - HOUR));
    const future = await createLeave(student.id, 'DEPARTED', new Date(NOW.getTime() + HOUR));
    const submitted = await createLeave(student.id, 'SUBMITTED', new Date(NOW.getTime() - HOUR));

    const result = await markOverdueLeaves(NOW);

    expect(result).toEqual({ marked: 1, ids: [overdue.id] });

    const rows = await prisma.leaveRequest.findMany();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(overdue.id)?.status).toBe('OVERDUE');
    expect(byId.get(overdue.id)?.overdueNotifiedAt?.toISOString()).toBe(NOW.toISOString());
    expect(byId.get(future.id)?.status).toBe('DEPARTED');
    expect(byId.get(submitted.id)?.status).toBe('SUBMITTED');
  });

  it('does nothing when no leave is overdue', async () => {
    const student = await createStudent();
    const future = await createLeave(student.id, 'DEPARTED', new Date(NOW.getTime() + HOUR));

    const result = await markOverdueLeaves(NOW);

    expect(result).toEqual({ marked: 0, ids: [] });
    const stored = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: future.id } });
    expect(stored.status).toBe('DEPARTED');
    expect(stored.overdueNotifiedAt).toBeNull();
  });

  it('treats an expected return exactly at the scan time as not yet overdue', async () => {
    const student = await createStudent();
    const boundary = await createLeave(student.id, 'DEPARTED', NOW);

    const result = await markOverdueLeaves(NOW);

    expect(result).toEqual({ marked: 0, ids: [] });
    const stored = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: boundary.id } });
    expect(stored.status).toBe('DEPARTED');
  });
});
