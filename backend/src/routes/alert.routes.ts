import { Readable } from 'node:stream';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import {
  alertsAcknowledgedTotal,
  alertsCreatedTotal,
  alertsResolvedTotal,
} from '../config/metrics';
import { authenticate, requireRole } from '../middleware/auth';
import { sosLimiter } from '../middleware/rateLimiters';
import { bindUser } from '../middleware/logContext';
import { getIO } from '../sockets';
import { sendAlertPush } from '../services/push.service';
import {
  cancelEscalation,
  enqueueEscalation,
  escalationQueue,
  escalationJobId,
} from '../queues/escalation.queue';

const router = Router();

/**
 * E6: the BullMQ connection keeps ioredis' offline queue, so during a Redis
 * outage queue commands PEND rather than reject — an `await` on one hangs the
 * HTTP response and the caller's catch block never runs. Bounding the call
 * surfaces the failure so the existing fallback can run. Abandoning a cancel
 * is safe: the processor re-checks alert status before sending (see
 * workers/escalation.processor.ts), so a job that survives cannot SMS an
 * acknowledged alert.
 */
const QUEUE_CALL_TIMEOUT_MS = 1_000;

function withQueueTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}_timeout_${QUEUE_CALL_TIMEOUT_MS}ms`)),
      QUEUE_CALL_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const studentSelect = {
  id: true,
  name: true,
  roomNumber: true,
  emergencyContact: true,
  medicalConditions: true,
} as const;

/**
 * The alert types the rest of the system understands (see the architecture
 * document's `alert_type` enum). Accepting arbitrary free text here meant an
 * injection-shaped string was stored and later interpolated into the SMS
 * body. Normalising case keeps the Flutter app, which sends "Medical",
 * working while rejecting anything the dashboard cannot render.
 */
const ALERT_TYPES = ['MEDICAL', 'FIRE', 'SECURITY', 'MENTAL_HEALTH', 'OTHER'] as const;

type AlertType = (typeof ALERT_TYPES)[number];

function normalizeAlertType(value: unknown): AlertType | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return (ALERT_TYPES as readonly string[]).includes(normalized)
    ? (normalized as AlertType)
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Student raises an SOS.
 * Location is optional: a GPS failure must never prevent the alert.
 * Emits `alert:new` to every connected warden.
 *
 * Middleware order on THIS route is deliberate:
 *   authenticate -> requireRole(student) -> sosLimiter -> handler.
 * The limiter MUST run after authentication because it is keyed by the
 * verified student id (req.user.id), not by IP — in a hostel all students
 * sit behind the same NAT IP. See rateLimiters.ts: an over-limit SOS
 * does NOT get a 429; it gets the break-glass override (allow + warn log +
 * sos_overrides_total).
 */
router.post(
  '/',
  authenticate,
  requireRole('STUDENT'),
  sosLimiter,
  async (req, res) => {
    const { type, latitude, longitude, locationAccuracy } = req.body ?? {};

    const alertType = normalizeAlertType(type);

    if (alertType === null) {
      res.status(400).json({
        error: `type must be one of ${ALERT_TYPES.join(', ')}`,
      });
      return;
    }

    const hasLatitude = latitude !== undefined && latitude !== null;
    const hasLongitude = longitude !== undefined && longitude !== null;

    if (hasLatitude !== hasLongitude) {
      res.status(400).json({ error: 'latitude and longitude must be provided together' });
      return;
    }

    if (
      hasLatitude &&
      (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90)
    ) {
      res.status(400).json({ error: 'latitude must be a number between -90 and 90' });
      return;
    }

    if (
      hasLongitude &&
      (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180)
    ) {
      res.status(400).json({ error: 'longitude must be a number between -180 and 180' });
      return;
    }

    if (
      locationAccuracy !== undefined &&
      locationAccuracy !== null &&
      (!isFiniteNumber(locationAccuracy) || locationAccuracy < 0)
    ) {
      res.status(400).json({ error: 'locationAccuracy must be a non-negative number' });
      return;
    }

    const student = await prisma.student.findUnique({
      where: { id: req.user!.id },
      select: { id: true },
    });

    if (!student) {
      res.status(401).json({ error: 'Student account no longer exists' });
      return;
    }

    const alert = await prisma.emergencyAlert.create({
      data: {
        studentId: req.user!.id,
        type: alertType,
        latitude: hasLatitude ? (latitude as number) : null,
        longitude: hasLongitude ? (longitude as number) : null,
        locationAccuracy:
          hasLatitude && isFiniteNumber(locationAccuracy) ? locationAccuracy : null,
      },
      include: { student: { select: studentSelect } },
    });

    // Metric — Grafana "SOS rate" + the HighSOSRate alert read this.
    alertsCreatedTotal.inc({ type: alertType });

    getIO().to('wardens').emit('alert:new', alert);

    // Push is additive and fire-and-forget: it must never delay or fail this
    // response. The realtime socket path always wins.
    sendAlertPush(alert);

    // Schedule the 60s escalation — also fire-and-forget. THE SOS ENDPOINT IS
    // SACRED: if Redis is down or unreachable, this logs an error and the SOS
    // still returns 201 fast. Realtime (socket) and push survive; only the
    // escalation SMS degrades, and only while Redis is down.
    enqueueEscalation(alert.id).catch((error) => {
      logger.error(
        {
          alertId: alert.id,
          err: error instanceof Error ? error.message : error,
        },
        `[escalation] could not schedule escalation for alert ${alert.id} (Redis down?)`,
      );
    });

    res.status(201).json(alert);
  },
);

/**
 * Warden fetches the alert board (newest first).
 *
 * CONTRACT (fixes C2): every alert the system holds is addressable here —
 * the old hard `take: 100` silently truncated the board at 100 rows and let
 * RESOLVED rows eat the window, so at 500 students a warden could stop
 * seeing live emergencies. `limit` defaults to the documented design scale
 * (500 students) and is capped at 1000 as a payload/DoS guard; `status`
 * filters server-side so the dashboard's tabs can ask for just one bucket.
 * The unbounded audit trail lives at GET /alerts/history, not here.
 */
const BOARD_DEFAULT_LIMIT = 500;
const BOARD_MAX_LIMIT = 1000;

router.get('/', authenticate, requireRole('WARDEN'), async (req, res) => {
  const statusParam =
    typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';

  let where: Prisma.EmergencyAlertWhereInput | undefined;
  if (statusParam !== '' && statusParam !== 'ALL') {
    const requested = statusParam
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');

    const bad = requested.filter(
      (value) => !(ALERT_STATUSES as readonly string[]).includes(value),
    );
    if (bad.length > 0) {
      res.status(400).json({
        error: `status must be a comma-separated list of: ${ALERT_STATUSES.join(', ')} (or ALL)`,
      });
      return;
    }

    where = { status: { in: requested } };
  }

  const requestedLimit = Number.parseInt(
    String(req.query.limit ?? String(BOARD_DEFAULT_LIMIT)),
    10,
  );
  const take = Number.isNaN(requestedLimit)
    ? BOARD_DEFAULT_LIMIT
    : Math.min(Math.max(1, requestedLimit), BOARD_MAX_LIMIT);

  const alerts = await prisma.emergencyAlert.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: { student: { select: studentSelect } },
  });

  res.json(alerts);
});

/**
 * Warden acknowledges an alert.
 * Emits `alert:updated` to the wardens room and to the student's private room.
 */
router.patch('/:id/acknowledge', authenticate, requireRole('WARDEN'), async (req, res) => {
  // Express 5 types allow string[] for params; this route only ever has one.
  const id = String(req.params.id);

  //
  // CANCEL-BEFORE-UPDATE, deliberately in this order.
  //
  // Trade-off (documented, not accidental): we cancel the scheduled
  // escalation BEFORE writing the DB state. If the process died between the
  // cancel and the DB write the escalation would be lost even though the
  // alert stayed PENDING — but this is the RIGHT side to fail on for a
  // medical system: the worst case is "acknowledge seemed to happen, no SMS
  // was sent", not "SMS spam at an already-acknowledged alert". The lost row
  // is recoverable from BullMQ logs; an unnecessary panic SMS cannot be.
  //
  // If cancel throws (job already fired and completed, stale Redis, etc.),
  // we catch, log, and CONTINUE the acknowledge — the idempotency guard in
  // the worker re-checks alert status, so a job that slips through cancel
  // still cannot double-send.
  //
  try {
    const removed = await withQueueTimeout(cancelEscalation(id), 'escalation_cancel');
    if (removed) {
      // escalations_cancelled_total is incremented inside cancelEscalation
      // (src/queues/escalation.queue.ts) — the only place that knows the
      // removal actually happened.
      logger.info(
        { alertId: id, jobId: escalationJobId(id) },
        `[escalation] job ${escalationJobId(id)} removed on acknowledge`,
      );
    }
  } catch (error) {
    // Job already fired / processed, or Redis hiccup: acknowledge must win.
    logger.warn(
      {
        alertId: id,
        err: error instanceof Error ? error.message : error,
      },
      `[escalation] cancel on acknowledge skipped for alert ${id}`,
    );
  }

  // Conditional update: only one warden can move PENDING -> ACKNOWLEDGED.
  const result = await prisma.emergencyAlert.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      acknowledgedBy: req.user!.id,
    },
  });

  if (result.count === 0) {
    const existing = await prisma.emergencyAlert.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.status(409).json({ error: `Alert is already ${existing.status}` });
    return;
  }

  // Metric — pairs with alerts_created_total: acknowledged minus created
  // gives the pipeline's "still unhandled" residue.
  alertsAcknowledgedTotal.inc();
  bindUser(req, req.user!.id, 'WARDEN');

  const alert = await prisma.emergencyAlert.findUniqueOrThrow({
    where: { id },
    include: { student: { select: studentSelect } },
  });

  const io = getIO();
  io.to('wardens').emit('alert:updated', alert);
  io.to(`student:${alert.studentId}`).emit('alert:updated', alert);

  res.json(alert);
});

/**
 * Warden resolves an alert — the missing terminal step:
 * ACKNOWLEDGED -> RESOLVED.
 *
 * TRANSITION RULES (duplex with the lifecycle comment in schema.prisma):
 * - PENDING        -> 409 { error: "invalid_transition", current: "PENDING",
 *                             allowed: ["ACKNOWLEDGED"] }. A warden cannot
 *                             "close" a case no one has responded to: even if
 *                             the warden physically handled it, the audit
 *                             trail must show the acknowledge step first.
 * - ACKNOWLEDGED   -> 201/200 RESOLVED with resolvedAt + resolutionNote.
 * - RESOLVED       -> 200 idempotent (NOT 409, see below).
 *
 * WHY DOUBLE-RESOLVE IS IDEMPOTENT: resolving is a terminal record-keeping
 * step — the second request carries the same intent as the first and the
 * system state is already exactly what the caller wants, so repeating it
 * must succeed with no second metric increment and no second socket emit
 * (a fan-out to every warden + the student's phone for a no-op is exactly
 * the "the API is confused" behaviour a well-broken 409 is supposed to
 * surface, so we do not paper over it with one). Acknowledge is deliberately
 * the opposite: a second acknowledge 409s because two wardens racing on the
 * SAME pending alert is a real coordination event the winner should see,
 * not one to silently absorb.
 *
 * The student's confirmation screen turns "Case closed" via the SAME
 * alert:updated event shape acknowledge emits; wardens receive alert:resolved.
 */
router.patch('/:id/resolve', authenticate, requireRole('WARDEN'), async (req, res) => {
  const id = String(req.params.id);

  const rawNote = (req.body ?? {}).resolutionNote;
  if (typeof rawNote !== 'string') {
    res.status(400).json({ error: 'resolutionNote must be a string (3-500 chars)' });
    return;
  }
  const resolutionNote = rawNote.trim();
  if (resolutionNote.length < 3 || resolutionNote.length > 500) {
    res
      .status(400)
      .json({ error: 'resolutionNote must be 3-500 characters' });
    return;
  }

  const existing = await prisma.emergencyAlert.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }

  // Idempotent double-resolve: return the current state, change nothing.
  if (existing.status === 'RESOLVED') {
    const resolved = await prisma.emergencyAlert.findUniqueOrThrow({
      where: { id },
      include: { student: { select: studentSelect } },
    });
    res.json(resolved);
    return;
  }

  // Invalid transition: only ACKNOWLEDGED alerts may be resolved.
  if (existing.status !== 'ACKNOWLEDGED') {
    res.status(409).json({
      error: 'invalid_transition',
      current: existing.status,
      allowed: ['ACKNOWLEDGED'],
    });
    return;
  }

  // Same cancel-before-write ordering as acknowledge. An ACKNOWLEDGED alert's
  // job is normally gone already; this covers a cancel that failed then.
  try {
    const removed = await withQueueTimeout(cancelEscalation(id), 'escalation_cancel');
    if (removed) {
      logger.info(
        { alertId: id, jobId: escalationJobId(id) },
        `[escalation] job ${escalationJobId(id)} removed on resolve`,
      );
    }
  } catch (error) {
    logger.warn(
      {
        alertId: id,
        err: error instanceof Error ? error.message : error,
      },
      `[escalation] cancel on resolve skipped for alert ${id}`,
    );
  }

  // Conditional update = the race-safety net: if two wardens resolve at the
  // same moment exactly one updateMany matches (status still ACKNOWLEDGED).
  const result = await prisma.emergencyAlert.updateMany({
    where: { id, status: 'ACKNOWLEDGED' },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolutionNote,
    },
  });

  if (result.count === 0) {
    // Another warden resolved (or acknowledged-state was flipped) in between
    // the read and the write: re-check and behave idempotently if it was a
    // resolve race, surface a conflict otherwise.
    const reread = await prisma.emergencyAlert.findUnique({ where: { id } });
    if (reread && reread.status === 'RESOLVED') {
      const resolved = await prisma.emergencyAlert.findUniqueOrThrow({
        where: { id },
        include: { student: { select: studentSelect } },
      });
      res.json(resolved);
      return;
    }
    res.status(409).json({
      error: 'invalid_transition',
      current: reread?.status ?? 'UNKNOWN',
      allowed: ['ACKNOWLEDGED'],
    });
    return;
  }

  // Metric — pairs with alerts_created_total / alerts_acknowledged_total:
  // resolved converging to acknowledged over a shift means cases get closed,
  // a growing gap means acknowledgements that were never finished.
  alertsResolvedTotal.inc();
  bindUser(req, req.user!.id, 'WARDEN');
  logger.info({ alertId: id, by: req.user!.id }, '[alerts] resolved');

  const alert = await prisma.emergencyAlert.findUniqueOrThrow({
    where: { id },
    include: { student: { select: studentSelect } },
  });

  // Wardens get the dedicated alert:resolved; the student app keeps the
  // alert:updated shape it already renders "Case closed" from.
  const io = getIO();
  io.to('wardens').emit('alert:resolved', alert);
  io.to(`student:${alert.studentId}`).emit('alert:updated', alert);

  res.json(alert);
});

/**
 * ============================================================================
 * ALERT HISTORY — the audit trail.
 * ============================================================================
 *
 * QUERY SHAPE: per selected status, a branch `(WHERE a.status = X ORDER BY
 * created_at DESC, id DESC LIMIT <page-limit + page-offset>)`, UNION ALL'd,
 * then one outer sort + LIMIT/OFFSET. Each branch is the shape
 * idx_alerts_status_created (status, created_at DESC) exists for: equality on
 * the leading column, then an ordered walk of the trailing column. The count
 * query reuses the same predicate via status IN (...).
 *
 * WHETHER THE INDEX IS USED DEPENDS ON TABLE SIZE — that is the planner
 * doing its job, not a defect. The measured plans are below.
 */

// ---------------------------------------------------------------------------
// MEASURED EXPLAIN (ANALYZE) — captured on this machine with
//   npx tsx scripts/perf-seed.ts
// which runs explain.sql (all three statuses, page 1, LIMIT 25) at the current
// row count, again with seq scans disabled, and again after seeding 5,000
// synthetic rows. The synthetic rows are deleted by the same script.
// Branches are trimmed to their access path; the three are identical in shape.
//
// A. 23 rows (dev/demo size) — Seq Scan + Sort. CORRECT: reading a 2-page
//    table is cheaper than an index descent, and the Sort only orders the
//    handful of rows the branch returns.
//
//   Limit  (cost=70.10..70.18 rows=5 width=250) (actual time=0.603..0.629 rows=23 loops=1)
//     ->  Merge Append  (cost=70.10..70.18 ...)
//           Sort Key: a."createdAt" DESC, a.id DESC
//           ->  Limit  (cost=18.57..18.58 rows=1 ...)
//                 ->  Sort  (cost=18.57..18.58 ...)
//                       Sort Method: quicksort  Memory: 29kB
//                       ->  Seq Scan on "EmergencyAlert" a  (cost=0.00..2.04 rows=1 ...)
//                             Filter: (status = 'PENDING'::text)
//                             Rows Removed by Filter: 7
//           ->  ... same shape for ACKNOWLEDGED and RESOLVED
//   Execution Time: 1.600 ms
//
// B. Same row count, SET LOCAL enable_seqscan = off — proves an index path is
//    available for this exact query shape (the planner is choosing, not unable).
//    WHICH index wins under forcing is statistics-dependent: with 23 rows the
//    capture below chose the composite, while at 3 rows it picks
//    idx_alerts_student instead (re-verified 2026-11-10). Block C is the
//    claim that matters: at 5,003 rows the planner picks the composite
//    unforced.
//
//   ->  Index Scan using idx_alerts_status_created on "EmergencyAlert" a
//         (cost=0.13..5.90 rows=1 width=238) (actual time=0.043..0.077 rows=16 loops=1)
//         Index Cond: (status = 'PENDING'::text)
//   ->  ... same for ACKNOWLEDGED and RESOLVED
//   Execution Time: 1.729 ms
//
// C. 5,023 rows — the planner picks the index on its own, no forcing:
//
//   Limit  (cost=3.11..11.94 rows=25 width=232) (actual time=0.802..0.821 rows=25 loops=1)
//     ->  Merge Append  (cost=3.11..29.59 rows=75 ...)
//           ->  Limit  (cost=1.03..9.50 rows=25 ...)
//                 ->  Incremental Sort  (cost=1.03..571.61 rows=1683 ...)
//                       Sort Key: a."createdAt" DESC, a.id DESC
//                       Presorted Key: a."createdAt"
//                       Full-sort Groups: 1  Sort Method: quicksort  Peak Memory: 31kB
//                       ->  Index Scan using idx_alerts_status_created on "EmergencyAlert" a
//                             (cost=0.28..410.05 rows=1683 ...) (actual time=0.089..0.106 rows=26 loops=1)
//                             Index Cond: (status = 'PENDING'::text)
//           ->  ... same for ACKNOWLEDGED and RESOLVED
//   Execution Time: 1.918 ms
//
// WHAT THIS PROVES: the index carries the status equality AND the createdAt
// DESC ordering (note "Presorted Key" and rows=26 read to serve a LIMIT 25 —
// the walk stops at the page, it does not scan 1,683 matches). The
// Incremental Sort only resolves the `id DESC` tiebreaker within equal
// timestamps. It does NOT prove "no sort node ever" — the earlier version of
// this comment claimed that, and claimed a Bitmap Index Scan at demo size.
// Both were false; the captures above replace them.
//
// Reproduce with scripts/perf-seed.ts (one-time; it deletes what it seeds)
// or tests/index.test.ts (opt-in, see docs/MANUAL_TESTS.md).
// ---------------------------------------------------------------------------

const ALERT_STATUSES = ['PENDING', 'ACKNOWLEDGED', 'RESOLVED'] as const;

type AlertStatus = (typeof ALERT_STATUSES)[number];

const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;
const CSV_PAGE_SIZE = 500;

interface HistoryFilters {
  statuses: AlertStatus[];
  from: Date | null;
  to: Date | null;
  studentName: string | null;
  page: number; // 1-based
  limit: number;
}

export interface HistoryRow {
  id: string;
  type: string;
  status: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  studentId: string;
  studentName: string;
  roomNumber: string;
  acknowledgedByName: string | null;
}

/**
 * Parse + validate /history query parameters. Bad input is a 400, never a
 * silent default: bogus date ranges returning "everything" is how audit
 * exports end up in front of the Dean missing rows.
 */
function parseHistoryFilters(query: Record<string, unknown>): HistoryFilters | string {
  const rawStatus = typeof query.status === 'string' ? query.status : '';
  let statuses: AlertStatus[];
  if (rawStatus === '') {
    statuses = [...ALERT_STATUSES]; // default: every status, newest first
  } else {
    const requested = rawStatus
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s !== '');
    const bad = requested.filter(
      (s) => !(ALERT_STATUSES as readonly string[]).includes(s),
    );
    if (bad.length > 0) {
      return `status must be a comma-separated list of: ${ALERT_STATUSES.join(', ')}`;
    }
    // Deduped, order canonicalised so two calls with the same filter share
    // plan and cache behaviour.
    statuses = ALERT_STATUSES.filter((s) => requested.includes(s));
  }

  let from: Date | null = null;
  if (typeof query.from === 'string' && query.from !== '') {
    const parsed = new Date(query.from);
    if (Number.isNaN(parsed.getTime())) return 'from must be an ISO 8601 date';
    from = parsed;
  }

  let to: Date | null = null;
  if (typeof query.to === 'string' && query.to !== '') {
    const parsed = new Date(query.to);
    if (Number.isNaN(parsed.getTime())) return 'to must be an ISO 8601 date';
    to = parsed;
  }

  // Student search is a name SUBSTRING (wardens remember faces and rooms,
  // rarely exact spellings); centre-truncated ILIKE, escaped via parameter
  // binding (Prisma) — never string-concatenated.
  const studentName =
    typeof query.studentName === 'string' && query.studentName.trim() !== ''
      ? query.studentName.trim()
      : null;

  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const limitRaw = Number.parseInt(String(query.limit ?? String(HISTORY_DEFAULT_LIMIT)), 10);
  const limit = Number.isNaN(limitRaw)
    ? HISTORY_DEFAULT_LIMIT
    : Math.min(Math.max(1, limitRaw), HISTORY_MAX_LIMIT);

  return { statuses, from, to, studentName, page, limit };
}

interface HistoryPredicateFilters {
  from: Date | null;
  to: Date | null;
  /** Applied INSIDE each status branch so LIMIT/OFFSET and COUNT agree. */
  studentName?: string | null;
}

/** Escape LIKE metacharacters so a student name is matched literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Shared WHERE fragment for history reads. The alert table is always aliased
 * `a`; the student-name test is an EXISTS subquery for one reason: it must
 * run INSIDE the per-status branch, BEFORE that branch's LIMIT. Applying the
 * name after the branch limit (the pre-fix behaviour) silently hid matches
 * that fell beyond the first `offset + limit` rows of a status and made the
 * page disagree with the COUNT.
 */
function historyPredicate(filters: HistoryPredicateFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [];

  if (filters.from) {
    parts.push(Prisma.sql`a."createdAt" >= ${filters.from}`);
  }
  if (filters.to) {
    // `to` is inclusive of the instant given (UI sends end-of-day).
    parts.push(Prisma.sql`a."createdAt" <= ${filters.to}`);
  }
  if (filters.studentName) {
    parts.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "Student" s2
        WHERE s2.id = a."studentId"
          AND s2.name ILIKE ${`%${escapeLikePattern(filters.studentName)}%`}
      )`,
    );
  }

  return parts.length > 0 ? Prisma.join(parts, ' AND ') : Prisma.empty;
}

