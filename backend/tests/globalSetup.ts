import { execSync } from 'node:child_process';
import './helpers/testEnv';

/**
 * Applies pending Prisma migrations to TEST_DATABASE_URL once per `vitest`
 * invocation, so `npm test` is a single command on a laptop and in CI.
 *
 * `prisma migrate deploy` is idempotent and takes ~1s when the schema is
 * already current.
 */
export default function setup(): void {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: process.env,
    timeout: 120_000,
  });
}
