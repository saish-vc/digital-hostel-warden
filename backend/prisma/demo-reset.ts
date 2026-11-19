/**
 * ============================================================================
 * demo-reset — the rehearsal enabler.
 * ============================================================================
 *
 *   npm run demo:reset
 *
 * WHAT IT DOES (in order):
 *   1. Production guard (refuses with a banner unless FORCE_DEMO_RESET=true).
 *   2. Deletes ALL EmergencyAlert rows, ALL LeaveRequest rows and ALL
 *      DeviceToken rows. Students and wardens are NEVER deleted — demo
 *      credentials stay stable from rehearsal to rehearsal. Leave requests
 *      go too: the warden's Leave tab must not open on yesterday's rehearsal
 *      requests, and an overdue leave would fire the overdue worker mid-demo.
 *   3. Obliterates the BullMQ escalation queue (manually OR with force) so
 *      no orphaned 60s SMS timer from a previous rehearsal fires halfway
 *      through the next one.
 *   4. Ensures the demo population exists (idempotent, credentials stable):
 *        - the named demo accounts from prisma/seed.ts
 *          (aarav@hostel.local, diya@hostel.local, warden@hostel.local +
 *          password123 — existing password hashes are NEVER touched)
 *        - 4 additional wardens  -> 5 wardens total
 *        - 500 loadtest_student_{i}@demo.hostel students, the pool the k6
 *          script logs in against (that exact prefix is what makes them a
 *          load-test-only crowd: demo:reset can re-create them, they never
 *          appear on the warden board unless a load test actually ran)
 *   5. Inserts exactly 3 RESOLVED alerts from "yesterday" with plausible
 *      resolution notes, so the history page has an audit trail on the
 *      first boot and 0 ACTIVE alerts — the demo always starts from a
 *      clean slate.
 *   6. Restarts api + worker via PM2 and waits 5s. Prometheus counters live
 *      in the processes, not the database, so this is what actually zeroes
 *      them; without it Grafana still shows the previous rehearsal's totals.
 *
 * IDEMPOTENT: running it twice in a row leaves the SAME state — alerts are
 * wiped and re-inserted from one fixed definition, students/wardens are
 * created only when missing, nothing is ever deleted on the people side.
 *
 * SAFE DURING A DEMO: even if an alert is active when this runs, it
 * completes; the next dashboard refresh (or the header Refresh button)
 * shows the empty state. The closing PM2 restart drops open sockets, which
 * reconnect on their own — run this BETWEEN rehearsals, not mid-demo.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEMO_BLOCKS, ensureTenancy, type DemoTenancy } from './tenancy';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'password123'; // matches prisma/seed.ts credentials
const LOADTEST_PASSWORD = 'LoadTest123!'; // k6-only pool
const LOADTEST_STUDENTS = 500;
const EXTRA_WARDENS = 4; // warden@hostel.local + 4 = 5 wardens

const BIG_BANNER = `
==========================================================================
 WARNING: DEMO RESET
==========================================================================
 This DELETES every EmergencyAlert, LeaveRequest and DeviceToken row and
 wipes the BullMQ escalation queue. It does NOT touch Student / Warden
 accounts.
==========================================================================
`;

// ---------------------------------------------------------------------------
// Deterministic load-test population. Seeded once by demo:reset; the k6
// script (load-test/sos.js) logs into loadtest_student_{i}@demo.hostel.
// Names/rooms are fixed so any report generated from a load run is
// reproducible run-over-run.
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Ishaan', 'Meera', 'Kabir', 'Saanvi',
  'Arjun', 'Riya', 'Rohan', 'Nisha', 'Vikram', 'Tara', 'Dev', 'Anika',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Nair', 'Iyer', 'Gupta', 'Menon', 'Rao', 'Joshi',
  'Mehta', 'Chopra', 'Das', 'Kulkarni',
];
const BLOCKS = ['A', 'B', 'C'];

function loadtestStudent(i: number) {
  const name = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${
    LAST_NAMES[i % LAST_NAMES.length]
  }`;
  return {
    name,
    email: `loadtest_student_${i}@demo.hostel`,
    roomNumber: `${BLOCKS[i % BLOCKS.length]}-${100 + (i % 400)}`,
    emergencyContact: `+9198765${String(10_000 + i).slice(-5)}`,
    medicalConditions:
      i % 7 === 0 ? 'Asthma' : i % 11 === 0 ? 'Penicillin allergy' : null,
  };
}

const EXTRA_WARDEN_NAMES = ['Rahul Verma', 'Sneha Kulkarni', 'Joseph Mathew', 'Priyanka Das'];

interface SeedResolvedAlert {
  studentEmail: string;
  type: 'MEDICAL' | 'FIRE' | 'SECURITY';
  room: string;
  yesterdayAt: { hour: number; minute: number };
  resolutionNote: string;
}

/**
 * The 3 "yesterday" rows behind the history page.
 *
 * THEY MUST BELONG TO THE NAMED DEMO STUDENTS, not to `loadtest_student_*`.
 * The load-test cleanup door (POST /loadtest/cleanup) deletes alerts by the
 * `loadtest_student_` email prefix, which is exactly what keeps it harmless —
 * so seeding the audit trail on those accounts meant the first k6 run wiped
 * the history the demo is about to show (observed: cleanup deleted 3 119 rows
 * = 1 573 + 1 543 burst rows + these 3). `room` documents the student's room;
 * the history table joins the real one.
 */
