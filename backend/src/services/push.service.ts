import type { Messaging, MulticastMessage } from 'firebase-admin/messaging';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { fcmSentTotal } from '../config/metrics';
import { fcmMessaging } from '../config/firebase';

/**
 * The alert shape this service needs. Anything Prisma returns that includes
 * the student's name + roomNumber satisfies it, so callers can pass the
 * exact object they already built for the socket emit.
 */
export interface AlertPayload {
  id: string;
  studentId: string;
  type: string;
  latitude: number | null;
  longitude: number | null;
  student: {
    name: string;
    roomNumber: string;
  };
}

/** The message payload without `tokens` — tokens are added per chunk. */
type BaseMulticastMessage = Omit<MulticastMessage, 'tokens'>;

/** FCM's hard per-call limit on tokens. */
const MAX_TOKENS_PER_SEND = 500;

/** Delays before retry attempts 1..3 (~1s / ~2s / ~4s, before jitter). */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Error codes that mean the token itself is dead — never retry, delete it. */
const FATAL_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/sender-id-mismatch',
]);

/**
 * Error codes that mean "transient backend/infra problem" — safe to retry.
 */
const RETRYABLE_CODES = new Set([
  'messaging/quota-exceeded',
  'messaging/server-unavailable',
  'messaging/internal-error',
  'messaging/unknown-error',
  'messaging/unavailable',
]);

interface DeviceTokenRow {
  id: number;
  token: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return '';
}

/**
 * fcmOptions.link must be an absolute https URL or FCM rejects the whole
 * message. Local dev runs on http://localhost, so we only attach the link
 * when DASHBOARD_URL is https. In dev the service worker's `notificationclick`
 * handler resolves the alert from `data.url` instead.
 */
function clickLinkFor(alert: AlertPayload): string | undefined {
  const base = process.env.DASHBOARD_URL;
  if (!base || !base.startsWith('https://')) {
    return undefined;
  }
  return `${base.replace(/\/+$/, '')}/alerts/${alert.id}`;
}

function buildBaseMessage(alert: AlertPayload): BaseMulticastMessage {
  const link = clickLinkFor(alert);

  return {
    notification: {
      title: '🚨 Medical Emergency',
      body: `${alert.student.name} · Room ${alert.student.roomNumber} · ${alert.type}`,
    },
    // Every FCM data value must be a string — numbers are rejected.
    data: {
      alertId: String(alert.id),
      studentId: String(alert.studentId),
      type: String(alert.type),
      latitude: alert.latitude === null ? '' : String(alert.latitude),
      longitude: alert.longitude === null ? '' : String(alert.longitude),
      url: `/alerts/${alert.id}`,
    },
    android: { priority: 'high' },
    webpush: {
      headers: { Urgency: 'high', TTL: '300' },
      ...(link ? { fcmOptions: { link } } : {}),
    },
  };
}

/**
 * Retry only transient failures: FCM quota (429) and 5xx-class server
 * errors, plus errors with no code at all — those are raw network failures
 * (DNS, connection reset) where a retry actually can succeed. Every other
 * coded error (unauthorized, invalid credential, bad payload) is hard and
 * dropping it immediately avoids three doomed retries.
 */
function isRetryableFailure(code: string): boolean {
  return code === '' || RETRYABLE_CODES.has(code);
}

/**
 * Send one chunk, then delete every token FCM reports as dead
 * (404/410 from the console — stale or invalid registration tokens).
 */
async function deleteDeadTokens(
  failedTokens: DeviceTokenRow[],
  errors: readonly unknown[],
): Promise<void> {
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i];
    const row = failedTokens[i];
    if (!row || !error) {
      continue;
    }
    const code = errorCode(error);
    if (!FATAL_TOKEN_CODES.has(code)) {
      continue;
    }

    try {
      // deleteMany instead of delete: the row may already be gone if the
      // same token was reassigned, and deleting a missing row must not throw.
      await prisma.deviceToken.deleteMany({ where: { token: row.token } });
      logger.warn(
        { code, tokenPrefix: row.token.slice(0, 12) },
        `[push] deleted dead device token (${code}): ${row.token.slice(0, 12)}…`,
      );
    } catch (dbError) {
      // Never let token cleanup break the push loop.
      logger.error({ err: dbError }, '[push] failed to delete dead device token');
    }
  }
}

/**
 * Attempt to send one chunk. Returns only the tokens that hit a retryable
 * (transient) failure; dead tokens are dropped.
 */
