import { useEffect, useMemo, useRef, useState } from 'react';
import { getStoredUser } from '../api/client';
import { useAlertSocket } from '../hooks/useAlertSocket';
import { playBeepForAlert, unlockAudio } from '../lib/beep';
import {
  observeForegroundMessages,
  registerPushToken,
  type PushStatus,
} from '../services/push';
import AlertMap from '../components/AlertMap';
import AlertDetail from '../components/AlertDetail';
import AlertCard from '../components/AlertCard';
import AppHeader, { type AppView } from '../components/AppHeader';
import ConnectionIndicator from '../components/ConnectionIndicator';

interface DashboardProps {
  userName: string;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
}

const PUSH_BANNER_HELP_URL =
  'https://support.google.com/chrome/answer/3265952'; // notification settings (covers FF/Safari variants too)

type Filter = 'active' | 'resolved' | 'all';

const FILTER_KEY = 'hostel.alertFilter';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

function readStoredFilter(): Filter {
  const raw = localStorage.getItem(FILTER_KEY);
  return raw === 'active' || raw === 'resolved' || raw === 'all' ? raw : 'active';
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/** Map the push status union to the header indicator. */
function pushIndicator(status: PushStatus): { dot: string; label: string } {
  switch (status) {
    case 'granted':
      return { dot: 'bg-emerald-500', label: 'Push: active' };
    case 'granted-error':
      return { dot: 'bg-amber-500', label: 'Push: registration error' };
    case 'denied':
      return { dot: 'bg-red-500', label: 'Push: blocked' };
    case 'default':
      return { dot: 'bg-amber-500', label: 'Push: not enabled' };
    case 'unsupported':
      return { dot: 'bg-slate-600', label: 'Push: not supported' };
  }
}

/** Read /alerts/{id} out of the URL left by a notification-click deep link. */
function alertIdFromRoute(): string | null {
  const match = window.location.pathname.match(/^\/alerts\/([A-Za-z0-9-]+)\/?$/);
  if (match && match[1]) {
    // Normalize for the SPA: remove the path once consumed.
    window.history.replaceState(null, '', '/');
    return match[1];
  }
  return null;
}

export default function Dashboard({ userName, onNavigate, onLogout }: DashboardProps) {
  const {
    alerts,
    connected,
    error,
    acknowledge,
    resolve,
    refresh,
    lastNewAlertId,
    lastEscalationFailure,
  } = useAlertSocket();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [filter, setFilter] = useState<Filter>(readStoredFilter);
  const [flashId, setFlashId] = useState<string | null>(null);
  // New PENDING alerts that arrived while the Resolved tab hid them.
  const [unseenIds, setUnseenIds] = useState<string[]>([]);
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null);
  const [escalationToast, setEscalationToast] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);
  /**
   * A just-resolved case stays in the detail panel even though it leaves the
   * Active list, so the warden can read back the note they just filed.
   */
  const [justResolvedId, setJustResolvedId] = useState<string | null>(null);

  // Read inside the alert:new effect without re-running it on a tab change.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  // --- Push state ---------------------------------------------------------
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushBannerDismissed, setPushBannerDismissed] = useState(false);
  const [toast, setToast] = useState<{ alertId: string; text: string } | null>(null);
  const routeAlertId = useRef<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const storedUser = getStoredUser();
  const displayName = storedUser?.name ?? userName;

  const indicator = pushStatus ? pushIndicator(pushStatus) : null;

  // Filter persistence (J6) — a warden's tab choice survives a refresh.
  useEffect(() => {
    localStorage.setItem(FILTER_KEY, filter);
  }, [filter]);

  // Push registration on mount: refreshes lastSeenAt and re-registers a
  // rotated token. registerPushToken dedupes itself, so this is cheap.
  useEffect(() => {
    let cancelled = false;
    registerPushToken()
      .then((status) => {
        if (!cancelled) setPushStatus(status);
      })
      .catch(() => {
        if (!cancelled) setPushStatus('granted-error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep link: a notification opened a fresh tab at /alerts/{id}. Capture it
  // once; it is applied as soon as the alert list contains the id.
  useEffect(() => {
    if (routeAlertId.current === null) {
      routeAlertId.current = alertIdFromRoute();
    }
  }, []);

  // Message from the service worker: an existing tab was focused after a
  // notification click — select the alert it refers to.
  useEffect(() => {
    function onWorkerMessage(event: MessageEvent) {
      if (
        event.data?.type === 'push:open-alert' &&
        typeof event.data.alertId === 'string'
      ) {
        setSelectedId(event.data.alertId as string);
      }
    }
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
  }, []);

  // Foreground FCM payload (tab visible): the SDK never shows an OS
  // notification in this state, so surface it as a toast + beep instead.
  // playBeepForAlert dedupes against the socket path, so one alert = one beep.
  useEffect(() => {
    observeForegroundMessages((payload) => {
      const data = payload.data ?? {};
      if (!data.alertId) {
        return;
      }
      setToast({
        alertId: data.alertId,
        text: payload.notification?.body ?? 'New alert received',
      });
      setSelectedId(data.alertId);
      playBeepForAlert(data.alertId);
    });
  }, []);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // A new SOS must never be silently swallowed by the current tab. Where the
  // tab can show it we scroll + flash; the Resolved tab cannot show a PENDING
  // row, so it keeps the operator's view and raises a banner instead.
  useEffect(() => {
    if (!lastNewAlertId) {
      return;
    }

    if (filterRef.current === 'resolved') {
      setUnseenIds((ids) => (ids.includes(lastNewAlertId) ? ids : [lastNewAlertId, ...ids]));
      return;
    }

    setScrollTargetId(lastNewAlertId);
  }, [lastNewAlertId]);

  // Runs after the target card has rendered (the tab switch from the banner's
  // View lands here one render later than the click).
  useEffect(() => {
    if (!scrollTargetId) {
      return;
    }
    const node = cardRefs.current.get(scrollTargetId);
    if (!node) {
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
    setFlashId(scrollTargetId);
    setScrollTargetId(null);
  }, [scrollTargetId, filter, alerts]);

  useEffect(() => {
    if (!flashId) {
      return;
    }
    const timer = window.setTimeout(() => setFlashId(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  // A failed escalation SMS is a safety event: no pill, and a toast that
  // stays until the warden dismisses it.
  useEffect(() => {
    if (!lastEscalationFailure) {
      return;
    }
    const alert = alertsRef.current.find((item) => item.id === lastEscalationFailure.alertId);
    const who = alert ? `${alert.student.name} (Room ${alert.student.roomNumber})` : 'an alert';
    setEscalationToast(
      `Escalation SMS failed for ${who} at ${new Date(lastEscalationFailure.at).toLocaleTimeString()}. Contact the guardian manually.`,
    );
  }, [lastEscalationFailure]);

  // Auto-dismiss the action toast (resolve success / failure).
  useEffect(() => {
    if (!actionToast) {
      return;
    }
    const timer = window.setTimeout(() => setActionToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [actionToast]);

  /** Switching to a tab that shows PENDING means the backlog has been seen. */
  function changeFilter(next: Filter) {
    setFilter(next);
    setJustResolvedId(null);
    if (next !== 'resolved') {
      setUnseenIds([]);
    }
  }

  function viewUnseen(id: string) {
    changeFilter('active');
    setSelectedId(id);
    setScrollTargetId(id);
  }

  // Another warden may acknowledge an unseen alert before this one looks.
  const unseenPending = unseenIds.filter((id) =>
    alerts.some((alert) => alert.id === id && alert.status === 'PENDING'),
  );

  const activeCount = alerts.filter((alert) => alert.status === 'PENDING').length;
  const respondingCount = alerts.filter(
    (alert) => alert.status === 'ACKNOWLEDGED',
  ).length;
  const resolvedTodayCount = alerts.filter(
    (alert) => alert.status === 'RESOLVED' && isToday(alert.resolvedAt),
  ).length;

  const visibleAlerts = useMemo(
    () =>
      alerts.filter((alert) => {
        if (filter === 'all') return true;
        if (filter === 'resolved') return alert.status === 'RESOLVED';
        return alert.status !== 'RESOLVED';
      }),
    [alerts, filter],
  );

  const tabCount = (id: Filter): number => {
    if (id === 'all') return alerts.length;
    if (id === 'resolved') return alerts.filter((a) => a.status === 'RESOLVED').length;
    return alerts.filter((a) => a.status !== 'RESOLVED').length;
  };

  // Keep a selection that is visible under the current tab; otherwise fall
  // back to the newest visible alert.
  useEffect(() => {
    if (routeAlertId.current && alerts.some((alert) => alert.id === routeAlertId.current)) {
      setSelectedId(routeAlertId.current);
      routeAlertId.current = null;
      return;
    }

    if (
      selectedId !== null &&
      selectedId === justResolvedId &&
      alerts.some((alert) => alert.id === selectedId)
    ) {
      return;
    }

    if (selectedId === null || !visibleAlerts.some((alert) => alert.id === selectedId)) {
      if (visibleAlerts.length > 0) {
        setSelectedId(visibleAlerts[0].id);
      }
    }
  }, [alerts, visibleAlerts, selectedId, justResolvedId]);

  const selectedAlert =
    visibleAlerts.find((alert) => alert.id === selectedId) ??
    (selectedId !== null && selectedId === justResolvedId
      ? (alerts.find((alert) => alert.id === selectedId) ?? null)
      : null);

  function selectAlert(id: string) {
    setSelectedId(id);
    if (id !== justResolvedId) {
      setJustResolvedId(null);
    }
  }

  const connectionState = error ? 'error' : connected ? 'live' : 'reconnecting';

  async function handleAcknowledge(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await acknowledge(id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not acknowledge alert');
    } finally {
      setBusyId(null);
    }
  }

  async function handleResolve(id: string, resolutionNote: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await resolve(id, resolutionNote);
      setJustResolvedId(id);
      setSelectedId(id);
      setActionToast({ kind: 'success', text: 'Case resolved' });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not resolve alert';
      setActionToast({
        kind: 'error',
        text: `Resolve failed: ${message}. The board was refreshed.`,
      });
    } finally {
      setBusyId(null);
    }
  }

  const emptyMessage =
    filter === 'resolved'
      ? {
          title: 'No resolved alerts',
          body: 'Cases closed by a warden will appear here with their resolution notes.',
        }
      : filter === 'all'
        ? {
            title: 'No alerts yet',
            body: 'This board updates automatically when a student presses SOS.',
          }
        : {
            title: 'No active alerts',
            body: 'All clear. New SOS alerts appear here the moment a student presses the button.',
          };

  return (
    <div className="min-h-screen bg-slate-950">
      <AppHeader
        current="board"
        userName={displayName}
        onNavigate={onNavigate}
        onLogout={onLogout}
      >
        <ConnectionIndicator state={connectionState} />

        {indicator && (
          <span
            className="flex items-center gap-2 text-xs text-slate-300"
            title="Browser push notification status"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${indicator.dot}`} />
            {indicator.label}
          </span>
        )}

        <button
          type="button"
          onClick={() => {
            void refresh().catch(() => undefined);
          }}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          Refresh
        </button>

        <button
          type="button"
          onClick={() => {
            unlockAudio();
            setSoundOn(true);
          }}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            soundOn
              ? 'border-emerald-700 text-emerald-300'
              : 'border-amber-700 text-amber-300 hover:bg-amber-950/40'
          }`}
        >
          {soundOn ? 'Alarm on' : 'Enable alarm'}
        </button>
      </AppHeader>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {/* Permission-denied banner: persistent until dismissed. */}
        {pushStatus === 'denied' && !pushBannerDismissed && (
          <div className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200">
            <p>
              Push notifications are blocked. You will only see alerts while this tab is
              open.{' '}
              <a
                href={PUSH_BANNER_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline hover:text-amber-100"
              >
                How to enable
              </a>
            </p>
            <button
              type="button"
              onClick={() => setPushBannerDismissed(true)}
              aria-label="Dismiss banner"
              className="shrink-0 rounded px-2 text-amber-300 hover:text-amber-100"
            >
              ✕
            </button>
          </div>
        )}

        {(error || actionError) && (
          <p className="mb-4 rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200">
            {actionError ?? error}
          </p>
        )}

        {/* Foreground FCM toast. No OS notification fires in this state. */}
        {toast && (
          <button
            type="button"
            onClick={() => {
              setSelectedId(toast.alertId);
              setToast(null);
            }}
            className="mb-4 block w-full rounded-lg border border-red-700 bg-red-950/60 px-4 py-3 text-left text-sm font-medium text-red-100 shadow-lg shadow-red-950/40 transition hover:bg-red-950"
          >
            🔔 New alert: {toast.text}
          </button>
        )}

        {/* A new SOS arrived under a tab that cannot show it. Keep the tab. */}
        {unseenPending.length > 0 && (
          <div
            role="alert"
            data-testid="new-pending-banner"
            className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-red-700 bg-red-950/60 px-4 py-3 text-sm text-red-100"
          >
            <p className="font-medium">
              🔔 {unseenPending.length} new pending
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => viewUnseen(unseenPending[0])}
                className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-600"
              >
                View
              </button>
              <button
                type="button"
                onClick={() => setUnseenIds([])}
                aria-label="Dismiss new-alert banner"
                className="rounded px-2 text-red-300 hover:text-red-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {escalationToast && (
          <div
            role="alert"
            data-testid="escalation-failed-toast"
            className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-red-700 bg-red-950/70 px-4 py-3 text-sm font-medium text-red-100"
          >
            <p>⚠️ {escalationToast}</p>
            <button
              type="button"
              onClick={() => setEscalationToast(null)}
              aria-label="Dismiss escalation failure"
              className="shrink-0 rounded px-2 text-red-300 hover:text-red-100"
            >
              ✕
            </button>
          </div>
        )}

        {actionToast && (
          <p
            role="status"
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              actionToast.kind === 'success'
                ? 'border-emerald-800 bg-emerald-950/50 text-emerald-200'
                : 'border-red-800 bg-red-950/50 text-red-200'
            }`}
          >
            {actionToast.text}
          </p>
        )}

        {/* Counters — clickable shortcuts into the tab that owns the number. */}
        <div className="mb-4 grid grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => changeFilter('active')}
            className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-left transition hover:bg-red-950/50"
          >
            <p className="text-xs uppercase tracking-wide text-red-300">Active</p>
            <p className="text-2xl font-bold text-white">{activeCount}</p>
          </button>
          <button
            type="button"
            onClick={() => {
              changeFilter('active');
              const firstResponding = alerts.find(
                (alert) => alert.status === 'ACKNOWLEDGED',
              );
              if (firstResponding) setSelectedId(firstResponding.id);
            }}
            className="rounded-xl border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-left transition hover:bg-amber-950/40"
          >
            <p className="text-xs uppercase tracking-wide text-amber-300">Responding</p>
            <p className="text-2xl font-bold text-white">{respondingCount}</p>
          </button>
          <button
            type="button"
            onClick={() => changeFilter('resolved')}
            className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-4 py-3 text-left transition hover:bg-emerald-950/40"
          >
            <p className="text-xs uppercase tracking-wide text-emerald-300">
              Resolved today
            </p>
            <p className="text-2xl font-bold text-white">{resolvedTodayCount}</p>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(0,1.6fr)]">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Alerts
              </h2>

              <div
                role="tablist"
                aria-label="Alert filter"
                className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1"
              >
                {FILTERS.map((option) => (
                  <button
                    key={option.id}
                    role="tab"
                    type="button"
                    aria-selected={filter === option.id}
                    onClick={() => changeFilter(option.id)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                      filter === option.id
                        ? 'bg-slate-700 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {option.label}
                    <span className="ml-1 text-slate-400">{tabCount(option.id)}</span>
                  </button>
                ))}
              </div>
            </div>

            {visibleAlerts.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-16 text-center">
                <p className="text-base font-semibold text-slate-300">
                  {emptyMessage.title}
                </p>
                <p className="mt-1 text-sm text-slate-500">{emptyMessage.body}</p>
              </div>
            )}

            {visibleAlerts.map((alert) => (
              <div
                key={alert.id}
                ref={(node) => {
                  if (node) {
                    cardRefs.current.set(alert.id, node);
                  } else {
                    cardRefs.current.delete(alert.id);
                  }
                }}
              >
                <AlertCard
                  alert={alert}
                  selected={alert.id === selectedId}
                  flash={flashId === alert.id}
                  onSelect={selectAlert}
                />
              </div>
            ))}
          </section>

          <section className="space-y-4">
            <AlertMap alert={selectedAlert} />
            <AlertDetail
              alert={selectedAlert}
              busy={busyId === selectedId}
              onAcknowledge={handleAcknowledge}
              onResolve={handleResolve}
            />
          </section>
        </div>
      </main>
    </div>
  );
}
