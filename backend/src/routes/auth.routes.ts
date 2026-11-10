import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma';
import { Role, signToken, type JwtPayload } from '../config/jwt';
import { authLimiter } from '../middleware/rateLimiters';
import { bindUser } from '../middleware/logContext';

const router = Router();

/**
 * A REAL cost-12 bcrypt hash of a throwaway string.
 *
 * Used only to spend the same work on a nonexistent email as on a wrong
 * password. Without it, `findUnique` returning null short-circuits the
 * handler and the 401 arrives measurably faster, which leaks account
 * existence even though status and body are identical. Cost 12 matches
 * prisma/seed.ts and prisma/demo-reset.ts.
 */
const DUMMY_PASSWORD_HASH =
  '$2b$12$4nsfd0hHkidO66O48JHUr.3j8iM4YXYNOBYRts/YXAyi0RjWaEmsq';

/**
 * POST /auth/login
 * authLimiter is the FIRST middleware: 10 attempts / 15min / IP (anti
 * credential-stuffing floor; see src/middleware/rateLimiters.ts). It counts
 * FAILED and successful attempts alike — a burst from one IP must back off.
 */
router.post('/login', authLimiter, async (req, res) => {
  const { email, password, role } = req.body ?? {};

  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    (role !== 'STUDENT' && role !== 'WARDEN')
  ) {
    res.status(400).json({
      error: 'email, password and role (STUDENT or WARDEN) are required',
    });
    return;
  }

  const user =
    role === 'STUDENT'
      ? await prisma.student.findUnique({ where: { email } })
      : await prisma.warden.findUnique({ where: { email } });

  if (!user) {
    // Constant-work failure (see DUMMY_PASSWORD_HASH): equalise timing with
    // the wrong-password path before answering with the same generic 401.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const principal: JwtPayload = { id: user.id, role: role as Role };
  const token = signToken(principal);

  // Every later log line on this request carries who+role
  // (logContext.ts explains why this is not pino-http's customProps).
  bindUser(req, principal.id, principal.role);

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      role,
    },
  });
});

export default router;
