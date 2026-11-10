/**
 * Per-instance port resolution.
 *
 * Precedence:
 * 1. PORT — explicit (Railway/Render services, local `PORT=3001 npm run dev`).
 * 2. NODE_APP_INSTANCE — set by PM2 for every cluster worker (0, 1, 2, ...).
 *    Port = 3001 + index, so PM2's 3 cluster workers listen on 3001/3002/3003
 *    and the nginx upstream can address each one individually.
 * 3. 4000 — the historical single-instance dev default (the dashboard and
 *    Flutter app already point here).
 */
export const FIRST_INSTANCE_PORT = 3001;
export const DEFAULT_PORT = 4000;

export function resolvePort(): number {
  const explicitPort = Number(process.env.PORT);
  if (process.env.PORT && Number.isFinite(explicitPort) && explicitPort > 0) {
    return explicitPort;
  }

  if (process.env.NODE_APP_INSTANCE !== undefined) {
    const instanceIndex = Number.parseInt(process.env.NODE_APP_INSTANCE, 10);
    if (Number.isFinite(instanceIndex) && instanceIndex >= 0) {
      return FIRST_INSTANCE_PORT + instanceIndex;
    }
  }

  return DEFAULT_PORT;
}

/** The value reported by GET /health and used to prove load balancing. */
export function instanceId(): string {
  return String(resolvePort());
}
