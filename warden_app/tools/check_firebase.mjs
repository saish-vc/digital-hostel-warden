#!/usr/bin/env node
/**
 * Preflight: the backend service account and the Android google-services.json
 * must point at the SAME Firebase project, and google-services.json must be
 * built for the same applicationId as Gradle. A mismatch means every push is
 * rejected (sender-id-mismatch / mismatched-credential) — the worst failure
 * mode for a safety app, because the socket path hides it while the app is
 * open.
 *
 * Prints only non-secret identifiers and pass/fail booleans. Never the key,
 * the client email, or the base64 payload.
 *
 *   node warden_app/tools/check_firebase.mjs
 *
 * Exit codes: 0 = all match, 1 = mismatch or missing input.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appDir = resolve(repoRoot, 'warden_app', 'android', 'app');
const googleServicesPath = resolve(appDir, 'google-services.json');
const gradlePath = resolve(appDir, 'build.gradle.kts');
const envPath = resolve(repoRoot, 'backend', '.env');

function envValue(name) {
  if (process.env[name]) return process.env[name];
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

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

const b64 = envValue('FIREBASE_SERVICE_ACCOUNT_B64');
if (!b64) {
  fail('FIREBASE_SERVICE_ACCOUNT_B64 is not set (env or backend/.env)');
}
if (!existsSync(googleServicesPath)) {
  fail(`missing ${googleServicesPath}`);
}
if (!existsSync(gradlePath)) {
  fail(`missing ${gradlePath}`);
}
if (process.exitCode === 1) process.exit(1);

let serviceProject;
try {
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  serviceProject = parsed.project_id;
} catch {
  fail('FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64-encoded JSON');
}

let androidProject;
let androidPackage;
try {
  const google = JSON.parse(readFileSync(googleServicesPath, 'utf8'));
  androidProject = google.project_info?.project_id;
  androidPackage =
    google.client?.[0]?.client_info?.android_client_info?.package_name;
} catch {
  fail('google-services.json is not valid JSON');
}

const gradle = readFileSync(gradlePath, 'utf8');
const gradlePackage = gradle.match(/applicationId\s*=\s*"([^"]+)"/)?.[1];

console.log(`backend service account project : ${serviceProject ?? '(unknown)'}`);
console.log(`google-services.json project    : ${androidProject ?? '(unknown)'}`);
console.log(`google-services.json package    : ${androidPackage ?? '(unknown)'}`);
console.log(`Gradle applicationId            : ${gradlePackage ?? '(unknown)'}`);
console.log('');

if (!serviceProject || !androidProject) {
  fail('could not read both project ids');
} else if (serviceProject !== androidProject) {
  fail('project id mismatch — backend push would be rejected');
} else {
  console.log('PASS  Firebase projects match');
}

if (!androidPackage || !gradlePackage) {
  fail('could not read both package names');
} else if (androidPackage !== gradlePackage) {
  fail('package mismatch — google-services.json is for a different app');
} else {
  console.log('PASS  Android package matches Gradle applicationId');
}

if (process.exitCode === 1) process.exit(1);
console.log('PASS  Firebase preflight clean');
