import { Router } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

const MAX_TOKEN_LENGTH = 4096;

/**
 * Warden-only guard shared by both token endpoints.
 */
function requireValidToken(
  body: unknown,
): { token: string; userAgent?: string } | { error: string } {
  const { token, userAgent } = (body ?? {}) as Record<string, unknown>;

  if (typeof token !== 'string' || token.trim().length === 0) {
    return { error: 'token is required' };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { error: 'token is too long' };
  }
  if (userAgent !== undefined && userAgent !== null && typeof userAgent !== 'string') {
    return { error: 'userAgent must be a string' };
  }

  return { token, userAgent: typeof userAgent === 'string' ? userAgent : undefined };
}

/**
 * Register (or refresh) a warden's FCM device token.
 * Browsers can be shared, and FCM returns the same registration token for
 * the same browser profile, so `token` is globally unique: an existing row
 * is updated and **reassigned** to the warden who logged in last. That
 * guarantees one row per browser, not per warden.
 */
router.post('/fcm-token', authenticate, requireRole('WARDEN'), async (req, res) => {
  const parsed = requireValidToken(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const deviceToken = await prisma.deviceToken.upsert({
    where: { token: parsed.token },
    update: {
      wardenId: req.user!.id,
      lastSeenAt: new Date(),
      userAgent: parsed.userAgent,
    },
    create: {
      wardenId: req.user!.id,
      token: parsed.token,
      userAgent: parsed.userAgent,
    },
  });

  res.status(200).json({ ok: true, id: deviceToken.id });
});

/**
 * Delete a device token on logout. Scoped to the calling warden so a warden
 * can only remove their own row — and if the token was reassigned to
 * another warden (shared browser), nothing happens for the caller.
 */
router.delete('/fcm-token', authenticate, requireRole('WARDEN'), async (req, res) => {
  const parsed = requireValidToken(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const result = await prisma.deviceToken.deleteMany({
    where: { token: parsed.token, wardenId: req.user!.id },
  });

  res.status(200).json({ ok: true, deleted: result.count });
});

export default router;
