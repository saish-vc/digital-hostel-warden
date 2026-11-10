import { cert, getApps, initializeApp, type AppOptions } from 'firebase-admin';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { logger } from './logger';

/**
 * The raw service-account JSON as downloaded from the Firebase console.
 * Only these fields are required by `cert()`; extra fields are ignored.
 */
interface ServiceAccountJson {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

let loggedInit = false;

/**
 * Initialize Firebase Admin exactly once, at module load, so hot reload
 * (`tsx watch`) never throws "app already exists".
 *
 * The credential is the base64-encoded service-account JSON stored in
 * FIREBASE_SERVICE_ACCOUNT_B64. The secret itself is never written to disk
 * or committed — only the base64 string lives in `.env`.
 *
 * On any failure (missing env var, malformed JSON, bad key) messaging is
 * `null` and the API keeps running with push disabled. This is deliberate:
 * the socket + HTTP paths must never depend on Firebase being reachable.
 */
function buildMessaging(): Messaging | null {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  if (!encoded || encoded.trim() === '') {
    logger.warn(
      '[firebase] FIREBASE_SERVICE_ACCOUNT_B64 is not set — push notifications are disabled',
    );
    return null;
  }

  try {
    const raw = Buffer.from(encoded, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(raw) as ServiceAccountJson;

    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      logger.error(
        '[firebase] service-account JSON is missing client_email or private_key — push notifications are disabled',
      );
      return null;
    }

    // Guard: don't re-initialize if another module (hot reload) already did.
    if (getApps().length === 0) {
      const options: AppOptions = {
        credential: cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key,
        }),
      };
      initializeApp(options);
    }

    const messaging = getMessaging();
    if (!loggedInit) {
      loggedInit = true;
      // project_id is safe to log; the private key/client_email are NOT.
      logger.info(
        { project: serviceAccount.project_id ?? 'default' },
        '[firebase] FCM messaging initialized',
      );
    }
    return messaging;
  } catch (error) {
    // { err } context: pino's redact list covers the credential fields, and
    // an Error object is serialized via pino's err serializer (message+stack,
    // never the parsed JSON body).
    logger.error({ err: error }, '[firebase] failed to initialize FCM — push disabled');
    return null;
  }
}

export const fcmMessaging: Messaging | null = buildMessaging();
