import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import {
  leaveRequestsTotal,
  leaveOverdueTotal,
  leaveCurrentlyAway,
  alertsCreatedTotal,
} from '../config/metrics';
import { authenticate, requireRole } from '../middleware/auth';
import { getIO } from '../sockets';
import { enqueueEscalation } from '../queues/escalation.queue';
import { sendAlertPush } from '../services/push.service';

const router = Router();

const VALID_LEAVE_TYPES = ['DAY_OUTING', 'NIGHT_OUT', 'HOME_VISIT', 'MEDICAL'] as const;
type LeaveType = (typeof VALID_LEAVE_TYPES)[number];

const studentSelect = {
  id: true,
  name: true,
  email: true,
  roomNumber: true,
  emergencyContact: true,
  medicalConditions: true,
};

const wardenSelect = {
  id: true,
  name: true,
  email: true,
  hostelBlock: true,
};

/** Safely extract a single string param from Express 5 params. */
function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : (val ?? '');
}

// ---------------------------------------------------------------------------
// 1. POST /leaves — Student submits a new leave request
// ---------------------------------------------------------------------------
router.post(
  '/',
  authenticate,
  requireRole('STUDENT'),
  async (req: Request, res: Response): Promise<void> => {
    const studentId = req.user!.id;
    const {
      type,
      reason,
      destination,
      emergencyContact,
      departureTime,
      expectedReturn,
    } = req.body ?? {};

    if (!type || !reason || !destination || !departureTime || !expectedReturn) {
      res.status(400).json({
        error: 'Missing required fields: type, reason, destination, departureTime, expectedReturn',
      });
      return;
    }

    if (!VALID_LEAVE_TYPES.includes(type as LeaveType)) {
      res.status(400).json({
        error: `Invalid leave type. Must be one of: ${VALID_LEAVE_TYPES.join(', ')}`,
      });
      return;
    }

    const reasonText = String(reason).trim();
    const destinationText = String(destination).trim();

    if (reasonText.length < 3 || reasonText.length > 500) {
      res.status(400).json({ error: 'reason must be 3-500 characters' });
      return;
    }

    if (destinationText.length < 2 || destinationText.length > 200) {
      res.status(400).json({ error: 'destination must be 2-200 characters' });
      return;
    }

    const depDate = new Date(departureTime);
    const retDate = new Date(expectedReturn);

    if (isNaN(depDate.getTime()) || isNaN(retDate.getTime())) {
      res.status(400).json({ error: 'Invalid departureTime or expectedReturn date format' });
      return;
    }

    if (retDate <= depDate) {
      res.status(400).json({ error: 'expectedReturn must be after departureTime' });
      return;
    }

    // 60s of clock skew is tolerated so a student's phone that is a few
    // seconds behind cannot be rejected for "now".
    if (depDate.getTime() < Date.now() - 60_000) {
      res.status(400).json({ error: 'departureTime must not be in the past' });
      return;
    }

    try {
      const student = await prisma.student.findUnique({
        where: { id: studentId },
        select: { emergencyContact: true },
      });

      const contact = emergencyContact?.trim() || student?.emergencyContact || 'Not provided';

      const leave = await prisma.leaveRequest.create({
        data: {
          studentId,
          type,
          reason: reasonText,
          destination: destinationText,
          emergencyContact: contact,
          departureTime: depDate,
          expectedReturn: retDate,
          status: 'SUBMITTED',
        },
        include: {
          student: { select: studentSelect },
        },
      });

      leaveRequestsTotal.inc({ type, status: 'SUBMITTED' });

      try {
        const io = getIO();
        io.to('wardens').emit('leave:created', leave);
      } catch (ioErr) {
        logger.warn({ err: ioErr }, '[socket] could not emit leave:created');
      }

      logger.info({ leaveId: leave.id, studentId, type }, '[leave] request submitted');
      res.status(201).json(leave);
    } catch (error) {
      logger.error({ err: error, studentId }, '[leave] failed to create leave request');
      res.status(500).json({ error: 'Could not create leave request' });
    }
  },
);

