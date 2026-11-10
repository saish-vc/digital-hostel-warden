import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, api, fetchAlerts, getToken } from '../api/client';
import type { Alert } from '../api/client';
import { playBeepForAlert } from '../lib/beep';

/** Dry-run aid; absent from a production build so no timer runs there. */
export const DEBUG_ESCALATION = import.meta.env.VITE_DEBUG_ESCALATION === 'true';

/** Must match the backend's ESCALATION_DELAY_MS. Visual only — see below. */
export const ESCALATION_WINDOW_S = Number(
  import.meta.env.VITE_ESCALATION_WINDOW_S ?? 60,
);

interface EscalationEvent {
  alertId: string;
  sentAt: string;
  outcome: 'sent' | 'failed';
}

/**
 * Live socket feed for the warden board.
 *
 * Server contract: `alert:new` goes to the `wardens` room, `alert:updated` to
 * `wardens` + `student:{id}`, and `alert:escalated` / `alert:escalation-failed`
 * carry the worker's REAL SMS outcome (the pill no longer guesses at 60s).
 * Exposed state:
 *
 * - `connected`  — socket transport state (feeds the ConnectionIndicator)
 * - `error`      — last connect/fetch error (a red indicator, not a toast)
 * - `refresh`    — re-runs GET /alerts (the header's Refresh button)
 * - `lastNewAlertId` — the id of the newest `alert:new`, so the board can
 *                      scroll to + flash that card exactly once
 * - `escalationUnconfirmed` — PENDING alerts past the window with no word from
 *                             the worker. Debug-only, always 0 in production.
 */
export function useAlertSocket() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastNewAlertId, setLastNewAlertId] = useState<string | null>(null);
  const [escalationUnconfirmed, setEscalationUnconfirmed] = useState(0);

  // Read synchronously by resolve() to roll back an optimistic update.
  const alertsRef = useRef<Alert[]>([]);
  alertsRef.current = alerts;

  const refresh = useCallback(async () => {
    const data = await fetchAlerts();
    // Keep the worker-reported outcome across a manual refresh: the API
    // cannot return it, so dropping it would reset a confirmed pill to
    // "unconfirmed".
    const known = new Map(alertsRef.current.map((item) => [item.id, item]));
    setAlerts(
      data.map((alert) => {
        const prior = known.get(alert.id);
        return prior
          ? {
              ...alert,
              escalatedAt: prior.escalatedAt ?? null,
              escalationFailedAt: prior.escalationFailedAt ?? null,
            }
          : alert;
      }),
    );
    setError(null);
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let cancelled = false;

    refresh().catch((err: Error) => {
      if (!cancelled) setError(err.message);
    });

    const socket = io(API_URL, {
      auth: { token },
      // WebSocket-only is a deliberate deployment decision:
      //  - no HTTP long-polling fallback => no sticky-session requirement at
      //    the load balancer (see backend/nginx.conf);
      //  - one TCP connection pinned to one instance for its lifetime, so the
      //    Redis adapter handles cross-instance fan-out;
      //  - the hostel network is closed and known, so the polling fallback
      //    buys nothing for the demo.
      transports: ['websocket'],
    });

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

    socket.on('alert:updated', (alert: Alert) => {
      setAlerts((previous) =>
        previous.map((item) =>
          item.id === alert.id
            ? {
                ...alert,
                // The API has no column for these, so an authoritative
                // update must not erase what the worker already told us.
                escalatedAt: item.escalatedAt ?? null,
                escalationFailedAt: item.escalationFailedAt ?? null,
              }
            : item,
        ),
      );
    });

    socket.on('alert:escalated', (event: EscalationEvent) => {
      setAlerts((previous) =>
        previous.map((item) =>
          item.id === event.alertId
            ? { ...item, escalatedAt: event.sentAt, escalationFailedAt: null }
            : item,
        ),
      );
    });

    socket.on('alert:escalation-failed', (event: EscalationEvent) => {
      setAlerts((previous) =>
        previous.map((item) =>
          item.id === event.alertId
            ? { ...item, escalationFailedAt: event.sentAt }
            : item,
        ),
      );
    });

    return () => {
      cancelled = true;
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
          previous.map((item) =>
            item.id === updated.id
              ? {
                  ...updated,
                  escalatedAt: item.escalatedAt ?? null,
                  escalationFailedAt: item.escalationFailedAt ?? null,
                }
              : item,
          ),
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

  // Dry-run counter: how many PENDING alerts are past the window with no word
  // from the worker. Gated so a production build never runs this interval.
  useEffect(() => {
    if (!DEBUG_ESCALATION) {
      return;
    }
    const count = () => {
      const cutoff = Date.now() - ESCALATION_WINDOW_S * 1000;
      setEscalationUnconfirmed(
        alertsRef.current.filter(
          (alert) =>
            alert.status === 'PENDING' &&
            new Date(alert.createdAt).getTime() <= cutoff &&
            !alert.escalatedAt &&
            !alert.escalationFailedAt,
        ).length,
      );
    };
    count();
    const timer = window.setInterval(count, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return {
    alerts,
    connected,
    error,
    acknowledge,
    resolve,
    refresh,
    lastNewAlertId,
    escalationUnconfirmed,
  };
}
