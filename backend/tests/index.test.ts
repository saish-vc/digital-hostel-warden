/**
 * J4 — proves idx_alerts_status_created actually serves the history query.
 *
 * OPT-IN. Seeding 5,000 rows + ANALYZE + EXPLAIN takes well over the 5s budget
 * the rest of the suite runs under, so this file is skipped unless
 * RUN_INDEX_TEST=true. See docs/MANUAL_TESTS.md.
 *
 *   RUN_INDEX_TEST=true npm test -- tests/index.test.ts
 *
 * Runs against TEST_DATABASE_URL like every other suite (tests/helpers/testEnv
 * refuses anything not ending in _test). The rows are removed in afterAll.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { resetDatabaseOnly } from './helpers/db';
import { createStudent } from './helpers/factories';

const ENABLED = process.env.RUN_INDEX_TEST === 'true';
const ROWS = 5_000;
const BATCH = 500;

const HISTORY_SQL = readFileSync('explain.sql', 'utf8')
  .replace(/^\uFEFF/, '')
  .replace(/^EXPLAIN \(ANALYZE\)\s*/i, '')
  .replace(/;\s*$/, '');

describe.skipIf(!ENABLED)('idx_alerts_status_created serves the history query', () => {
  let studentId: string;

  beforeAll(async () => {
    await resetDatabaseOnly();
    const student = await createStudent({ email: 'index-test@demo.hostel' });
    studentId = student.id;

    const now = Date.now();
    for (let offset = 0; offset < ROWS; offset += BATCH) {
      const size = Math.min(BATCH, ROWS - offset);
      await prisma.emergencyAlert.createMany({
        data: Array.from({ length: size }, (_, i) => {
          const n = offset + i;
          return {
            studentId,
            type: ['MEDICAL', 'FIRE', 'SECURITY'][n % 3]!,
            status: ['PENDING', 'ACKNOWLEDGED', 'RESOLVED'][n % 3]!,
            createdAt: new Date(now - n * 60_000),
          };
        }),
      });
    }

    // Without fresh statistics the planner costs against the pre-seed
    // estimate and the assertion would prove nothing.
    await prisma.$executeRawUnsafe('ANALYZE "EmergencyAlert"');
  }, 120_000);

  afterAll(async () => {
    await prisma.emergencyAlert.deleteMany({ where: { studentId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.$executeRawUnsafe('ANALYZE "EmergencyAlert"');
  });

  it('uses the composite index for every status branch at 5,000 rows', async () => {
    const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE) ${HISTORY_SQL}`,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    const indexScans = plan.match(/Index Scan using idx_alerts_status_created/g) ?? [];
    expect(indexScans.length).toBe(3); // one per UNION branch
    expect(plan).not.toMatch(/Seq Scan on "EmergencyAlert"/);
  }, 30_000);
});