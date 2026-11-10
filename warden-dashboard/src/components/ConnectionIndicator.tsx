export type ConnectionState = 'live' | 'reconnecting' | 'error';

const STATES: Record<ConnectionState, { dot: string; label: string }> = {
  live: { dot: 'bg-emerald-500', label: 'Live' },
  reconnecting: { dot: 'bg-amber-500', label: 'Reconnecting' },
  error: { dot: 'bg-red-500', label: 'Disconnected' },
};

/**
 * Green = socket connected, amber = temporarily reconnecting (normal after a
 * network blip), red = a connect/fetch error the warden should notice (bad
 * credentials, server unreachable, CORS/handshake rejection).
 */
export default function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const { dot, label } = STATES[state];

  return (
    <span
      className="flex items-center gap-2 text-xs text-slate-300"
      role="status"
      aria-live="polite"
      title="Realtime connection to the alert server"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
