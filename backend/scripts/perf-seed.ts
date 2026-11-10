/**
 * ============================================================================
 * perf-seed — ONE-TIME evidence capture for the J4 index claim.
 * ============================================================================
 *
 *   npx tsx scripts/perf-seed.ts
 *
 * The history endpoint's access path only switches from Seq Scan to
 * idx_alerts_status_created once the table is big enough for the planner to
 * prefer it. At demo size a sequential scan is the CORRECT choice, so the
 * old "no seq scan" comment was false. This script produces the three plans
 * that replace it:
 *
 *   1. current row count      -> whatever the planner actually picks
 *   2. same rows, forced      -> SET enable_seqscan = off (proves the index
 *                                is usable for this exact query shape)
 *   3. +5,000 synthetic rows  -> the planner picks the index on its own
 *
 * It then DELETES every row it created. Nothing here is a fixture: the
 * synthetic alerts belong to one throwaway student that is also removed.
 *
 * Refuses to run with NODE_ENV=production.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ROWS = 5_000;
const BATCH = 500;
const PERF_EMAIL = 'perf_seed_student@demo.hostel';

const HISTORY_SQL = readFileSync('explain.sql', 'utf8')
  .replace(/^﻿/, '')
  .replace(/^EXPLAIN \(ANALYZE\)\s*/i, '')
  .replace(/;\s*$/, '');

async function plan(label: string, forceIndex = false): Promise<void> {
  console.log(`\n=== ${label} ===`);
  // An interactive transaction pins one connection: a bare SET would land on
  // an arbitrary pooled connection and the EXPLAIN might run on another.
  const rows = await prisma.$transaction(async (tx) => {
    if (forceIndex) {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    }
    return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE) ${HISTORY_SQL}`,
    );
  });
  for (const row of rows) console.log(row['QUERY PLAN']);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('perf-seed refuses to run with NODE_ENV=production');
  }

  const before = await prisma.emergencyAlert.count();
  console.log(`EmergencyAlert rows before: ${before}`);

  await plan(`A. ${before} rows — planner's own choice`);
  await plan(`B. ${before} rows — forced (SET enable_seqscan = off)`, true);

  const student = await prisma.student.create({
    data: {
      name: 'Perf Seed (temporary)',
      email: PERF_EMAIL,
      passwordHash: 'not-a-login-disabled-account',
      roomNumber: 'Z-000',
      emergencyContact: '+910000000000',
    },
  });

  try {
    const now = Date.now();
    for (let offset = 0; offset < ROWS; offset += BATCH) {
      const size = Math.min(BATCH, ROWS - offset);
      await prisma.emergencyAlert.createMany({
        data: Array.from({ length: size }, (_, i) => {
          const n = offset + i;
          return {
            studentId: student.id,
            type: ['MEDICAL', 'FIRE', 'SECURITY'][n % 3]!,
            // Spread the statuses so every UNION branch is selective enough
            // for the index to win, and spread createdAt so the DESC ordering
            // is not degenerate.
            status: ['PENDING', 'ACKNOWLEDGED', 'RESOLVED'][n % 3]!,
            createdAt: new Date(now - n * 60_000),
          };
        }),
      });
    }

    // Fresh statistics: without ANALYZE the planner would still be costing
    // the query against the pre-seed row estimate and the capture would lie.
    await prisma.$executeRawUnsafe('ANALYZE "EmergencyAlert"');

    const during = await prisma.emergencyAlert.count();
    await plan(`C. ${during} rows — planner's own choice`);
  } finally {
    const deleted = await prisma.emergencyAlert.deleteMany({
      where: { studentId: student.id },
    });
    await prisma.student.delete({ where: { id: student.id } });
    await prisma.$executeRawUnsafe('ANALYZE "EmergencyAlert"');
    const after = await prisma.emergencyAlert.count();
    console.log(
      `\n[cleanup] deleted ${deleted.count} synthetic alerts + the temporary student. Rows now: ${after} (was ${before}).`,
    );
  }
}

main()
  .catch((error) => {
    console.error('perf-seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });