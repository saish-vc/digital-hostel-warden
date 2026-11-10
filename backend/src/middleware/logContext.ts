import type { Request } from 'express';
import type { Role } from '../config/jwt';

/**
 * Binds the authenticated principal onto pino-http's per-request child
 * logger (req.log, created by pino-http before routing).
 *
 * Why NOT pino-http customProps: pino-http evaluates customProps ONCE at
 * request start, before authentication runs — there req.user is still
 * undefined, so every customProps-based binding would permanently omit
 * userId on authenticated requests. setBindings() mutates the existing
 * request child logger, so the response-finish log (and anything logged in
 * between) carries userId/role.
 *
 * Called from:
 * - src/middleware/auth.ts   authenticate()  — after verifyToken succeeds
 * - src/routes/auth.routes.ts login handler — after the password matches
 *
 * Defensive `?.`: vitest plugin-less environments and future refactors
 * should never break auth over a logging nicety.
 */
export function bindUser(req: Request, userId: string, role: Role): void {
  interface PinoHttpAugmentedRequest {
    log?: { setBindings: (bindings: Record<string, unknown>) => void } | null;
  }
  (req as Request & PinoHttpAugmentedRequest).log?.setBindings({ userId, role });
}
