import { NextFunction, Request, Response } from 'express';
import { JwtPayload, Role, verifyToken } from '../config/jwt';
import { bindUser } from './logContext';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  try {
    req.user = verifyToken(header.slice('Bearer '.length));
    // Structured logging context for every later line of this request —
    // see logContext.ts for why this is setBindings and not customProps.
    bindUser(req, req.user.id, req.user.role);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden: requires role ${roles.join(' or ')}`,
      });
      return;
    }

    next();
  };
}
