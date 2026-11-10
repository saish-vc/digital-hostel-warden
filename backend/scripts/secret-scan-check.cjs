// One-off verification: run the pre-commit secret-scan patterns over the
// project tree and report anything secret-shaped (allowlist excluded).
const { execSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const ASSIGN_PATTERN =
  /(JWT_SECRET|METRICS_TOKEN|TWILIO_AUTH_TOKEN|TWILIO_ACCOUNT_SID)[\t ]*=[\t ]*["']?[^\s"']{8,}/;
const SHAPE_PATTERNS = [
  /(AKIA[0-9A-Z]{16})/,
  /(AIza[0-9A-Za-z_-]{35})/,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
  /(returnDefaultValues|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,})/,
];
const ALLOW = [
  /""/,
  /''/,
  /CHANGE-ME/,
  /test-only-jwt-secret/,
  /test-auth-token/,
  /hardening-test-metrics-token/,
  /ACtest/,
  /dev-only-secret-change-me/,
  /process\.env\.[A-Z_]+\s*=/,
  /\[redacted\]/,
  /redact/,
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = require('node:fs').readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|js|sql|md|ya?ml|json|dart|jsx?|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = [];
walk(path.join(ROOT, 'src'), files);
walk(path.join(ROOT, 'prisma'), files);
walk(path.join(ROOT, 'tests'), files);
walk(path.join(ROOT, 'docs'), files);
walk(path.join(ROOT, 'monitoring'), files);
walk(path.join(ROOT, '.husky'), files);
files.push(path.join(ROOT, '.env.example'));
files.push(path.join(ROOT, 'ecosystem.config.js'));

const hits = [];
let scanned = 0;
for (const file of files) {
  let content;
  try {
    content = require('node:fs').readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned++;
  content.split(/\r?\n/).forEach((line, i) => {
    if (ASSIGN_PATTERN.test(line) || SHAPE_PATTERNS.some((r) => r.test(line))) {
      if (ALLOW.some((a) => a.test(line))) return;
      hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

console.log(`scanned ${scanned} files with the hook's patterns`);
if (hits.length === 0) {
  console.log('SECRET SCAN: CLEAN — 0 hits (--scan equivalent)');
} else {
  console.log('SECRET-STRONG HITS FOUND:');
  for (const h of hits) console.log('  ' + h);
  process.exitCode = 2;
}
