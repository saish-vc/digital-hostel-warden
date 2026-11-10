import crypto from 'node:crypto';
import { Router } from 'express';
import { logger } from '../config/logger';
import { getIO } from '../sockets';

/**
 * POST /internal/escalation-result — the worker's door into the socket layer.
 *
 * WHY THIS EXISTS: the "SMS sent" pill used to be a client-side 60s timer, so
 * it claimed delivery even when the worker had failed. The truth lives in the
 * worker, but the worker is a separate process that must not import the API's
 * Socket.IO server, and @socket.io/redis-adapter 8.3.0 ships no Emitter. So the
 * worker POSTs the outcome here and the API fans it out through the adapter it
 * already owns — no extra Redis connection, no adapter topology change.
 *
 * Guarded by METRICS_TOKEN via x-internal-token, compared timing-safe on
 * SHA-256 digests (same scheme as /loadtest/cleanup). Never reachable with a
 * student or warden JWT.
 */
const router = Router();

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

router.post('/escalation-result', (req, res) => {
  if (!tokenMatches(req.header('x-internal-token'), process.env.METRICS_TOKEN)) {
    logger.warn({ ip: req.ip }, 'internal_escalation_result_denied');
    res.status(401).json({ error: 'invalid or missing x-internal-token' });
    return;
  }

  const { alertId, studentId, outcome, at } = req.body ?? {};

  if (
    typeof alertId !== 'string' ||
    alertId === '' ||
    typeof studentId !== 'string' ||
    studentId === '' ||
    (outcome !== 'sent' && outcome !== 'failed')
  ) {
    res.status(400).json({
      error: 'alertId, studentId and outcome ("sent" | "failed") are required',
    });
    return;
  }

  const sentAt =
    typeof at === 'string' && !Number.isNaN(new Date(at).getTime())
      ? at
      : new Date().toISOString();

  const event = outcome === 'sent' ? 'alert:escalated' : 'alert:escalation-failed';
  const payload = { alertId, sentAt, outcome };

  const io = getIO();
  io.to('wardens').emit(event, payload);
  io.to(`student:${studentId}`).emit(event, payload);

  logger.info({ alertId, outcome }, '[escalation] result broadcast');
  res.json({ ok: true, event });
});

export default router;