// ---------------------------------------------------------------------------
// 2. GET /leaves/my — Student views their own leave history
// ---------------------------------------------------------------------------
router.get(
  '/my',
  authenticate,
  requireRole('STUDENT'),
  async (req: Request, res: Response): Promise<void> => {
    const studentId = req.user!.id;
    const { status } = req.query;

    try {
      const whereClause: { studentId: string; status?: string } = { studentId };
      if (typeof status === 'string' && status.trim().length > 0) {
        whereClause.status = status.trim().toUpperCase();
      }

      const leaves = await prisma.leaveRequest.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        include: {
          reviewer: { select: wardenSelect },
        },
      });

      res.json(leaves);
    } catch (error) {
      logger.error({ err: error, studentId }, '[leave] failed to fetch student leaves');
      res.status(500).json({ error: 'Could not fetch leave history' });
    }
  },
);

// ---------------------------------------------------------------------------
// 3. GET /leaves/stats — Warden statistics summary
// ---------------------------------------------------------------------------
router.get(
  '/stats',
  authenticate,
  requireRole('WARDEN'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const [submitted, departed, approved, overdue] = await Promise.all([
        prisma.leaveRequest.count({ where: { status: 'SUBMITTED' } }),
        prisma.leaveRequest.count({ where: { status: 'DEPARTED' } }),
        prisma.leaveRequest.count({ where: { status: 'APPROVED' } }),
        prisma.leaveRequest.count({
          where: {
            OR: [
              { status: 'OVERDUE' },
              { status: 'DEPARTED', expectedReturn: { lt: now } },
            ],
          },
        }),
      ]);

      leaveCurrentlyAway.set(departed);

      res.json({
        pendingApprovals: submitted,
        currentlyAway: departed,
        approvedPasses: approved,
        overdueCount: overdue,
      });
    } catch (error) {
      logger.error({ err: error }, '[leave] failed to fetch stats');
      res.status(500).json({ error: 'Could not fetch leave stats' });
    }
  },
);

// ---------------------------------------------------------------------------
// 4. GET /leaves/active — List students currently away (DEPARTED)
// ---------------------------------------------------------------------------
router.get(
  '/active',
  authenticate,
  requireRole('WARDEN'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const activeLeaves = await prisma.leaveRequest.findMany({
        where: { status: 'DEPARTED' },
        orderBy: { expectedReturn: 'asc' },
        include: {
          student: { select: studentSelect },
        },
      });

      res.json(activeLeaves);
    } catch (error) {
      logger.error({ err: error }, '[leave] failed to fetch active leaves');
      res.status(500).json({ error: 'Could not fetch active departed leaves' });
    }
  },
);

// ---------------------------------------------------------------------------
// 5. GET /leaves/overdue — List students whose return is overdue
// ---------------------------------------------------------------------------
router.get(
  '/overdue',
  authenticate,
  requireRole('WARDEN'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const overdueLeaves = await prisma.leaveRequest.findMany({
        where: {
          OR: [
            { status: 'OVERDUE' },
            { status: 'DEPARTED', expectedReturn: { lt: now } },
          ],
        },
        orderBy: { expectedReturn: 'asc' },
        include: {
          student: { select: studentSelect },
        },
      });

      res.json(overdueLeaves);
    } catch (error) {
      logger.error({ err: error }, '[leave] failed to fetch overdue leaves');
      res.status(500).json({ error: 'Could not fetch overdue leaves' });
    }
  },
);