/**
 * One UNION-branch per selected status.
 *
 * BRANCH SHAPE (the index proof):
 * the innermost subquery touches ONLY "EmergencyAlert" — equality on the
 * index's leading column (status) + an ordered walk of the trailing column
 * (created_at DESC) + a LIMIT. That is the shape idx_alerts_status_created
 * serves, and the planner uses it once the table is large enough to be worth
 * an index descent (see the measured plans above the history endpoint — at
 * demo size it correctly prefers a Seq Scan). Student/Warden columns are
 * joined OUTSIDE the scan on primary keys (25 rows in, 25 point lookups), and
 * the full-pipeline predicate fragment applies first.
 *
 * `scanLimit` = offset + limit of the page being served: each branch walks
 * its slice of the index backwards and stops there — O(page + offset).
 */
function historyBranch(
  status: AlertStatus,
  filters: HistoryFilters,
  scanLimit: number,
): Prisma.Sql {
  // Date range AND student name are applied INSIDE the branch, before the
  // LIMIT — see historyPredicate() for why the name cannot be filtered after
  // the branch limit.
  const predicate = historyPredicate({
    from: filters.from,
    to: filters.to,
    studentName: filters.studentName,
  });

  return Prisma.sql`(
    SELECT core.id                AS "id",
           core.type              AS "type",
           core.status            AS "status",
           core."createdAt"       AS "createdAt",
           core."acknowledgedAt"  AS "acknowledgedAt",
           core."resolvedAt"      AS "resolvedAt",
           core."resolutionNote"  AS "resolutionNote",
           s.id                   AS "studentId",
           s.name                 AS "studentName",
           s."roomNumber"         AS "roomNumber",
           w.name                 AS "acknowledgedByName"
    FROM (
      SELECT a.id, a.type, a.status, a."createdAt", a."acknowledgedAt",
             a."resolvedAt", a."resolutionNote", a."studentId", a."acknowledgedBy"
      FROM "EmergencyAlert" a
      WHERE a.status = ${status}
        ${predicate === Prisma.empty ? Prisma.empty : Prisma.sql`AND ${predicate}`}
      ORDER BY a."createdAt" DESC, a.id DESC
      LIMIT ${scanLimit}
    ) AS core
    JOIN "Student" s     ON s.id = core."studentId"
    LEFT JOIN "Warden" w ON w.id = core."acknowledgedBy"
    ORDER BY core."createdAt" DESC, core.id DESC
    LIMIT ${scanLimit}
  )`;
}

