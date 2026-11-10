import type { NextFunction, Request, Response } from 'express';

/**
 * HTTPS enforcement gate.
 *
 * RESOLUTION RULE (exactly as specified):
 *   ENABLE_HTTPS_REDIRECT === "true"  -> enabled
 *   ENABLE_HTTPS_REDIRECT === "false" -> disabled
 *   unset                             -> enabled iff NODE_ENV === "production"
 *
 * WHY THE SWITCH EXISTS: in production behind nginx (TLS terminates there),
 * plain-HTTP hops to Express arrive with X-Forwarded-Proto: http and must be
 * redirected (308 preserves method + body). But two classes of traffic are
 * legitimately plain HTTP INSIDE the VPC and must never be redirected:
 *
 *   /health  — load balancer / nginx upstream health checks. Redirecting a
 *              probe is how every instance gets marked down.
 *   /metrics — Prometheus scrapes over plain HTTP inside the VPC. A 308
 *              makes the scrape fail with "server gave HTTP response to
 *              HTTPS client".
 *
 * The exemption applies ONLY to the redirect decision — /health and /metrics
 * respond exactly as before (including the METRICS_TOKEN 401 gate).
 */
export function httpsRedirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ENABLE_HTTPS_REDIRECT === 'true') {
    return true;
  }
  if (env.ENABLE_HTTPS_REDIRECT === 'false') {
    return false;
  }
  return env.NODE_ENV === 'production';
}

/** Exact paths that skip the redirect even when it is enabled. */
const REDIRECT_EXEMPT_PATHS = new Set(['/health', '/health/ready', '/metrics']);

export function httpsRedirect() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!httpsRedirectEnabled()) {
      next();
      return;
    }

    // req.path excludes the query string, so /metrics?token=... matches.
    if (REDIRECT_EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }

    const forwardedProto =
      (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim() ??
      'http';
    if (forwardedProto !== 'https') {
      const host = (req.headers.host ?? '').toString();
      if (host) {
        res.redirect(308, `https://${host}${req.originalUrl}`);
        return;
      }
    }

    next();
  };
}
