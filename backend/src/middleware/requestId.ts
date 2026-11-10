import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Request ID correlation — THE debugging primitive for multi-instance.
 *
 * - First middleware in the chain: reads an incoming X-Request-Id (proxies
 *   or tests may inject one), otherwise mints a UUID.
 * - Echoes it on the response header so a CLIENT bug report can carry the
 *   exact id you grep for.
 * - pino-http's genReqId (src/app.ts) picks the id up from the request
 *   header set here, so every log line pino emits — request line, error
 *   line, anything logged with req.log — carries the same value.
 *
 * With three API instances + one worker interleaved in `pm2 logs`, filtering
 * by this id reassembles the whole request across processes and services:
 *   pm2 logs --lines 2000 --nostream | grep <request-id>
 */
export function requestId(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && incoming.trim().length > 0
        ? incoming.trim().slice(0, 64)
        : randomUUID();

    res.setHeader('X-Request-Id', id);
    res.locals.requestId = id;
    next();
  };
}