// ---------------------------------------------------------------------------
// 6. GET /leaves/:id/pass — Student gets their active gate pass QR & code
// ---------------------------------------------------------------------------
router.get(
  '/:id/pass',
  authenticate,
  requireRole('STUDENT'),
  async (req: Request, res: Response): Promise<void> => {
    const studentId = req.user!.id;
    const id = param(req, 'id');

    try {
      const leave = await prisma.leaveRequest.findUnique({
        where: { id },
        include: {
          student: { select: studentSelect },
        },
      });

      if (!leave) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }

      if (leave.studentId !== studentId) {
        res.status(403).json({ error: 'Forbidden: access denied to this leave pass' });
        return;
      }

      if (!['APPROVED', 'DEPARTED'].includes(leave.status)) {
        res.status(400).json({
          error: `Gate pass not active for status: ${leave.status}. Must be APPROVED or DEPARTED.`,
        });
        return;
      }

      res.json({
        passId: leave.id,
        gatePassCode: leave.gatePassCode,
        gatePassQr: leave.gatePassQr,
        status: leave.status,
        type: leave.type,
        destination: leave.destination,
        studentName: leave.student.name,
        studentRoom: leave.student.roomNumber,
        departureTime: leave.departureTime,
        expectedReturn: leave.expectedReturn,
        actualDeparture: leave.actualDeparture,
      });
    } catch (error) {
      logger.error({ err: error, id }, '[leave] failed to fetch gate pass');
      res.status(500).json({ error: 'Could not fetch gate pass' });
    }
  },
);

// ---------------------------------------------------------------------------
// 7. GET /leaves/:id — Get details of a single leave request
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const id = param(req, 'id');
    const user = req.user!;

    try {
      const leave = await prisma.leaveRequest.findUnique({
        where: { id },
        include: {
          student: { select: studentSelect },
          reviewer: { select: wardenSelect },
        },
      });

      if (!leave) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }

      if (user.role === 'STUDENT' && leave.studentId !== user.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      res.json(leave);
    } catch (error) {
      logger.error({ err: error, id }, '[leave] failed to fetch leave detail');
      res.status(500).json({ error: 'Could not fetch leave request' });
    }
  },
);

