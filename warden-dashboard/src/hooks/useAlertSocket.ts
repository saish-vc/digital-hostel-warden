import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchAlerts, getToken } from '../api/client';
import type { Alert } from '../api/client';
import { playBeepForAlert } from '../lib/beep';
import { socket } from '../lib/socket';

interface EscalationEvent {
  alertId: string;
  sentAt: string;
  outcome: 'sent' | 'failed';
}

export interface EscalationFailure {
  alertId: string;
  at: string;
}

/**
 * Live socket feed for the warden board.
 *
 * Server contract: `alert:new` → `wardens`; `alert:updated` (acknowledge) →
 * `wardens` + `student:{id}`; `alert:resolved` → `wardens`;
 * `alert:escalated` / `alert:escalation_failed` carry the worker's real SMS
 * outcome. The pill reads `escalatedAt` from the API row, so it survives a
 * reload and is never inferred from a client-side timer.
 */
export function useAlertSocket() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastNewAlertId, setLastNewAlertId] = useState<string | null>(null);
  const [lastEscalationFailure, setLastEscalationFailure] =
    useState<EscalationFailure | null>(null);

  // Read synchronously by resolve() to roll back an optimistic update.
  const alertsRef = useRef<Alert[]>([]);
  alertsRef.current = alerts;

  const refresh = useCallback(async () => {
    setAlerts(await fetchAlerts());
    setError(null);
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let cancelled = false;

    refresh().catch((err: Error) => {
      if (!cancelled) setError(err.message);
    });

    const replace = (alert: Alert) =>
      setAlerts((previous) =>
        previous.map((item) => (item.id === alert.id ? alert : item)),
      );

    socket.connect();

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('connect_error', (err: Error) => {
      setConnected(false);
      setError(err.message);
    });

    socket.on('alert:new', (alert: Alert) => {
      setAlerts((previous) => {
        if (previous.some((item) => item.id === alert.id)) return previous;
        return [alert, ...previous];
      });
      setLastNewAlertId(alert.id);
      // Shared dedupe with the foreground-FCM path: one beep per alert, no
      // matter which channel delivered it first.
      playBeepForAlert(alert.id);
    });

    socket.on('alert:updated', replace);
    socket.on('alert:resolved', replace);

    socket.on('alert:escalated', (event: EscalationEvent) => {
      setAlerts((previous) =>
        previous.map((item) =>
          item.id === event.alertId ? { ...item, escalatedAt: event.sentAt } : item,
        ),
      );
    });

    socket.on('alert:escalation_failed', (event: EscalationEvent) => {
      setLastEscalationFailure({ alertId: event.alertId, at: event.sentAt });
    });

    return () => {
      cancelled = true;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [refresh]);

  const acknowledge = useCallback(async (id: string) => {
    const updated = await api<Alert>(`/alerts/${id}/acknowledge`, {
      method: 'PATCH',
    });

    setAlerts((previous) =>
      previous.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);

  /**
   * Optimistic resolve: flip the card immediately, then reconcile with the
   * server. On any failure (409 invalid_transition included) roll back to the
   * exact prior list and re-fetch, so the board never keeps a resolution the
   * server refused.
   */
  const resolve = useCallback(
    async (id: string, resolutionNote: string) => {
      const before = alertsRef.current;
      const optimisticAt = new Date().toISOString();

      setAlerts(
        before.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'RESOLVED',
                resolutionNote,
                resolvedAt: optimisticAt,
              }
            : item,
        ),
      );

      try {
        const updated = await api<Alert>(`/alerts/${id}/resolve`, {
          method: 'PATCH',
          body: JSON.stringify({ resolutionNote }),
        });
        setAlerts((previous) =>
          previous.map((item) => (item.id === updated.id ? updated : item)),
        );
        return updated;
      } catch (err) {
        setAlerts(before);
        await refresh().catch(() => undefined);
        throw err;
      }
    },
    [refresh],
  );

  return {
    alerts,
    connected,
    error,
    acknowledge,
    resolve,
    refresh,
    lastNewAlertId,
    lastEscalationFailure,
  };
}
