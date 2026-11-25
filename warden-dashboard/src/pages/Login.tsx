import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, setSession } from '../api/client';
import { registerPushToken } from '../services/push';
import { unlockAudio } from '../lib/beep';

interface LoginResponse {
  token: string;
  user: { id: string; name: string; role: string };
}

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState(import.meta.env.DEV ? 'warden@hostel.local' : '');
  const [password, setPassword] = useState(import.meta.env.DEV ? 'password123' : '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    // Must run inside the click gesture so later alert beeps are allowed.
    unlockAudio();

    try {
      const data = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, role: 'WARDEN' }),
      });

      setSession(data.token, data.user);

      // Fire-and-forget: the permission prompt shows close to the click
      // gesture; failure must never block login. registerPushToken dedupes
      // with the dashboard's mount-time call.
      void registerPushToken();

      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-red-500">
            Hostel Emergency
          </p>
          <h1 className="mt-2 text-2xl font-bold text-white">Warden dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">
            Sign in to receive live SOS alerts.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-300">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-300">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-red-500"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-red-600 py-2.5 font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        {import.meta.env.DEV && (
          <p className="mt-6 text-center text-xs text-slate-500">
            Seed login: warden@hostel.local / password123
          </p>
        )}
      </div>
    </div>
  );
}