const SEED_RESOLVED: SeedResolvedAlert[] = [
  {
    studentEmail: 'aarav@hostel.local',
    type: 'MEDICAL',
    room: 'B-314',
    yesterdayAt: { hour: 2, minute: 14 },
    resolutionNote:
      'Student fell in the stairwell, escorted to campus clinic, discharged after 2 hours',
  },
  {
    studentEmail: 'diya@hostel.local',
    type: 'FIRE',
    room: 'A-102',
    yesterdayAt: { hour: 21, minute: 47 },
    resolutionNote:
      'Smoke triggered by burnt food in the common kitchen; ventilated room, no fire confirmed',
  },
  {
    studentEmail: 'aarav@hostel.local',
    type: 'SECURITY',
    room: 'B-314',
    yesterdayAt: { hour: 18, minute: 30 },
    resolutionNote:
      'Stranger reported at the C-block entrance; security verified entry pass, no further action',
  },
];

async function productionGuard(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.FORCE_DEMO_RESET === 'true') {
    console.log('>>> FORCE_DEMO_RESET=true — proceeding anyway. You were warned.');
    return;
  }
  console.error(
    '\nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n' +
      'X  REFUSED: NODE_ENV is "production".\n' +
      'X  demo:reset would delete every alert in the database.\n' +
      'X  To run anyway (you really should not):  FORCE_DEMO_RESET=true npm run demo:reset\n' +
      'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n',
  );
  process.exit(1);
}

async function flushEscalationQueue(): Promise<void> {
  // Imported here (not at top level) so a moved queue module path fails with
  // a clear message at reset time, not at import time for every caller.
  const { escalationQueue, escalationQueueConnection } = await import(
    '../src/queues/escalation.queue'
  );

  try {
    // obliterate() removes waiting/delayed/failed/completed jobs keyed to
    // this queue — exactly the "orphaned 60s SMS timer" scenario. force:
    // true empties even with active (in-flight) jobs; a rehearsal reset
    // prefers killing a possible in-flight escalation over leaving it armed.
    await escalationQueue.obliterate({ force: true });
    console.log('[demo-reset] escalation queue obliterated (no orphaned SMS timers)');
  } catch (error) {
    console.warn(
      '[demo-reset] could not obliterate queue (Redis down? nothing scheduled?):',
      error instanceof Error ? error.message : error,
    );
  } finally {
    await escalationQueue.close().catch(() => undefined);
    await escalationQueueConnection.quit().catch(() => undefined);
  }
}

