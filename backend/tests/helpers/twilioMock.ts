import { vi } from 'vitest';

/**
 * Twilio SDK replacement. The SMS service calls `twilio(sid, token)` and then
 * `client.messages.create({ to, from, body })`; this records every send and
 * returns a fake receipt id.
 *
 * Usage in a test file (the factory must be async so the singleton below is
 * created exactly once and is the same instance the test imports):
 *
 *   vi.mock('twilio', async () => {
 *     const { createTwilioModuleMock } = await import('./helpers/twilioMock');
 *     return createTwilioModuleMock();
 *   });
 */
export interface SentSms {
  to: string;
  from: string;
  body: string;
}

const defaultSend = async (args: SentSms) => {
  twilioMock.sent.push(args);
  return { sid: 'SM_test_receipt_0001' };
};

export const twilioMock = {
  sent: [] as SentSms[],
  createMessage: vi.fn(defaultSend),
};

export function resetTwilioMock(): void {
  twilioMock.sent.length = 0;
  twilioMock.createMessage.mockReset();
  twilioMock.createMessage.mockImplementation(defaultSend);
}

export function createTwilioModuleMock() {
  return {
    default: (_accountSid?: string, _authToken?: string) => ({
      messages: {
        create: (args: SentSms) => twilioMock.createMessage(args),
      },
    }),
  };
}
