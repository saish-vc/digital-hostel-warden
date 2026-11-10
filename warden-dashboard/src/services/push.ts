import { getToken, onMessage, type Messaging } from 'firebase/messaging';
import { getMessagingInstance, hasFirebaseConfig, vapidKey } from '../config/firebase';
import { registerFcmToken, deleteFcmToken } from '../api/client';

/**
 * Push-state union surfaced to the dashboard UI:
 * - granted:      permission granted AND a token is registered with the API
 * - granted-pending:   permission granted but registration hit an error —
 *                 the UI treats it like active-with-warning
 * - denied:       the browser blocked notifications (see the warning banner)
 * - default:      the user dismissed the permission prompt; will retry
 * - unsupported:  no ServiceWorker / PushManager / missing config
 */
export type PushStatus =
  | 'granted'
  | 'granted-error'
  | 'denied'
  | 'default'
  | 'unsupported';

const TOKEN_KEY = 'fcmToken';

function getCachedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function cacheToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Resolve the SW at the site root — required by FCM for getToken(). */
async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/firebase-messaging-sw.js', {
    scope: '/',
  });
}

/**
 * Push must never take the dashboard down: every failure path returns a
 * status instead of throwing. Sockets remain the primary channel.
 */
async function registerToken(messaging: Messaging): Promise<PushStatus> {
  const registration = await serviceWorkerRegistration();
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });

  if (!token) {
    // Surfaced as the header's "registration error" indicator.
    return 'granted-error';
  }

  await registerFcmToken(token, navigator.userAgent);
  cacheToken(token);
  return 'granted';
}

/** In-flight guard: Login + Dashboard-mount calls dedupe into one run. */
let pending: Promise<PushStatus> | null = null;

/**
 * Entry point called after login and on dashboard mount.
 * Requests permission if unset, then registers the FCM token with the
 * backend. Idempotent and safe to call repeatedly.
 */
export function registerPushToken(): Promise<PushStatus> {
  if (pending) {
    return pending;
  }

  pending = (async (): Promise<PushStatus> => {
    if (!hasFirebaseConfig()) {
      return 'unsupported';
    }

    if (
      !('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
    ) {
      return 'unsupported';
    }

    // Permission: prompt only when the user hasn't decided yet.
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        return result === 'denied' ? 'denied' : 'default';
      }
    } else if (Notification.permission === 'denied') {
      return 'denied';
    }

    const messaging = getMessagingInstance();
    if (!messaging) {
      return 'unsupported';
    }

    try {
      return await registerToken(messaging);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError') {
        // Browser refused registration (e.g. blocked notifications/content).
        return 'denied';
      }
      if (name === 'NotSupportedError' || name === 'InvalidStateError') {
        return 'unsupported';
      }
      return 'granted-error';
    }
  })();

  return pending.finally(() => {
    pending = null;
  });
}

/**
 * Logout path: delete the token server-side so this browser stops receiving
 * push, then drop the local cache. Fires errors to the caller's catch —
 * logout must proceed regardless.
 */
export async function unregisterPushToken(): Promise<void> {
  const token = getCachedToken();
  if (!token) {
    return;
  }
  try {
    await deleteFcmToken(token);
  } finally {
    localStorage.removeItem(TOKEN_KEY);
  }
}

type ForegroundPayload = {
  notification?: { title?: string; body?: string };
  data?: Record<string, string>;
};

let foregroundHandler: ((payload: ForegroundPayload) => void) | null = null;
let observing = false;

/**
 * Foreground messages never reach the service worker's background hook, so
 * without this handler a focused tab would stay silent. The FCM SDK fires
 * here only when the page is visible — that's why no OS notification
 * duplicates appear.
 */
export function observeForegroundMessages(
  handler: (payload: ForegroundPayload) => void,
): void {
  foregroundHandler = handler;

  const messaging = getMessagingInstance();
  if (!messaging || observing) {
    return;
  }
  observing = true;

  onMessage(messaging, (payload) => {
    foregroundHandler?.(payload as ForegroundPayload);
  });
}
