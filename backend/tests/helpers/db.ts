import { execSync } from 'node:child_process';
import { prisma } from '../../src/config/prisma';
import { flushTestRedis } from './redisCleanup';

/**
 * Database isolation helpers.
 *
 * Every suite starts from the deterministic test seed (10 students, 3
 * wardens, 0 alerts). Tests then create their own rows with unique emails, so
 * a test never depends on a row another test created and file order is
 * irrelevant.
 */

const TABLES = '"EmergencyAlert", "DeviceToken", "Student", "Warden"';

export async function truncateAllTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Runs prisma/test-seed.ts in a child process, per the spec. execSync keeps
 * the seed's PrismaClient lifecycle out of the test process (no dangling
 * engine handles) and proves the seed works as a standalone script.
 */
export function runTestSeed(): void {
  execSync('npx tsx prisma/test-seed.ts', {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

/** Truncate Postgres, flush Redis, then seed. Call in beforeAll. */
export async function resetDatabaseAndQueue(): Promise<void> {
  await truncateAllTables();
  await flushTestRedis();
  runTestSeed();
}

/**
 * Truncate Postgres and flush Redis WITHOUT seeding.
 *
 * Suites that create all their rows through factories use this: spawning the
 * seed script costs ~2.5s per file and those 13 seeded users would never be
 * referenced. tests/auth.test.ts still runs the real seed (it is the only
 * suite that needs known login accounts), which is what keeps the seed script
 * exercised on every run.
 */
export async function resetDatabaseOnly(): Promise<void> {
  await truncateAllTables();
  await flushTestRedis();
}

/** Alerts only (keeps seeded students/wardens). Call in beforeEach. */
export async function clearAlertsAndQueue(): Promise<void> {
  await prisma.emergencyAlert.deleteMany();
  await flushTestRedis();
}
