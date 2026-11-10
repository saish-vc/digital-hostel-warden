import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getMessaging, type Messaging } from 'firebase/messaging';

/**
 * Firebase Web SDK config. Every value comes from VITE_FIREBASE_* env vars.
 * These identifiers are public by design (the same values are hard-coded in
 * public/firebase-messaging-sw.js) — only the VAPID key and service account
 * are secret.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

export const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY ?? '';

/**
 * True when enough config is present to attempt FCM registration.
 * Missing pieces mean push stays disabled — sockets keep working regardless.
 */
export function hasFirebaseConfig(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId &&
      firebaseConfig.messagingSenderId &&
      vapidKey,
  );
}

let messagingInstance: Messaging | null = null;

/**
 * Lazily build the Messaging handle. React StrictMode double-renders and
 * double-mounts in dev, but `getApps()` guards against double-initialize,
 * so this is safe in both mounting passes.
 */
export function getMessagingInstance(): Messaging | null {
  if (messagingInstance) {
    return messagingInstance;
  }
  if (!hasFirebaseConfig()) {
    return null;
  }

  const app: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  messagingInstance = getMessaging(app);
  return messagingInstance;
}