async function ensurePopulation(
  bcryptHash: string,
  loadtestHash: string,
  tenancy: DemoTenancy,
): Promise<void> {
  // Named demo credentials — update metadata only, NEVER the password hash,
  // so what is printed to the examiner in the pre-demo checklist works on
  // every rehearsal.
  await prisma.warden.upsert({
    where: { email: 'warden@hostel.local' },
    update: { name: 'Priya Nair', hostelBlock: 'A', blockId: tenancy.blockIds.A },
    create: {
      name: 'Priya Nair',
      email: 'warden@hostel.local',
      passwordHash: bcryptHash,
      hostelBlock: 'A',
      blockId: tenancy.blockIds.A,
    },
  });

  for (let i = 0; i < EXTRA_WARDENS; i++) {
    const email = `warden.${i + 2}@demo.hostel`;
    const hostelBlock = BLOCKS[i % BLOCKS.length];
    await prisma.warden.upsert({
      where: { email },
      // blockId is tenancy metadata, not a credential: backfilling it on an
      // existing row is safe and keeps every warden inside the hierarchy.
      update: { blockId: tenancy.blockIds[hostelBlock] },
      create: {
        name: EXTRA_WARDEN_NAMES[i] ?? `Warden ${i + 2}`,
        email,
        passwordHash: bcryptHash,
        hostelBlock,
        blockId: tenancy.blockIds[hostelBlock],
      },
    });
  }

  for (const named of [
    {
      name: 'Aarav Sharma',
      email: 'aarav@hostel.local',
      roomNumber: 'B-314',
      emergencyContact: '+91 98765 43210',
      medicalConditions: 'Asthma',
    },
    {
      name: 'Diya Patel',
      email: 'diya@hostel.local',
      roomNumber: 'A-102',
      emergencyContact: '+91 98765 43211',
      medicalConditions: 'Penicillin allergy',
    },
  ]) {
    const blockId = tenancy.blockIds[named.roomNumber.charAt(0)];
    await prisma.student.upsert({
      where: { email: named.email },
      update: { blockId }, // credentials stay stable
      create: { ...named, passwordHash: bcryptHash, blockId },
    });
  }

  // The 500 load-test students. createMany + skipDuplicates: one round trip,
  // only the MISSING rows created, existing rows untouched (stable hashes).
  await prisma.student.createMany({
    data: Array.from({ length: LOADTEST_STUDENTS }, (_, idx) => {
      const s = loadtestStudent(idx + 1);
      return {
        ...s,
        passwordHash: loadtestHash,
        blockId: tenancy.blockIds[s.roomNumber.charAt(0)],
      };
    }),
    skipDuplicates: true,
  });

  // Rows created before the block columns existed (or before this reset
  // learned to fill them) have a null blockId. Backfill by room prefix so the
  // whole population answers "which block?" the same way.
  for (const block of DEMO_BLOCKS) {
    await prisma.student.updateMany({
      where: {
        blockId: null,
        roomNumber: { startsWith: `${block.letter}-` },
      },
      data: { blockId: tenancy.blockIds[block.letter] },
    });
    await prisma.warden.updateMany({
      where: { blockId: null, hostelBlock: block.letter },
      data: { blockId: tenancy.blockIds[block.letter] },
    });
  }
}

/**
 * Prometheus counters live in the API/worker processes, not the database, so
 * wiping rows leaves alerts_created_total at whatever the last rehearsal
 * reached. Restarting the processes is what actually zeroes them: each
 * instance boots with a fresh prom-client registry.
 *
 * Best-effort by design. A rehearsal run under `npm run dev` has no PM2, and
 * that must not fail the reset — the operator is told to restart by hand.
 */
async function restartMetricsProcesses(): Promise<void> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(exec);

  // A fixed literal with nothing interpolated: the shell is required to launch
  // npx.cmd on Windows, and an args array alongside shell:true is what Node's
  // DEP0190 flags as unescaped concatenation.
  const command =
    process.platform === 'win32'
      ? 'npx.cmd pm2 restart api worker --update-env'
      : 'npx pm2 restart api worker --update-env';

  try {
    const { stdout } = await run(command, { cwd: process.cwd(), timeout: 120_000 });
    console.log('[demo-reset] restarted api + worker — Prometheus counters zeroed');
    if (process.env.DEMO_RESET_VERBOSE === 'true') console.log(stdout);
  } catch (error) {
    console.warn(
      '[demo-reset] could not restart via PM2 (not running under PM2?). ' +
        'Restart the API and worker by hand or the Grafana counters will keep ' +
        'their pre-reset values:',
      error instanceof Error ? error.message : error,
    );
    return;
  }

  // The leave worker owns `leave_overdue_total`, so it needs the same restart
  // or the Grafana panel keeps yesterday's overdue count. It is optional: an
  // older PM2 process list (or a machine that only runs api + worker) must not
  // turn a successful reset into a failure.
  const leaveCommand =
    process.platform === 'win32'
      ? 'npx.cmd pm2 restart leave-worker --update-env'
      : 'npx pm2 restart leave-worker --update-env';
  try {
    await run(leaveCommand, { cwd: process.cwd(), timeout: 60_000 });
    console.log('[demo-reset] restarted leave-worker — overdue counter zeroed');
  } catch {
    console.warn('[demo-reset] leave-worker not in PM2; skipped its restart');
  }

  // PM2 reports "online" before the new processes have bound their ports and
  // served a scrape. Without this the summary prints against a half-started
  // cluster and the first Grafana refresh still shows the old counters.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

