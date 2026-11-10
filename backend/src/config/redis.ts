import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Redis connection budget — ONE API INSTANCE
 * ------------------------------------------
 * 1. BullMQ Queue ................ src/queues/escalation.queue.ts
 * 2. Socket.IO adapter PUB ....... src/index.ts
 * 3. Socket.IO adapter SUB ....... src/index.ts (pubClient.duplicate())
 * 4. GET /health ping ............ src/routes/health.routes.ts (lazy)
 * 5. Rate-limit store ............ src/middleware/rateLimiters.ts (lazy,
 *                                  shared by sos/auth/global limiters;
 *                                  released via closeRateLimiter())
 *
 * = 4 connections per API instance. Three API instances = 12 Redis
 * connections total. The worker process owns one more BullMQ Worker
 * connection.
 *
 * These MUST NOT be shared:
 * - An ioredis client in subscriber mode can only run subscribe /
 *   unsubscribe / ping / quit. If the adapter SUB client were shared with
 *   BullMQ, the queue's blocking commands would fail.
 * - BullMQ requires `maxRetriesPerRequest: null` on its own blocking
 *   connection; mixing normal command traffic onto it makes retry semantics
 *   unpredictable.
 * - The PUB client is command-mode; still keep it separate so a slow
 *   subscriber never backpressures application commands.
 */

/**
 * BullMQ connection. Requires:
 * - `maxRetriesPerRequest: null` — BullMQ blocks on BRPOPLPUSH-style waiting
 *   commands that must never be killed by a per-command retry budget.
 * - `enableReadyCheck: false` — BullMQ manages readiness itself.
 */
export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Upstash and other TLS endpoints use rediss:// — ioredis picks TLS up
    // from the URL scheme; nothing else to configure.
    // Retry with backoff so transient disconnects (docker restart, network)
    // heal themselves instead of crashing the process.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

/**
 * A FRESH ioredis client for the Socket.IO Redis adapter (PUB or SUB).
 *
 * Never call this from a pool and never reuse a client returned here for
 * anything else. The adapter calls `psubscribe` on the SUB client, which puts
 * ioredis into subscriber mode for the lifetime of the connection.
 *
 * `src/index.ts` creates exactly two of these:
 *   const pubClient = createAdapterConnection();
 *   const subClient = pubClient.duplicate();
 */
export function createAdapterConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

/**
 * Fail-fast connection for callers that MUST NOT queue while Redis is
 * unreachable. Used by the rate limiter (E6): with the default
 * `enableOfflineQueue: true`, an INCR issued during an outage sits in the
 * offline queue forever (because `maxRetriesPerRequest: null` never rejects
 * it), which is exactly how a Redis outage used to hang every SOS request.
 *
 * `enableOfflineQueue: false` makes the command reject immediately with
 * "Stream isn't writeable..." while the socket is down, so
 * express-rate-limit's `passOnStoreError: true` can fail open in microseconds.
 *
 * This is NOT an adapter connection: the Socket.IO pub/sub clients keep the
 * queuing behaviour on purpose (a broadcast emitted during a blip must not
 * throw into the SOS handler), and the connection budget is unchanged.
 */
export function createFailFastConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

export const redisUrl = REDIS_URL;
