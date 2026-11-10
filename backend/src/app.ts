import http from 'http';
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { Server, type Socket } from 'socket.io';
import { verifyToken, type JwtPayload } from './config/jwt';
import { logger } from './config/logger';
import {
  httpRequestsTotal,
  httpRequestDuration,
  register,
  socketIoConnected,
  socketIoConnectionsTotal,
} from './config/metrics';
import { requestId } from './middleware/requestId';
import { httpsRedirect } from './middleware/httpsRedirect';
import {
  createSocketHandshakeLimiter,
  globalLimiter,
} from './middleware/rateLimiters';
import { setIO } from './sockets';
import authRoutes from './routes/auth.routes';
import alertRoutes from './routes/alert.routes';
import wardenRoutes from './routes/warden.routes';
import healthRoutes from './routes/health.routes';
import loadtestRoutes from './routes/loadtest.routes';
import internalRoutes from './routes/internal.routes';

export interface AppBundle {
  app: express.Express;
  httpServer: http.Server;
  io: Server;
}

/**
 * Assembles the HTTP + Socket.IO application WITHOUT listening.
 *
 * `src/index.ts` attaches the Redis adapter + queue-metric loop and then
 * binds this to PORT. Tests bind it to port 0 and deliberately keep the
 * in-memory adapter, which is why the adapter is wired in index.ts rather
 * than here.
 *
 * MIDDLEWARE ORDER MATTERS — margin notes on each:
 *   1. requestId()        — first, so EVERY later layer (pino, limiters,
 *                           error handler) shares one request id.
 *   2. httpsRedirect      — prod-only no-op in dev/tests.
 *   3. helmet             — security headers; CSP off (dashboard origin).
 *   4. cors (locked)      — before any route can answer.
 *   5. express.json 10kb  — before routes; its 413 lands in the error
 *                           handler below.
 *   6. pino-http          — after requestId (same X-Request-Id on every
 *                           log line), before routes (auth middleware can
 *                           then bind userId via setBindings).
 *   7. globalLimiter      — skips /health and /metrics; mounted BEFORE the
 *   8. GET /metrics         routers so even 404s are counted + limited.
 *     (mount order: /health first is also fine — globalLimiter skips the
 *     path either way. The skip is by req.path, NOT mount order: the load
 *     balancer probe must never hit a limiter bucket.)
 */