async function seedResolvedAlerts(wardenId: string, organizationId: string): Promise<void> {
  const students = await Promise.all(
    SEED_RESOLVED.map((seed) =>
      prisma.student.findUniqueOrThrow({ where: { email: seed.studentEmail } }),
    ),
  );

  const now = new Date();

  await Promise.all(
    SEED_RESOLVED.map((seed, i) => {
      const student = students[i];
      const createdAt = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - 1, // yesterday
          seed.yesterdayAt.hour,
          seed.yesterdayAt.minute,
        ),
      );

      return prisma.emergencyAlert.create({
        data: {
          studentId: student.id,
          organizationId,
          type: seed.type,
          status: 'RESOLVED',
          latitude: null,
          longitude: null,
          createdAt,
          acknowledgedAt: new Date(createdAt.getTime() + 42_000), // warden in 42s
          acknowledgedBy: wardenId,
          resolvedAt: new Date(createdAt.getTime() + 7 * 60_000), // closed 7min later
          resolutionNote: seed.resolutionNote,
        },
      });
    }),
  );
}

async function main(): Promise<void> {
  await productionGuard();
  console.log(BIG_BANNER);

  // One bcrypt hash per password, reused — hashing 505 users individually
  // would spend half a minute recreating bit-identical results. Cost 12 is
  // the project-wide policy (prisma/seed.ts hashes at 12; a cost-10 demo
  // population would quietly be the weakest accounts in the system).
  const bcryptHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const loadtestHash = await bcrypt.hash(LOADTEST_PASSWORD, 12);

  // The tenant hierarchy must exist before anyone is assigned to a block.
  const tenancy = await ensureTenancy(prisma);

  // 1) wipe the volatile state
  const removedAlerts = await prisma.emergencyAlert.deleteMany();
  const removedLeaves = await prisma.leaveRequest.deleteMany();
  const removedTokens = await prisma.deviceToken.deleteMany();
  console.log(
    `[demo-reset] deleted alerts=${removedAlerts.count} leaves=${removedLeaves.count} deviceTokens=${removedTokens.count}`,
  );

  // 2) kill orphaned SMS timers BEFORE creating new state
  await flushEscalationQueue();

  // 3) population (students/wardens are never deleted).
  //
  // ORDER MATTERS: ensurePopulation() UPSERTS the demo accounts, so it must
  // run before we read the head warden back. Reading first made demo:reset
  // fail with P2025 on a freshly migrated database (the exact state a new
  // clone / CI runner starts from) even though it then would have created
  // that warden a few lines later.
  await ensurePopulation(bcryptHash, loadtestHash, tenancy);

  const headWarden = await prisma.warden.findUniqueOrThrow({
    where: { email: 'warden@hostel.local' },
  });

  await seedResolvedAlerts(headWarden.id, tenancy.organizationId);

  // 4) zero the in-process Prometheus counters, then wait for the cluster to
  //    be serving again before reporting state.
  await restartMetricsProcesses();

  // 5) summary
  const [students, wardens, resolved, active, pendingQueue] = await Promise.all([
    prisma.student.count(),
    prisma.warden.count(),
    prisma.emergencyAlert.count({ where: { status: 'RESOLVED' } }),
    prisma.emergencyAlert.count({ where: { status: { in: ['PENDING', 'ACKNOWLEDGED'] } } }),
    prisma.emergencyAlert.count(),
  ]);

  // queue counts read via the (now-closed) connection is zero by definition
  // after a successful obliterate; print the state that matters to a human.
  console.log('');
  console.log(
    `Reset complete. ${active} active alerts, ${resolved} resolved, ${students} students, ${wardens} wardens. Ready for demo.`,
  );
  console.log(`(${pendingQueue} alert rows total; queue flushed.)`);
  console.log('');
}

main()
  .catch((error) => {
    console.error('demo-reset failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
