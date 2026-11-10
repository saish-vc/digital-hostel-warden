/**
 * FCM web-push service worker.
 *
 * MUST be served from the root path (/firebase-messaging-sw.js). It lives in
 * public/, which the Vite dev server and the production build both copy to
 * the site root. Production deployments require HTTPS.
 *
 * The importScripts URLs are version-pinned to `firebase` in package.json.
 * When you upgrade the dashboard SDK, upgrade these two URLs to the same
 * version.
 */
importScripts('https://www.gstatic.com/firebasejs/13.2.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging-compat.js');

// Public web identifiers — identical to the dashboard's VITE_FIREBASE_* vars.
firebase.initializeApp({
  apiKey: '__VITE_FIREBASE_API_KEY__',
  authDomain: '__VITE_FIREBASE_AUTH_DOMAIN__',
  projectId: '__VITE_FIREBASE_PROJECT_ID__',
  storageBucket: '__VITE_FIREBASE_STORAGE_BUCKET__',
  messagingSenderId: '__VITE_FIREBASE_MESSAGING_SENDER_ID__',
  appId: '__VITE_FIREBASE_APP_ID__',
});

const messaging = firebase.messaging();

/**
 * Background message (no focused dashboard tab): show the OS notification.
 * When the tab is focused, the FCM SDK routes the payload to the page's
 * onMessage handler instead and does NOT reach this hook — that's what
 * prevents duplicate OS notifications in the foreground.
 */
messaging.onBackgroundMessage((payload) => {
  const data = payload.data ?? {};
  const notification = payload.notification ?? {};

  if (!data.alertId) {
    return;
  }

  self.registration.showNotification(notification.title || '🚨 Medical Emergency', {
    body: notification.body || `${data.type || 'Emergency'} alert`,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    // tag collapses multiple pushes about the same alert into one bubble
    tag: data.alertId,
    renotify: true,
    requireInteraction: true,
    data,
  });
});

/**
 * Notification click: focus an already-open dashboard tab (and tell it to
 * select the alert), otherwise open the dashboard at /alerts/{id}.
 * data.url is relative ("/alerts/{alertId}"); resolve it against origin.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data ?? {};
  const alertId = data.alertId;
  const target = data.url
    ? new URL(data.url, self.location.origin).href
    : self.location.origin;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const client = clients.find((c) => 'focus' in c);
        if (client) {
          client.postMessage({ type: 'push:open-alert', alertId });
          return client.focus().catch(() => self.clients.openWindow(target));
        }
        return self.clients.openWindow(target);
      }),
  );
});
