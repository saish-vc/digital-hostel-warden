import { Redis } from 'ioredis';
import { TEST_REDIS_URL } from './testEnv';

/**
 * Flushes the dedicated test Redis database.
 *
 * Runs before every suite (and between escalation tests) so delayed BullMQ
 * jobs from a previous test can never fire into the next one — a leftover
 * 500ms job is exactly how an "SMS must not be sent" test turns flaky.
 *
 * testEnv.ts refuses DB index 0, so this cannot wipe a dev Redis.
 */
export async function flushTestRedis(): Promise<void> {
  const client = new Redis(TEST_REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  try {
    await client.connect();
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}