// ---------------------------------------------------------------------------
// 8. DELETE /leaves/:id — Student cancels a submitted leave request
//    PATCH  /leaves/:id/cancel — same action, verb-style alias
// ---------------------------------------------------------------------------
async function cancelOwnLeave(req: Request, res: Response): Promise<void> {
  const studentId = req.user!.id;
  const id = param(req, 'id');

  try {
    const leave = await prisma.leaveRequest.findUnique({
      where: { id },
    });

    if (!leave) {
      res.status(404).json({ error: 'Leave request not found' });
      return;
    }

    if (leave.studentId !== studentId) {
      res.status(403).json({ error: 'Forbidden: not your leave request' });
      return;
    }

    if (leave.status !== 'SUBMITTED') {
      res.status(409).json({
        error: `Cannot cancel leave in ${leave.status} status. Only SUBMITTED leaves can be cancelled.`,
      });
      return;
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    try {
      const io = getIO();
      io.to('wardens').emit('leave:cancelled', { id, studentId });
      // The student's own other devices (e.g. a tablet left on the status
      // screen) should drop the request from "pending" too.
      io.to(`student:${studentId}`).emit('leave:cancelled', updated);
    } catch (ioErr) {
      logger.warn({ err: ioErr }, '[socket] could not emit leave:cancelled');
    }

    logger.info({ leaveId: id, studentId }, '[leave] request cancelled by student');
    res.json(updated);
  } catch (error) {
    logger.error({ err: error, id }, '[leave] failed to cancel leave request');
    res.status(500).json({ error: 'Could not cancel leave request' });
  }
}

router.delete('/:id', authenticate, requireRole('STUDENT'), cancelOwnLeave);
router.patch('/:id/cancel', authenticate, requireRole('STUDENT'), cancelOwnLeave);

// ---------------------------------------------------------------------------
// 9. PATCH /leaves/:id/review — Warden approves or rejects a request
//    PATCH /leaves/:id/approve — alias for status=APPROVED
//    PATCH /leaves/:id/reject  — alias for status=REJECTED
// ---------------------------------------------------------------------------
type ReviewDecision = 'APPROVED' | 'REJECTED';

/**
 * The response body accepts `decisionNote` (the API contract used by the
 * leave-approval spec) as well as `reviewRemarks` (the field the dashboard
 * and Flutter app have always sent). Same column, two spellings.
 */
async function applyReview(
  req: Request,
  res: Response,
  decision: ReviewDecision,
): Promise<void> {
  const wardenId = req.user!.id;
  const id = param(req, 'id');
  const body = req.body ?? {};
  const rawNote = body.decisionNote ?? body.reviewRemarks;
  const note = rawNote === undefined || rawNote === null ? null : String(rawNote).trim();

  if (note !== null && note.length > 500) {
    res.status(400).json({ error: 'decision note must be 500 characters or fewer' });
    return;
  }

  try {
    const current = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!current) {
      res.status(404).json({ error: 'Leave request not found' });
      return;
    }

    if (current.status !== 'SUBMITTED') {
      res.status(409).json({
        error: `Invalid transition from ${current.status} to ${decision}. Only SUBMITTED requests can be reviewed.`,
      });
      return;
    }

    let gatePassCode: string | undefined = undefined;
    let gatePassQr: string | undefined = undefined;

    if (decision === 'APPROVED') {
      // Generate a 6-char hex unique gate pass code
      gatePassCode = `HG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      gatePassQr = JSON.stringify({
        passId: id,
        code: gatePassCode,
        studentId: current.studentId,
        type: current.type,
        exp: current.expectedReturn.toISOString(),
      });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: decision,
        reviewedBy: wardenId,
        reviewedAt: new Date(),
        reviewRemarks: note && note.length > 0 ? note : null,
        ...(gatePassCode ? { gatePassCode, gatePassQr } : {}),
      },
      include: {
        student: { select: studentSelect },
        reviewer: { select: wardenSelect },
      },
    });

    leaveRequestsTotal.inc({ type: current.type, status: decision });

    try {
      const io = getIO();
      io.to(`student:${current.studentId}`).emit('leave:updated', updated);
      io.to('wardens').emit('leave:updated', updated);
    } catch (ioErr) {
      logger.warn({ err: ioErr }, '[socket] could not emit leave:updated');
    }

    logger.info({ leaveId: id, status: decision, wardenId }, '[leave] reviewed by warden');
    res.json(updated);
  } catch (error) {
    logger.error({ err: error, id }, '[leave] failed to review leave');
    res.status(500).json({ error: 'Could not process leave review' });
  }
}

router.patch(
  '/:id/review',
  authenticate,
  requireRole('WARDEN'),
  async (req: Request, res: Response): Promise<void> => {
    const { status } = req.body ?? {};
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      res.status(400).json({ error: "Status must be 'APPROVED' or 'REJECTED'" });
      return;
    }
    await applyReview(req, res, status as ReviewDecision);
  },
);

router.patch(
  '/:id/approve',
  authenticate,
  requireRole('WARDEN'),
  async (req: Request, res: Response): Promise<void> => {
    await applyReview(req, res, 'APPROVED');
  },
);

router.patch(
  '/:id/reject',
  authenticate,
  requireRole('WARDEN'),
  async (req: Request, res: Response): Promise<void> => {
    await applyReview(req, res, 'REJECTED');
  },
);

// ---------------------------------------------------------------------------
// 10. POST /leaves/:id/gate-departure — Record gate exit
// ---------------------------------------------------------------------------
router.post(
  '/:id/gate-departure',
  authenticate,
  requireRole('WARDEN'),
  async (req: Request, res: Response): Promise<void> => {
    const wardenId = req.user!.id;
    const id = param(req, 'id');
    const { gatePassCode } = req.body ?? {};

    try {
      const leave = await prisma.leaveRequest.findUnique({ where: { id } });
      if (!leave) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }

      if (leave.status !== 'APPROVED') {
        res.status(409).json({
          error: `Cannot record gate departure for leave in ${leave.status} status. Must be APPROVED.`,
        });
        return;
      }

      if (gatePassCode && leave.gatePassCode && leave.gatePassCode !== String(gatePassCode).trim().toUpperCase()) {
        res.status(400).json({ error: 'Invalid gate pass code' });
        return;
      }

      const updated = await prisma.leaveRequest.update({
        where: { id },
        data: {
          status: 'DEPARTED',
          actualDeparture: new Date(),
          departedGateBy: wardenId,
        },
        include: {
          student: { select: studentSelect },
        },
      });

      leaveCurrentlyAway.inc();

      try {
        const io = getIO();
        io.to('wardens').emit('leave:departed', updated);
        io.to(`student:${leave.studentId}`).emit('leave:departed', updated);
      } catch (ioErr) {
        logger.warn({ err: ioErr }, '[socket] could not emit leave:departed');
      }

      logger.info({ leaveId: id, wardenId }, '[leave] gate departure recorded');
      res.json(updated);
    } catch (error) {
      logger.error({ err: error, id }, '[leave] failed to record gate departure');
      res.status(500).json({ error: 'Could not record gate departure' });
    }
  },
);

// ---------------------------------------------------------------------------
// 11. POST /leaves/:id/gate-return — Record gate re-entry
// ---------------------------------------------------------------------------
router.post(
  '/:id/gate-return',
  authenticate,
  requireRole('WARDEN'),
  async (req: Request, res: Response): Promise<void> => {
    const wardenId = req.user!.id;
    const id = param(req, 'id');

    try {
      const leave = await prisma.leaveRequest.findUnique({ where: { id } });
      if (!leave) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }

      if (leave.status !== 'DEPARTED' && leave.status !== 'OVERDUE') {
        res.status(409).json({
          error: `Cannot record gate return for leave in ${leave.status} status. Must be DEPARTED or OVERDUE.`,
        });
        return;
      }

      const updated = await prisma.leaveRequest.update({
        where: { id },
        data: {
          status: 'RETURNED',
          actualReturn: new Date(),
          returnedGateBy: wardenId,
        },
        include: {
          student: { select: studentSelect },
        },
      });

      leaveCurrentlyAway.dec();

      try {
        const io = getIO();
        io.to('wardens').emit('leave:returned', updated);
        io.to(`student:${leave.studentId}`).emit('leave:returned', updated);
      } catch (ioErr) {
        logger.warn({ err: ioErr }, '[socket] could not emit leave:returned');
      }

      logger.info({ leaveId: id, wardenId }, '[leave] gate return recorded');
      res.json(updated);
    } catch (error) {
      logger.error({ err: error, id }, '[leave] failed to record gate return');
      res.status(500).json({ error: 'Could not record gate return' });
    }
  },
);

// ---------------------------------------------------------------------------
// 12. POST /leaves/:id/emergency — Student SOS while on off-campus leave
// ---------------------------------------------------------------------------
router.post(
  '/:id/emergency',
  authenticate,
  requireRole('STUDENT'),
  async (req: Request, res: Response): Promise<void> => {
    const studentId = req.user!.id;
    const id = param(req, 'id');
    const { latitude, longitude, locationAccuracy } = req.body ?? {};

    try {
      const leave = await prisma.leaveRequest.findUnique({
        where: { id },
        include: {
          student: {
            select: {
              ...studentSelect,
              // One extra hop so the off-campus alert lands in the tenant,
              // like every alert created through POST /alerts will.
              block: {
                select: { campus: { select: { organizationId: true } } },
              },
            },
          },
        },
      });

      if (!leave) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }

      if (leave.studentId !== studentId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // Create an EmergencyAlert marked with off-campus context
      const alert = await prisma.emergencyAlert.create({
        data: {
          studentId,
          organizationId: leave.student.block?.campus.organizationId ?? null,
          type: `OFF_CAMPUS_LEAVE:${leave.type}`,
          latitude: typeof latitude === 'number' ? latitude : null,
          longitude: typeof longitude === 'number' ? longitude : null,
          locationAccuracy: typeof locationAccuracy === 'number' ? locationAccuracy : null,
          status: 'PENDING',
        },
        include: {
          student: { select: studentSelect },
        },
      });

      alertsCreatedTotal.inc({ type: `OFF_CAMPUS_LEAVE:${leave.type}` });

      // SAME CONTRACT AS POST /alerts. The dashboard socket hook listens for
      // `alert:new`; this route used to emit `alert:created`, which nothing
      // subscribed to — an off-campus SOS was saved but never appeared on the
      // warden board. For a safety feature that is the worst possible bug.
      try {
        const io = getIO();
        io.to('wardens').emit('alert:new', {
          ...alert,
          offCampusLeave: {
            leaveId: leave.id,
            destination: leave.destination,
            reason: leave.reason,
            emergencyContact: leave.emergencyContact,
            expectedReturn: leave.expectedReturn,
          },
        });
      } catch (ioErr) {
        logger.warn({ err: ioErr }, '[socket] could not emit alert:new for leave SOS');
      }

      // Push and the 60s escalation are additive and fire-and-forget, exactly
      // as in POST /alerts: Redis being down must not fail the SOS.
      sendAlertPush(alert);

      enqueueEscalation(alert.id).catch((error) => {
        logger.error(
          { alertId: alert.id, err: error instanceof Error ? error.message : error },
          `[leave] could not schedule escalation for off-campus alert ${alert.id} (Redis down?)`,
        );
      });

      logger.warn(
        { alertId: alert.id, leaveId: id, studentId },
        '[leave] OFF-CAMPUS EMERGENCY SOS TRIGGERED',
      );

      res.status(201).json({ alert, leave });
    } catch (error) {
      logger.error({ err: error, id }, '[leave] failed to trigger leave emergency SOS');
      res.status(500).json({ error: 'Could not trigger leave emergency SOS' });
    }
  },
);

// ---------------------------------------------------------------------------
// 13. GET /leaves — Warden lists all leave requests (with filters & pagination)
// ---------------------------------------------------------------------------
router.get(
  '/',
  authenticate,
  requireRole('WARDEN'),
  async (req: Request, res: Response): Promise<void> => {
    const {
      page = '1',
      limit = '20',
      status,
      type,
      studentName,
      from,
      to,
    } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Filters are by departure window: "who was scheduled out on these dates".
    const fromDate = typeof from === 'string' && from.trim() ? new Date(from) : null;
    const toDate = typeof to === 'string' && to.trim() ? new Date(to) : null;

    if ((fromDate && isNaN(fromDate.getTime())) || (toDate && isNaN(toDate.getTime()))) {
      res.status(400).json({ error: 'from and to must be valid ISO dates' });
      return;
    }

    try {
      const where: Record<string, unknown> = {};

      if (typeof status === 'string' && status.trim().length > 0) {
        where.status = status.trim().toUpperCase();
      }

      if (typeof type === 'string' && type.trim().length > 0) {
        where.type = type.trim().toUpperCase();
      }

      if (typeof studentName === 'string' && studentName.trim().length > 0) {
        where.student = {
          name: { contains: studentName.trim(), mode: 'insensitive' },
        };
      }

      if (fromDate || toDate) {
        where.departureTime = {
          ...(fromDate ? { gte: fromDate } : {}),
          ...(toDate ? { lte: toDate } : {}),
        };
      }

      const [data, total] = await Promise.all([
        prisma.leaveRequest.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { createdAt: 'desc' },
          include: {
            student: { select: studentSelect },
            reviewer: { select: wardenSelect },
          },
        }),
        prisma.leaveRequest.count({ where }),
      ]);

      res.json({
        data,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      logger.error({ err: error }, '[leave] failed to fetch leave list');
      res.status(500).json({ error: 'Could not fetch leave requests' });
    }
  },
);

export default router;
