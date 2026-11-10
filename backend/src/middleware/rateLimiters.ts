import type { Redis } from 'ioredis';
import type { Socket } from 'socket.io';
import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator, Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { logger } from '../config/logger';
import { sosOverridesTotal } from '../config/metrics';
import { createFailFastConnection } from '../config/redis';

/**
 * Redis-backed rate limiting — REQUIRED, not optional polish.
 *
 * WHY REDIS: express-rate-limit's default store is a per-process Map. With 3
 * API instances behind nginx the SAME client hits 3 independent Maps, i.e.
 * the attacker gets exactly 3x the intended rate (3 SOS/minute per student
 * instead of 5; 30 logins/15min per IP instead of 10). RedisStore makes the
 * counters live in the shared Redis, so the limit is global and identical
 * regardless of which instance answers.
 *
 * RATE_LIMIT_ENABLED flag: all limiters below evaluate `skip()` PER REQUEST
 * (not at module load), so:
 *   - testEnv.ts sets RATE_LIMIT_ENABLED=0 -> every suite (sockets lifecycle,
 *     multi-instance fan-out...) runs untouched;
 *   - tests/hardening.test.ts sets RATE_LIMIT_ENABLED=1 in the SAME process
 *     and exercises the real limits — no second app assembly, no second
 *     module graph needed.
 *
 * Redis connection budget: this module owns ONE more client per API
 * instance (connection #5 — see src/config/redis.ts). It is a plain
 * command-mode client created via createAdapterConnection(); it is NOT the
 * BullMQ connection and NOT an adapter pub/sub client (the store just runs
 * INCR/PEXPIRE under the hood). closeRateLimiter() releases it.
 *
 * Framing decision (E6, deliberate): ALL limiters fail OPEN when Redis is
 * unreachable. This is an emergency system — a rate limiter must never be
 * the reason an SOS is not delivered. rate-limit-redis throws on a failed
 * command, so every limiter sets `passOnStoreError: true` and the store's
 * sendCommand is bounded (fail-fast client + 50ms race) so the error
 * surfaces instead of hanging in ioredis' offline queue.
 *
 * We log `rate_limiter_redis_error` on each failed store hit; the Grafana
 * HighSOSRate rule still covers the abuse case, and a disabled limiter is
 * far cheaper than a dropped emergency.
 */

/** Master switch. Refuses only the literal '0' (production default = ON). */
export function isRateLimitingEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED !== '0';
}

let limiterRedis: Redis | null = null;

/**
 * Hard ceiling on one limiter Redis command. Local Redis answers in <1ms, so
 * this only fires when the connection degrades mid-command; it guarantees the
 * two limiter hops (global + sos) cannot add more than ~100ms to an SOS.
 */