/** Rows for one page, one ordered query, indexes documented above. */
export async function fetchHistoryPage(
  filters: HistoryFilters,
): Promise<HistoryRow[]> {
  const offset = (filters.page - 1) * filters.limit;
  return prisma.$queryRaw<HistoryRow[]>(pageHistoryPageSql(filters, offset, filters.limit));
}

/** COUNT for the same filter set (pagination metadata). */
export async function fetchHistoryCount(filters: HistoryFilters): Promise<number> {
  const statusList = Prisma.join(
    filters.statuses.map((status) => Prisma.sql`${status}`),
    ', ',
  );
  const predicate = historyPredicate({
    from: filters.from,
    to: filters.to,
    studentName: filters.studentName,
  });

  const rows = await prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS "total"
    FROM "EmergencyAlert" a
    JOIN "Student" s ON s.id = a."studentId"
    WHERE a.status IN (${statusList})
      ${predicate === Prisma.empty ? Prisma.empty : Prisma.sql`AND ${predicate}`}
  `);
  return rows[0]?.total ?? 0;
}

/**
 * GET /alerts/history?page=1&limit=25&from=&to=&status=PENDING,RESOLVED&studentName=diya
 *
 * The audit-trail endpoint behind the /history page. Pure reads: no limiter
 * change, no extra auth beyond WARDEN. The date range here is on createdAt
 * (an alert's STORY started when the student raised it), not resolvedAt.
 */
router.get('/history', authenticate, requireRole('WARDEN'), async (req, res) => {
  const filters = parseHistoryFilters(req.query as Record<string, unknown>);
  if (typeof filters === 'string') {
    res.status(400).json({ error: filters });
    return;
  }

  const [rows, total] = await Promise.all([
    fetchHistoryPage(filters),
    fetchHistoryCount(filters),
  ]);

  res.json({
    data: rows.map(historyRowToApi),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.limit)),
    },
  });
});

/** API shape for the history table (ISO strings, warden-friendly names). */
function historyRowToApi(row: HistoryRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    acknowledgedByName: row.acknowledgedByName,
    student: {
      id: row.studentId,
      name: row.studentName,
      roomNumber: row.roomNumber,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV export — STREAMED, not buffered.
//
// WHY: the viva claim is "this is how we'd scale to 5000 students". A
// res.json(rows) export loads EVERY row into one JS array (and one JSON
// string) before the first byte leaves the process; with 5000 students'
// worth of alerts that is exactly the OOM-shaped pattern we criticise.
//
// HOW: a custom Readable pages the SAME history query
// (one index walk per selected status) in bounded batches of 500 rows via
// $queryRaw, res.write()'ing each batch. Memory stays O(batch) no matter how
// many alerts exist, and backpressure through the HTTP socket is free
// because the Readable is consumed by Express via pipeline().
//
// NOTE ON PRISMA: Prisma 6.7's $queryRaw is eager (PrismaPromise<array>) —
// there is no native raw-query cursor yet. The Readable below produces the
// same streaming guarantee by paging the identical indexed query in bounded
// batches; when Prisma ships a raw cursor, only `_read()` changes.
//
// PIPE-QUERY parity with the table: identical filters, identical branch
// shape, identical column order — a CSV row must equal its table row.
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'Date/Time,Student,Room,Type,Status,Acknowledged by,Resolved at,Resolution note';

/** RFC 4180 field escaping + spreadsheet-formula injection guard. */
function csvField(value: string | number | null): string {
  const raw =
    value === null
      ? ''
      : String(value);
  if (raw === '') return '';
  // Neutralise =,+,-,@ leading characters so Excel/LibreOffice cannot
  // execute a crafted audit-trail cell as a formula.
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/["\r\n,]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function historyRowToCsv(row: HistoryRow): string {
  return [
    csvField(row.createdAt.toISOString()),
    csvField(row.studentName),
    csvField(row.roomNumber),
    csvField(row.type),
    csvField(row.status),
    csvField(row.acknowledgedByName ?? ''),
    csvField(row.resolvedAt ? row.resolvedAt.toISOString() : null),
    csvField(row.resolutionNote ?? ''),
  ].join(',');
}

class HistoryCsvStream extends Readable {
  private readonly filters: HistoryFilters;
  private offset = 0;
  private sentHeader = false;

  constructor(filters: HistoryFilters) {
    // encoding: utf8 allows pushing formatted string lines into byte/HTTP streams safely
    super({ encoding: 'utf8' });
    this.filters = filters;
  }

  override async _read(): Promise<void> {
    try {
      if (!this.sentHeader) {
        this.sentHeader = true;
        this.push(`${CSV_HEADER}\r\n`);
      }

      const rows = await prisma.$queryRaw<HistoryRow[]>(
        pageHistoryPageSql(this.filters, this.offset, CSV_PAGE_SIZE),
      );

      for (const row of rows) {
        this.push(`${historyRowToCsv(row)}\r\n`);
      }

      if (rows.length < CSV_PAGE_SIZE) {
        this.push(null); // done
      } else {
        this.offset += rows.length;
      }
    } catch (error) {
      // Destroy the stream (and the HTTP response) rather than pushing
      // half-format garbage: a truncated export is worse than a 5xx.
      this.destroy(error instanceof Error ? error : new Error('history csv failed'));
    }
  }
}

/** Same branch shape as fetchHistoryPage, offset-compose for the pager. */
function pageHistoryPageSql(
  filters: HistoryFilters,
  offset: number,
  limit: number,
): Prisma.Sql {
  const branches = filters.statuses.map((status) =>
    historyBranch(status, filters, offset + limit),
  );
  return Prisma.sql`
    SELECT * FROM (
      ${Prisma.join(branches, ' UNION ALL ')}
    ) AS "recent"
    ORDER BY "createdAt" DESC, id DESC
    OFFSET ${offset} LIMIT ${limit}
  `;
}

/**
 * GET /alerts/history.csv — same filters as /history, streamed text/csv
 * (see the Readable above). Kept OUT of the rate limiter's dashboard budget
 * only implicitly: 100/60s/IP is plenty for a human-context export.
 */
router.get('/history.csv', authenticate, requireRole('WARDEN'), async (req, res) => {
  const filters = parseHistoryFilters(req.query as Record<string, unknown>);
  if (typeof filters === 'string') {
    res.status(400).json({ error: filters });
    return;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="alert-history-${new Date().toISOString().slice(0, 10)}.csv"`,
  );

  logger.info(
    { by: req.user!.id, statuses: filters.statuses },
    '[alerts] history export',
  );

  // pipeline() backpressures + destroys both sides on error, so a client
  // disconnect does not leave a river of un-consumed rows running.
  const { pipeline } = await import('node:stream/promises');
  await pipeline(new HistoryCsvStream(filters), res);
});

