import { useEffect, useState } from 'react';
import { ESCALATION_WINDOW_S } from '../hooks/useAlertSocket';

interface EscalationCountdownProps {
  createdAt: string;
  status: string;
  /** Set only by the worker's alert:escalated event — the delivery truth. */
  escalatedAt?: string | null;
  /** Set only by the worker's alert:escalation-failed event. */
  escalationFailedAt?: string | null;
}

/**
 * Grace period past the window before an unconfirmed escalation is called
 * failed. Covers a worker that is stopped or dead and therefore cannot emit
 * anything; a worker that is merely running late reports its own failure.
 */
const UNCONFIRMED_GRACE_S = 10;

/**
 * Escalation state for a PENDING alert.
 *
 * The countdown is a visual approximation driven from createdAt, but the
 * outcome is NOT: "SMS sent" renders only when the worker confirmed delivery
 * via alert:escalated. The old version claimed "SMS sent" at 60s
 * unconditionally, which lied whenever the worker failed or was stopped.
 *
 * - confirmed sent                        → red "SMS sent"
 * - worker reported failure               → red "⚠️ Escalation failed"
 * - window still running                  → amber "⏱ Ns"
 * - window elapsed, no word yet           → amber "Escalation pending…"
 * - elapsed + grace, still no word        → red "⚠️ Escalation failed"
 * - ACKNOWLEDGED / RESOLVED               → nothing
 */
export default function EscalationCountdown({
  createdAt,
  status,
  escalatedAt,
  escalationFailedAt,
}: EscalationCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  const settled = Boolean(escalatedAt || escalationFailedAt);

  useEffect(() => {
    if (status !== 'PENDING' || settled) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status, settled]);

  if (status !== 'PENDING') {
    return null;
  }

  if (escalatedAt) {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-red-700 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
        title={`Escalation SMS confirmed sent by the worker at ${new Date(escalatedAt).toLocaleTimeString()}`}
      >
        SMS sent
      </span>
    );
  }

  if (escalationFailedAt) {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-red-800 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
        title={`The escalation worker reported a failed SMS send at ${new Date(escalationFailedAt).toLocaleTimeString()}`}
      >
        ⚠️ Escalation failed
      </span>
    );
  }

  const elapsedS = Math.floor((now - new Date(createdAt).getTime()) / 1000);
  const remaining = ESCALATION_WINDOW_S - elapsedS;

  if (remaining > 0) {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-amber-950/70 px-2 py-0.5 text-xs font-semibold text-amber-300"
        title={`Escalation SMS fires if nobody acknowledges within ${ESCALATION_WINDOW_S}s`}
      >
        ⏱ {remaining}s
      </span>
    );
  }

  if (remaining > -UNCONFIRMED_GRACE_S) {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-amber-950/70 px-2 py-0.5 text-xs font-semibold text-amber-300"
        title="Escalation window elapsed — waiting for the worker to confirm the SMS"
      >
        Escalation pending…
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-1 rounded-full bg-red-800 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
      title="No confirmation received from the escalation worker — is it running?"
    >
      ⚠️ Escalation failed
    </span>
  );
}