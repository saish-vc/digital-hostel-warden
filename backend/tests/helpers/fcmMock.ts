import { vi } from 'vitest';

/**
 * firebase-admin messaging replacement: no network, fully configurable.
 *
 * The push service reads `fcmMessaging` from src/config/firebase at call time,
 * so replacing that module's export is enough to intercept real sends.
 *
 * Usage in a test file:
 *
 *   vi.mock('../../src/config/firebase', async () => {
 *     const { createFirebaseConfigMock } = await import('./helpers/fcmMock');
 *     return createFirebaseConfigMock();
 *   });
 */
export interface MulticastLike {
  tokens?: string[];
  data?: Record<string, string>;
  notification?: { title?: string; body?: string };
}

const defaultSend = async (message: MulticastLike) => {
  const tokens = message.tokens ?? [];
  return {
    successCount: tokens.length,
    failureCount: 0,
    responses: tokens.map(() => ({ success: true, messageId: 'projects/test/messages/1' })),
  };
};

export const fcmMock = {
  messaging: {
    sendEachForMulticast: vi.fn(defaultSend),
  },
};

export function resetFcmMock(): void {
  fcmMock.messaging.sendEachForMulticast.mockReset();
  fcmMock.messaging.sendEachForMulticast.mockImplementation(defaultSend);
}

export function createFirebaseConfigMock() {
  return { fcmMessaging: fcmMock.messaging };
}
