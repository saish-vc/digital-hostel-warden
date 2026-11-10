import type { Alert } from '../api/client';
import EscalationCountdown from './EscalationCountdown';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface AlertCardProps {
  alert: Alert;
  selected: boolean;
  /** Briefly true for a freshly-arrived alert (see the flash animation). */
  flash?: boolean;
  onSelect: (id: string) => void;
}

export default function AlertCard({
  alert,
  selected,
  flash = false,
  onSelect,
}: AlertCardProps) {
  const pending = alert.status === 'PENDING';
  const hasLocation = alert.latitude !== null && alert.longitude !== null;

  return (
    <button
      type="button"
      onClick={() => onSelect(alert.id)}
      className={`w-full rounded-2xl border p-4 text-left transition ${
        selected
          ? 'border-red-500 bg-red-950/40 shadow-lg shadow-red-950/40'
          : pending
            ? 'border-slate-800 bg-slate-900 hover:border-red-700'
            : 'border-slate-800 bg-slate-900 hover:border-slate-700'
      } ${flash ? 'alert-flash' : ''}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
            pending ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
          }`}
        >
          {alert.status}
        </span>
        <span
          className={`flex items-center gap-1 text-xs ${
            hasLocation ? 'text-slate-400' : 'text-amber-400'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${hasLocation ? 'bg-sky-400' : 'bg-amber-400'}`} />
          {hasLocation ? 'GPS' : 'No GPS'}
        </span>
      </div>

      <h2 className="mt-2 text-lg font-bold text-white">{alert.student.name}</h2>
      <p className="text-sm text-slate-400">
        Room {alert.student.roomNumber} · {alert.type} · {formatTime(alert.createdAt)}
      </p>

      <div className="mt-2 flex items-center gap-2">
        <EscalationCountdown
          createdAt={alert.createdAt}
          status={alert.status}
          escalatedAt={alert.escalatedAt}
          escalationFailedAt={alert.escalationFailedAt}
        />
      </div>
    </button>
  );
}