/**
 * Inspect the scheduled escalation for one alert (warden only).
 * Powers the dashboard indicator and makes the pipeline debuggable:
 * - scheduled: true while the job sits in the `delayed`/`waiting` state
 * - jobState:  raw BullMQ state string (delayed | waiting | active |
 *              completed | failed | unknown)
 * - firedAt:   when the job actually completed processing (e.g. SMS sent),
 *              or null if it never fired
 * BullMQ note: "unknown" is a real state, returned when the job no longer
 * exists (removed or swept), so scheduled=false pairs with it.
 */
router.get('/:id/escalation-status', authenticate, requireRole('WARDEN'), async (req, res) => {
  const id = String(req.params.id);

  try {
    const job = await withQueueTimeout(
      escalationQueue.getJob(escalationJobId(id)),
      'escalation_status',
    );

    if (!job) {
      res.json({ scheduled: false, jobState: null, firedAt: null });
      return;
    }

    const jobState = await withQueueTimeout(job.getState(), 'escalation_state');
    const scheduled = jobState === 'delayed' || jobState === 'waiting';
    const firedAt = job.processedOn ? new Date(job.processedOn) : null;

    res.json({ scheduled, jobState, firedAt });
  } catch (error) {
    // Unknown is not "not scheduled": answering scheduled:false here would
    // tell the warden the escalation is off when it may still fire.
    logger.warn(
      { alertId: id, err: error instanceof Error ? error.message : error },
      '[escalation] status unavailable (Redis down?)',
    );
    res.status(503).json({ error: 'escalation_status_unavailable' });
  }
});

export default router;
