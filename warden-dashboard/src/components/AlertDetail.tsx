import { useEffect, useState, type ReactNode } from 'react';
import type { Alert } from '../api/client';
import ResolveDialog from './ResolveDialog';

interface AlertDetailProps {
  alert: Alert | null;
  busy: boolean;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string, resolutionNote: string) => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-slate-800 py-3 first:border-t-0 first:pt-0">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-200">{children}</dd>
    </div>
  );
}

export default function AlertDetail({
  alert,
  busy,
  onAcknowledge,
  onResolve,
}: AlertDetailProps) {
  const [resolveOpen, setResolveOpen] = useState(false);

  // Selecting a different case must not carry an open dialog (or its draft)
  // across to an alert the warden has not looked at yet.
  useEffect(() => {
    setResolveOpen(false);
  }, [alert?.id]);

  if (!alert) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-sm font-semibold text-slate-300">Alert details</h2>
        <p className="mt-6 text-sm text-slate-500">Select an alert from the list.</p>
      </div>
    );
  }

  const pending = alert.status === 'PENDING';
  const acknowledged = alert.status === 'ACKNOWLEDGED';
  const hasLocation = alert.latitude !== null && alert.longitude !== null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-lg">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Alert details</h2>
          <h3 className="mt-2 text-2xl font-bold text-white">{alert.student.name}</h3>
          <p className="text-sm text-slate-400">
            {alert.type} · {formatTime(alert.createdAt)}
          </p>
        </div>

        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${
            pending ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
          }`}
        >
          {alert.status}
        </span>
      </div>

      <dl className="mt-4">
        <Row label="Student name">{alert.student.name}</Row>
        <Row label="Room number">{alert.student.roomNumber}</Row>
        <Row label="Medical conditions">
          {alert.student.medicalConditions ?? 'None recorded'}
        </Row>
        <Row label="Emergency contact">
          <a
            href={`tel:${alert.student.emergencyContact.replace(/\s+/g, '')}`}
            className="text-sky-300 hover:underline"
          >
            {alert.student.emergencyContact}
          </a>
        </Row>
        <Row label="Coordinates">
          {hasLocation ? (
            <>
              {alert.latitude!.toFixed(5)}, {alert.longitude!.toFixed(5)}
              {alert.locationAccuracy !== null && (
                <span className="ml-2 text-slate-400">
                  ±{Math.round(alert.locationAccuracy)}m
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-300">Location unavailable</span>
          )}
        </Row>
      </dl>

      {alert.acknowledgedAt && (
        <p className="mt-3 text-xs text-emerald-300">
          Acknowledged at {formatTime(alert.acknowledgedAt)}
        </p>
      )}

      {alert.resolutionNote && (
        <div className="mt-4 rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-4">
          <p className="text-xs uppercase tracking-wide text-emerald-300">
            Resolution note
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
            {alert.resolutionNote}
          </p>
          {alert.resolvedAt && (
            <p className="mt-2 text-xs text-slate-400">
              Resolved at {formatTime(alert.resolvedAt)}
            </p>
          )}
        </div>
      )}

      {pending && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAcknowledge(alert.id)}
          className="mt-5 w-full rounded-lg bg-red-600 py-2.5 font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Acknowledging...' : 'Acknowledge'}
        </button>
      )}

      {/* Acknowledge is intentionally absent here: an ACKNOWLEDGED case is
          already responded to, and re-acknowledging would 409. */}
      {acknowledged && !resolveOpen && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setResolveOpen(true)}
          className="mt-5 w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Resolve
        </button>
      )}

      {acknowledged && resolveOpen && (
        <ResolveDialog
          busy={busy}
          onCancel={() => setResolveOpen(false)}
          onSubmit={(note) => {
            onResolve(alert.id, note);
            setResolveOpen(false);
          }}
        />
      )}
    </div>
  );
}
