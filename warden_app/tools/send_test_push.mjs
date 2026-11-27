#!/usr/bin/env node
/**
 * Optional isolation tool: send ONE FCM message to a single device token,
 * using the same Android block as production. This separates "FCM / service
 * account misconfigured" from "the app is not handling the message".
 *
 *   node warden_app/tools/send_test_push.mjs <device-token> [title] [body]
 *
 * Reads FIREBASE_SERVICE_ACCOUNT_B64 from the environment or backend/.env and
 * uses the backend's installed firebase-admin (no new dependency). Prints only
 * a truncated token suffix and the message id.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireFromBackend = createRequire(
  resolve(repoRoot, 'backend', 'package.json'),
);

const token = process.argv[2];
if (!token) {
  console.error('usage: node send_test_push.mjs <device-token> [title] [body]');
  process.exit(1);
}

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = resolve(repoRoot, 'backend', '.env');
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== name) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const b64 = envValue('FIREBASE_SERVICE_ACCOUNT_B64');
if (!b64) {
  console.error('FIREBASE_SERVICE_ACCOUNT_B64 is not set');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64 JSON');
  process.exit(1);
}

const admin = requireFromBackend('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const alertId = `test-${Date.now()}`;
const message = {
  token,
  notification: {
    title: process.argv[3] ?? 'Test alert',
    body: process.argv[4] ?? 'HostelGuard Warden test push',
  },
  data: {
    alertId,
    studentId: 'test-student',
    type: 'TEST',
    latitude: '',
    longitude: '',
    url: `/alerts/${alertId}`,
  },
  android: {
    priority: 'high',
    ttl: 300_000,
    notification: {
      channelId: 'warden_alerts',
      sound: 'default',
      priority: 'max',
      visibility: 'public',
      tag: `alert-${alertId}`,
    },
  },
};

const suffix = token.slice(-6);
try {
  const id = await admin.messaging().send(message);
  console.log(`PASS  sent to …${suffix} messageId=${id}`);
} catch (error) {
  console.error(`FAIL  send to …${suffix} rejected: ${error.code ?? 'unknown'}`);
  process.exit(1);
}