export function createApp(): AppBundle {
  const app = express();
  const httpServer = http.createServer(app);
  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  // nginx terminates TLS and proxies on the same host — trust its
  // X-Forwarded-For/Proto. express-rate-limit v8 validates this setting
  // (rejects `true`, allows numeric hops).
  app.set('trust proxy', 1);

  // -- 1. Request id --------------------------------------------------------
  app.use(requestId());

  // -- 2. HTTPS enforcement (ENABLE_HTTPS_REDIRECT switch) -------------------
  // Behind nginx (TLS terminates there) plain-HTTP hops to Express arrive
  // with X-Forwarded-Proto: http. A 308 redirect preserves the method+body.
  // Resolution: env true/false wins, otherwise production-only. /health and
  // /metrics are exempt (LB probes + Prometheus scrape over plain HTTP).
  app.use(httpsRedirect());

  // -- 3. Helmet -------------------------------------------------------------
  // contentSecurityPolicy: false — the warden dashboard is a SEPARATE origin
  // (Vite dev at :5173, or the static host in prod). A strict CSP on the API
  // breaks cross-origin dashboard socket + REST calls in dev.
  // PRODUCTION NOTE: enable a real CSP once the dashboard is served from the
  // same origin (or via nginx), e.g.
  //   contentSecurityPolicy: {
  //     directives: {
  //       defaultSrc: ["'self'"],
  //       scriptSrc: ["'self'"],
  //       styleSrc: ["'self'", "'unsafe-inline'"],   // Tailwind inline styles
  //       connectSrc: ["'self'", 'wss://<your-host>'], // Socket.IO
  //       imgSrc: ["'self'", 'data:'],
  //     },
  //   }
  app.use(helmet({ contentSecurityPolicy: false }));

  // -- 4. Locked CORS --------------------------------------------------------
  // CORS_ORIGIN accepts a comma-separated allowlist. Every non-listed web
  // origin is REJECTED with a logged, visible reason (cors_origin_rejected
  // in the logs) — callback(null, false) omits the Access-Control-Allow-*
  // headers and the browser's console shows the refusal, which IS the
  // clear error. Requests with NO Origin header (curl, load balancer
  // probes, native Flutter HTTP) pass: Origin is only present on browsers.
  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
          callback(null, true);
          return;
        }
        logger.warn({ origin }, 'cors_origin_rejected');
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    }),
  );

  // -- 5. Body size limit ----------------------------------------------------
  // SOS payloads are < 500 bytes. Anything approaching 10kb is either a bug
  // or an attack; express.json throws entity.too.large -> 413 below.
  app.use(express.json({ limit: '10kb' }));

  // -- 6. pino-http: EVERY request logged, with request-id + user context ----
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => {
        // Prefer the X-Request-Id set by the requestId middleware (always
        // present — it runs first); fall back to a fresh UUID.
        const rid = req.headers['x-request-id'];
        return typeof rid === 'string' && rid.trim().length > 0
          ? rid.trim()
          : crypto.randomUUID();
      },
      customProps: (req) => ({
        userId: (req as Request & { user?: JwtPayload }).user?.id ?? null,
        role: (req as Request & { user?: JwtPayload }).user?.role ?? null,
      }),
      // One log line per request, but NOT for the health/metrics endpoints:
      // 3 evaluations/min/instance plus Prometheus scraping every 15s would
      // bury real events (and in prod metric scrapes are pure noise).
      autoLogging: {
        ignore: (req) => {
          const url = req.url ?? '';
          return (
            url === '/health' ||
            url.startsWith('/health?') ||
            url === '/health/ready' ||
            url.startsWith('/health/ready?') ||
            url === '/metrics' ||
            url.startsWith('/metrics?')
          );
        },
      },
    }),
  );

  // -- 7. HTTP metrics --------------------------------------------------------
  const routeLabel = (req: Request): string => {
    // Route TEMPLATE (never the raw URL): an alert id must not become a
    // Prometheus label or cardinality explodes the registry.
    if (req.route) {
      const base = req.baseUrl ?? '';
      const path = typeof req.route.path === 'string' ? req.route.path : '';
      const label = `${base}${path}`;
      return label.length > 1 ? label.replace(/\/+$/, '') : label;
    }
    if (req.baseUrl) {
      return req.baseUrl;
    }
    return 'unmatched';
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    // startTimer() accepts final labels later — the only way to include the
    // resolved route + status in the histogram's labels.
    const endTimer = httpRequestDuration.startTimer();
    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status_code: String(res.statusCode),
      };
      endTimer(labels);
      httpRequestsTotal.inc(labels);
    });
    next();
  });

  // -- 8. Global limiter (skips /health + /metrics) ---------------------------
  app.use(globalLimiter);

  // -- 9. GET /metrics — Prometheus scraper -----------------------------------
  // Protected by METRICS_TOKEN (?token=..., including in tests). NOT bound
  // to 127.0.0.1: Prometheus runs in a docker-compose container and would
  // scrape http://host.docker.internal:300x — a localhost bind is
  // unreachable from there. The token is the protection; it is compared
  // timing-safe.
  const isMetricsAuthorized = (req: Request): boolean => {
    const expected = process.env.METRICS_TOKEN;
    const provided = req.query.token;
    if (!expected || typeof provided !== 'string' || provided.length === 0) {
      return false;
    }
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    return crypto.timingSafeEqual(expectedHash, providedHash);
  };

  app.get('/metrics', async (req, res) => {
    if (!isMetricsAuthorized(req)) {
      logger.warn({ ip: req.ip }, 'metrics_access_denied');
      res
        .status(401)
        .json({ error: 'METRICS_TOKEN missing or invalid (?token=...)' });
      return;
    }
    logger.info({ ip: req.ip }, 'metrics_scraped');
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  // -- 10. Unauthenticated health + routers -----------------------------------
  app.use(healthRoutes);

  app.use('/auth', authRoutes);
  app.use('/alerts', alertRoutes);
  app.use('/wardens', wardenRoutes);
  // Narrow, secret-guarded cleanup door for load-test/sos.js (see the file).
  app.use('/loadtest', loadtestRoutes);
  // Worker -> socket layer relay (see the file for why the worker cannot emit).
  app.use('/internal', internalRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler: body-parser errors (413/400) keep their status; only
  // UNEXPECTED failures become 500.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const err = error as
      | { statusCode?: number; type?: string; length?: number; message?: string }
      | undefined;

    if (err?.type === 'entity.too.large') {
      logger.warn({ bytes: err.length }, 'request_body_too_large');
      res.status(413).json({ error: 'Request body exceeds the 10kb limit' });
      return;
    }
    if (
      typeof err?.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      // body-parser malformed-JSON and friends keep client-error shapes.
      res
        .status(err.statusCode)
        .json({ error: err?.message ?? 'Malformed request' });
      return;
    }

    logger.error({ err: error }, '[http] unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });

  setIO(io);

  // Handshake rate limit BEFORE auth: floods should never even reach the
  // JWT parser (see createSocketHandshakeLimiter for the design note).
  io.use(createSocketHandshakeLimiter());

  /**
   * Socket.IO handshake authentication.
   * The client must pass the JWT as `auth.token`; anything else is rejected
   * before the connection is established.
   */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('UNAUTHORIZED'));
      return;
    }

    try {
      socket.data.user = verifyToken(token);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as { id: string; role: 'STUDENT' | 'WARDEN' };

    if (user.role === 'WARDEN') {
      socket.join('wardens');
    } else {
      socket.join(`student:${user.id}`);
    }

    socket.emit('connected', {
      id: user.id,
      role: user.role,
      socketId: socket.id,
    });

    // Connection metrics — Grafana's "Connected wardens" panel + the
    // NoWardensConnected alert both read socket_io_connected.
    socketIoConnectionsTotal.inc({ role: user.role });
    socketIoConnected.inc();

    logger.info(
      {
        socketId: socket.id,
        userId: user.id,
        role: user.role,
      },
      '[socket] connected',
    );

    socket.on('disconnect', (reason) => {
      socketIoConnected.dec();
      logger.info(
        {
          socketId: socket.id,
          userId: user.id,
          role: user.role,
          reason,
        },
        '[socket] disconnected',
      );
    });
  });

  return { app, httpServer, io };
}