const LIMITER_COMMAND_TIMEOUT_MS = 50;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}_timeout_${LIMITER_COMMAND_TIMEOUT_MS}ms`)),
      LIMITER_COMMAND_TIMEOUT_MS,
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

function rateLimitStore(prefix: string): RedisStore {
  if (!limiterRedis) {
    // Lazy: created on first limiter construction, shared by all limiters.
    // Fail-fast client: an outage rejects instead of queueing (E6).
    limiterRedis = createFailFastConnection();
  }
  const client = limiterRedis;
  return new RedisStore({
    // rate-limit-redis raw API: forward the limiter's INCR/PEXPIRE commands.
    // The store calls this once per hit; on failure we emit a structured
    // warning and rethrow so `passOnStoreError` lets the request through.
    sendCommand: async (...args: string[]) => {
      try {
        return (await withTimeout(
          client.call(...(args as [string, ...string[]])) as unknown as Promise<RedisReply>,
          prefix,
        )) as RedisReply;
      } catch (error) {
        logger.warn(
          {
            limiter: prefix,
            err: error instanceof Error ? error.message : error,
          },
          'rate_limiter_redis_error',
        );
        throw error;
      }
    },
    // Per-limiter key namespace (see the budget-independence note in
    // baseOptions): auth/IP and global/IP would otherwise share one counter.
    prefix,
  });
}

/**
 * Uniform 429 body: Retry-After header (seconds) + the number the Flutter
 * client uses to render "warden has been notified" instead of an error.
 */
function respondTooManyRequests(res: Response, windowMs: number): void {
  const retryAfter = Math.ceil(windowMs / 1000);
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({ error: 'rate_limited', retryAfter });
}

/**
 * Shared config. express-rate-limit v8: `limit` is the modern name of
 * `max`; standardHeaders emits RateLimit-* + attempts-window info.
 *
 * `prefix` (passed to RedisStore, NOT a limiter option) MUST be unique per
 * limiter: all three share ONE Redis client, and without distinct prefixes
 * the auth limiter (keyed by IP) and the global limiter (keyed by IP) would
 * count into the same Redis key — a login burst would surface as a
 * "global" 429 and vice versa, and ERR_ERL_DOUBLE_COUNT fires.
 */
function baseOptions(windowMs: number, limit: number, prefix: string): Partial<Options> {
  return {
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: rateLimitStore(prefix),
    skip: () => !isRateLimitingEnabled(),
    // E6: a Redis outage must never block a request. The store throws
    // because `createFailFastConnection()` + the 50ms race prevent the
    // command from pending; this option turns that throw into "allow".
    passOnStoreError: true,
    // The store's init() runs at module load and races the initial socket
    // connect; with a fail-fast client that first SCRIPT LOAD rejects by
    // design (rate-limit-redis self-heals via its NOSCRIPT retry). sendCommand
    // already logs one structured `rate_limiter_redis_error` per failed hit,
    // so silence the library's duplicate multi-line stack trace.
    logger: {
      error: () => undefined,
      warn: () => undefined,
    },
  };
}

/**
 * SOS limiter — 5 requests / 60s per STUDENT.
 *
 * Mounted AFTER authenticate+requireRole('STUDENT') on POST /alerts (see
 * src/routes/alert.routes.ts) so keyGenerator can use the verified student
 * id — an IP key would lump every student behind the same Wi-Fi NAT into
 * one bucket, which is exactly what happens in a hostel.
 *
 * THE BREAK-GLASS OVERRIDE — NON-NEGOTIABLE.
 *
 *   A stuck SOS button must not block a real medical emergency.
 *
 * When the same student exceeds 5 SOS / 60s, this limiter does NOT send
 * 429. It ALLOWS the request through (next()) and instead:
 *   1. logs a structured warn (`sos_rate_limit_overridden`, { studentId })
 *      — visible in pm2 logs, greppable during the demo drill;
 *   2. increments sos_overrides_total — visible in Grafana/Prometheus.
 *
 * Trade-off, written down so nobody "fixes" it later: we prefer OVER-ALERT
 * (warden gets a 7th push, mildly annoying) over silently dropping a real
 * SOS (the alert never existed, warden never knows — catalogue disaster).
 * Abuse cost is bounded by alerts_created_total still being counted, and
 * HighSOSRate in monitoring/rules/hostel.yml fires on the surge anyway.
 *
 * The TEST decision: hardening.test.ts asserts the 6th request returns 201
 * (allowed through) and sos_overrides_total === 1 — the break-glass path is
 * the configured behaviour, not a 429.
 */
export const sosLimiter = rateLimit({
  ...baseOptions(60_000, 5, 'rl:sos'),
  // Unauthenticated fall-back MUST go through ipKeyGenerator (v8 IPv6
  // subnetting): a raw req.ip fallback fails ERR_ERL_KEY_GEN_IPV6 because
  // IPv6 hosts could otherwise take one bucket per address of the /64.
  keyGenerator: (req) =>
    req.user?.id ?? ipKeyGenerator(req.ip ?? '127.0.0.1'),
  handler: (req, _res, next) => {
    const studentId = req.user?.id ?? 'unknown';
    logger.warn({ studentId, path: req.path }, 'sos_rate_limit_overridden');
    sosOverridesTotal.inc();
    next();
  },
});

/**
 * Auth limiter — 10 attempts / 15min / IP on POST /auth/login.
 * Anti credential-stuffing floor for a system whose accounts are warden
 * accounts. Keyed by IP (pre-auth — there is nothing else to key on).
 */
export const authLimiter = rateLimit({
  ...baseOptions(15 * 60 * 1000, 10, 'rl:auth'),
  // req.ip via app.set('trust proxy', 1) — see src/app.ts.
  handler: (_req, res) => respondTooManyRequests(res, 15 * 60 * 1000),
});

/**
 * Global safety net — 100 requests / 60s / IP over the whole API.
 * /health and /metrics are exempt: load-balancer probes come from a
 * different IP, and Prometheus scrapes /metrics every 15s from the
 * monitoring container, to counts must not count against any client IP
 * budget (a scrape surge could otherwise starve real students).
 */
export const globalLimiter = rateLimit({
  ...baseOptions(60_000, 100, 'rl:global'),
  skip: (req) =>
    !isRateLimitingEnabled() ||
    req.path === '/health' ||
    req.path === '/health/ready' ||
    req.path === '/metrics',
  handler: (_req, res) => respondTooManyRequests(res, 60_000),
});

/**
 * Socket.IO handshake limiter — >10 sockets / minute / IP -> rejected
 * before the connect middleware chain continues ("too many connections").
 *
 * In-memory (Map), NOT Redis, on purpose: handshakes are per-instance
 * events (each instance sees only its own TCP accepts) and nginx does
 * connection-level balancing already; a Redis round-trip in the handshake
 * hot path buys nothing here. 10/min/IP is ~2x any legitimate dashboard
 * (1 socket) + Flutter app (1 socket) budget per warden.
 *
 * Gate by the same RATE_LIMIT_ENABLED flag so test suites that open many
 * sockets rapidly (sockets.test.ts lifecycle) run untouched.
 */
export function createSocketHandshakeLimiter(
  max = 10,
  windowMs = 60_000,
): (socket: Socket, next: (err?: Error) => void) => void {
  const hits = new Map<string, number[]>();

  return (socket, next) => {
    if (!isRateLimitingEnabled()) {
      next();
      return;
    }

    const now = Date.now();

    // Cheap opportunistic GC of stale windows (no timers to leak).
    for (const [key, stamps] of hits) {
      const alive = stamps.filter((ts) => now - ts < windowMs);
      if (alive.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, alive);
      }
    }

    const xff = socket.handshake.headers['x-forwarded-for'];
    const ip =
      (typeof xff === 'string' ? xff.split(',')[0]?.trim() : socket.handshake.address) ||
      'unknown';

    const stamps = hits.get(ip) ?? [];
    if (stamps.length >= max) {
      logger.warn({ ip, count: stamps.length }, 'socket_handshake_rate_limited');
      next(new Error('too many connections'));
      return;
    }

    stamps.push(now);
    hits.set(ip, stamps);
    next();
  };
}

/**
 * Release the limiter's Redis client (index.ts shutdown + tests).
 * Must never throw during shutdown.
 */
export async function closeRateLimiter(): Promise<void> {
  if (limiterRedis) {
    const client = limiterRedis;
    limiterRedis = null;
    await client.quit().catch(() => undefined);
  }
}