async function attemptChunk(
  messaging: Messaging,
  rows: DeviceTokenRow[],
  base: BaseMulticastMessage,
): Promise<DeviceTokenRow[]> {
  const message: MulticastMessage = { ...base, tokens: rows.map((row) => row.token) };

  try {
    const response = await messaging.sendEachForMulticast(message);
    const toRetry: DeviceTokenRow[] = [];
    const fatalDeletes: DeviceTokenRow[] = [];
    const fatalErrors: unknown[] = [];

    response.responses.forEach((result, index) => {
      if (result.success) {
        // METRIC per token outcome — Grafana's "FCM stale token rate"
        // (success | failed | stale_token) is drawn from these three labels.
        fcmSentTotal.inc({ status: 'success' });
        return;
      }
      const row = rows[index];
      if (!row) {
        return;
      }
      const code = errorCode(result.error);
      if (FATAL_TOKEN_CODES.has(code)) {
        fatalDeletes.push(row);
        fatalErrors.push(result.error);
        fcmSentTotal.inc({ status: 'stale_token' });
      } else if (isRetryableFailure(code)) {
        toRetry.push(row);
        fcmSentTotal.inc({ status: 'failed' });
        logger.warn(
          {
            code,
            tokenPrefix: row.token.slice(0, 12),
            err: result.error instanceof Error ? result.error.message : String(result.error),
          },
          `[push] token ${row.token.slice(0, 12)}… failed (${code})`,
        );
      } else {
        // Hard, non-retryable failure (e.g. messaging/unauthorized).
        // Retrying cannot help — drop the token for this alert and log.
        fcmSentTotal.inc({ status: 'failed' });
        logger.warn(
          {
            code,
            tokenPrefix: row.token.slice(0, 12),
            err: result.error instanceof Error ? result.error.message : String(result.error),
          },
          `[push] token ${row.token.slice(0, 12)}… dropped after hard failure (${code})`,
        );
      }
    });

    if (fatalDeletes.length > 0) {
      await deleteDeadTokens(fatalDeletes, fatalErrors);
    }
    return toRetry;
  } catch (error) {
    // The whole call failed (transport error, malformed request, auth, ...).
    const code = errorCode(error);
    if (FATAL_TOKEN_CODES.has(code)) {
      await deleteDeadTokens(
        rows,
        rows.map(() => error),
      );
      fcmSentTotal.inc({ status: 'stale_token' });
      return [];
    }
    if (isRetryableFailure(code)) {
      fcmSentTotal.inc({ status: 'failed' });
      logger.warn(
        {
          code: code || 'network-error',
          err: error instanceof Error ? error.message : String(error),
        },
        `[push] chunk send failed (${code || 'network-error'})`,
      );
      return rows;
    }
    // Hard non-retryable error (e.g. invalid credentials) — no point in
    // retrying a call that will be refused again.
    fcmSentTotal.inc({ status: 'failed' });
    logger.error(
      {
        code: code || 'unknown',
        err: error instanceof Error ? error.message : String(error),
      },
      `[push] chunk send refused (${code || 'unknown'}), not retrying`,
    );
    return [];
  }
}

/**
 * Send one 500-token chunk with exponential backoff + jitter:
 * ~1s, ~2s, ~4s (each scaled by 0.5–1.5 at random). Only the failed
 * remainder is retried — never the whole batch.
 */
async function sendChunkWithRetry(
  messaging: Messaging,
  rows: DeviceTokenRow[],
  base: BaseMulticastMessage,
): Promise<void> {
  let remaining = await attemptChunk(messaging, rows, base);

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length && remaining.length > 0; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt]! * (0.5 + Math.random());
    logger.warn(
      {
        attempt: attempt + 1,
        maxAttempts: RETRY_DELAYS_MS.length,
        tokens: remaining.length,
        delayMs: Math.round(delay),
      },
      `[push] retrying ${remaining.length} token(s) in ~${Math.round(delay)}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`,
    );
    await sleep(delay);
    remaining = await attemptChunk(messaging, remaining, base);
  }

  if (remaining.length > 0) {
    logger.error(
      { tokens: remaining.length, maxAttempts: RETRY_DELAYS_MS.length },
      `[push] ${remaining.length} token(s) still failing after ${RETRY_DELAYS_MS.length} retries — giving up for this alert`,
    );
  }
}

/**
 * The actual push pipeline: fetch every warden's registered device tokens,
 * chunk them and send. All failures are logged, none escape.
 */
async function runSendAlertPush(alert: AlertPayload): Promise<void> {
  const messaging = fcmMessaging;
  if (!messaging) {
    logger.warn(
      { alertId: alert.id },
      '[push] FCM messaging not initialized — skipping push for this alert',
    );
    return;
  }

  const rows = await prisma.deviceToken.findMany({
    select: { id: true, token: true },
    orderBy: { id: 'asc' },
  });

  if (rows.length === 0) {
    logger.info({ alertId: alert.id }, '[push] no registered device tokens — nothing to push');
    return;
  }

  const base = buildBaseMessage(alert);
  const startedAt = Date.now();

  for (let i = 0; i < rows.length; i += MAX_TOKENS_PER_SEND) {
    const chunk = rows.slice(i, i + MAX_TOKENS_PER_SEND);
    await sendChunkWithRetry(messaging, chunk, base);
  }

  logger.info(
    { alertId: alert.id, tokens: rows.length, durationMs: Date.now() - startedAt },
    `[push] dispatch finished for alert ${alert.id} in ${Date.now() - startedAt}ms (${rows.length} token(s))`,
  );
}

/**
 * Fire-and-forget entry point called from POST /alerts after the realtime
 * socket emit. Returns immediately; the HTTP response is never delayed or
 * failed by push. Every possible rejection is caught and logged here.
 */
export function sendAlertPush(alert: AlertPayload): void {
  void runSendAlertPush(alert).catch((error) => {
    logger.error({ alertId: alert.id, err: error }, '[push] unhandled push failure (socket path unaffected)');
  });
}
