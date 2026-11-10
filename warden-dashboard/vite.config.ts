import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SW_FILE = 'firebase-messaging-sw.js';

const FIREBASE_KEYS = [
  'API_KEY',
  'AUTH_DOMAIN',
  'PROJECT_ID',
  'STORAGE_BUCKET',
  'MESSAGING_SENDER_ID',
  'APP_ID',
] as const;

function substitute(raw: string, env: Record<string, string>): string {
  let out = raw;
  for (const key of FIREBASE_KEYS) {
    out = out.replaceAll(`__VITE_FIREBASE_${key}__`, env[`VITE_FIREBASE_${key}`] ?? '');
  }
  return out;
}

/**
 * public/ is copied verbatim by Vite — `import.meta.env` is never injected
 * into static files — so public/firebase-messaging-sw.js carries
 * __VITE_FIREBASE_*__ markers that this plugin replaces:
 * - dev: served in-memory from the marker-substituted copy on every request
 * - build: the copied dist file is rewritten once the build closes
 * The Firebase web identifiers are public, but keeping them in .env keeps
 * project-specific values out of the repo.
 */
function serviceWorkerEnvPlugin(): Plugin[] {
  return [
    {
      name: 'firebase-sw-env:dev',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = (req.originalUrl ?? req.url ?? '').split('?')[0];
          if (url !== `/${SW_FILE}`) {
            next();
            return;
          }
          const env = loadEnv(server.config.mode, process.cwd(), '');
          const raw = readFileSync(path.resolve(process.cwd(), 'public', SW_FILE), 'utf8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Service-Worker-Allowed', '/');
          res.end(substitute(raw, env));
        });
      },
    },
    {
      name: 'firebase-sw-env:build',
      apply: 'build',
      closeBundle() {
        const target = path.resolve(process.cwd(), 'dist', SW_FILE);
        if (!existsSync(target)) {
          return;
        }
        const env = loadEnv('production', process.cwd(), '');
        const source = readFileSync(path.resolve(process.cwd(), 'public', SW_FILE), 'utf8');
        writeFileSync(target, substitute(source, env));
      },
    },
  ];
}

export default defineConfig({
  plugins: [react(), serviceWorkerEnvPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
