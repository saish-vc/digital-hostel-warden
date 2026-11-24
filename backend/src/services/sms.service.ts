import twilio from 'twilio';
import { logger } from '../config/logger';
import { smsSentTotal } from '../config/metrics';

/**
 * SMS fallback for the escalation path.
 *
 * Provider is selectable via SMS_PROVIDER, but only Twilio is implemented.
 * MSG91 stub: to add it later, branch on provider here and implement
 * sendViaMsg91(alert, phone) with the same Promise<string> contract
 * (return MSG91's request ID), then extend the retry classifier for
 * MSG91's error shape.
 *
 * Retry policy: exponential backoff + jitter on Network errors and
 * Twilio 429/5xx only (~1s, ~2s, ~4s, each scaled by 0.5–1.5 at random).
 * Hard 4xx (invalid number, unverified recipient, bad credentials) is
 * never retried — a retry cannot fix them.
 */

const RETRY_DELAYS_MS = [1000, 2000, 4000];

export interface EscalationSmsAlert {
  id: string;
  type: string;
  student: {
    name: string;
    roomNumber: string;
  };
}

interface SmsResult {
  /** Provider receipt — Twilio message SID on success. */
  receiptId: string;
  to: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER,
  );
}

function buildEscalationBody(alert: EscalationSmsAlert): string {
  const base =
    `[HOSTEL EMERGENCY] ${alert.student.name} · Room ${alert.student.roomNumber} · ${alert.type}. ` +
    `NO ACKNOWLEDGEMENT FOR 60s. Respond immediately.`;

  const dashboardUrl = process.env.DASHBOARD_URL;
  if (!dashboardUrl) {
    return base;
  }
  return `${base} Dashboard: ${dashboardUrl.replace(/\/+$/, '')}/alerts/${alert.id}`;
}

/** True for problems a retry can plausibly fix; false for hard 4xx. */
function isRetryableTwilioError(error: unknown): boolean {
  // Twilio SDK raises RestException (HTTP status present via err.status)
  // or plain Error on network failure (no status).
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : NaN;

  if (Number.isNaN(status)) {
    // No status → transport/network error → retry.
    return true;
  }
  return status === 429 || status >= 500;
}

async function sendViaTwilio(alert: EscalationSmsAlert, to: string): Promise<SmsResult> {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
  );
  const from = process.env.TWILIO_FROM_NUMBER!;
  const body = buildEscalationBody(alert);

  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1]! * (0.5 + Math.random());
      logger.warn(
        { attempt, maxAttempts: RETRY_DELAYS_MS.length, delayMs: Math.round(delay) },
        `[sms] retrying Twilio send in ~${Math.round(delay)}ms (attempt ${attempt}/${RETRY_DELAYS_MS.length})`,
      );
      await sleep(delay);
    }
    try {
      const message = await client.messages.create({ to, from, body });
      return { receiptId: message.sid, to };
    } catch (error) {
      lastError = error;
      if (isRetryableTwilioError(error)) {
        logger.warn(
          // Log the error and any safe status code — never the auth token.
          { err: error instanceof Error ? error.message : error },
          '[sms] Twilio send failed (retryable)',
        );
        continue;
      }
      // Hard 4xx — rethrow immediately.
      throw error;
    }
  }
  throw lastError;
}

/**
 * Dev/demo stand-in. Refused under NODE_ENV=production: a mock that reports
 * success would turn a misconfigured deploy into silently missed escalations.
 * SMS_MOCK_OUTCOME=fail exercises the failure path end to end.
 */
function sendViaMock(alert: EscalationSmsAlert): SmsResult {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SMS_PROVIDER=mock is refused when NODE_ENV=production');
  }
  if (process.env.SMS_MOCK_OUTCOME === 'fail') {
    smsSentTotal.inc({ status: 'failed' });
    throw new Error('mock SMS failure (SMS_MOCK_OUTCOME=fail)');
  }

  smsSentTotal.inc({ status: 'success' });
  const result = { receiptId: `MOCK-${alert.id}`, to: 'mock' };
  logger.info(result, `[sms] MOCK escalation SMS for alert ${alert.id} (nothing sent)`);
  return result;
}

/**
 * Send the escalation SMS to the on-call warden number.
 * Returns the provider receipt id (Twilio message SID); failures throw so
 * BullMQ marks the job failed. Credentials are never logged.
 */
export async function sendEscalationSms(alert: EscalationSmsAlert): Promise<SmsResult> {
  const provider = (process.env.SMS_PROVIDER ?? 'twilio').toLowerCase();
  if (provider === 'mock') {
    return sendViaMock(alert);
  }
  if (provider !== 'twilio') {
    throw new Error(
      `SMS_PROVIDER=${provider} is not implemented yet (only "twilio" or "mock")`,
    );
  }

  if (!twilioConfigured()) {
    throw new Error(
      'SMS is not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and WARDEN_ONCALL_PHONE',
    );
  }

  const to = process.env.WARDEN_ONCALL_PHONE!;
  if (!/^\+?[1-9]\d{1,14}$/.test(to)) {
    throw new Error('WARDEN_ONCALL_PHONE is not a valid E.164 number (e.g. +919876543210)');
  }

  let result: SmsResult;
  try {
    result = await sendViaTwilio(alert, to);
  } catch (error) {
    // METRIC: status="failed" — feeds the SMSSuccessRateLow alert formula
    // (success / total < 0.8 for 10m) in monitoring/rules/hostel.yml.
    smsSentTotal.inc({ status: 'failed' });
    throw error;
  }

  // METRIC: status="success" — Grafana's SMS delivery-rate panel.
  smsSentTotal.inc({ status: 'success' });

  logger.info(
    { to: result.to, receiptId: result.receiptId },
    `[sms] escalation SMS delivered to ${result.to} — receipt ${result.receiptId}`,
  );
  return result;
}
