import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  fetchActiveLeaves,
  fetchLeaveStats,
  fetchLeaves,
  fetchOverdueLeaves,
  recordGateDeparture,
  recordGateReturn,
  reviewLeave,
  type LeaveRequest,
  type LeaveStats,
} from '../api/client';
import AppHeader, { type AppView } from '../components/AppHeader';
import { useLeaveSocket } from '../hooks/useLeaveSocket';

interface LeavesProps {
  userName: string;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
}

type Tab = 'pending' | 'approved' | 'away' | 'overdue' | 'history';
type HistoryFilter = 'ALL' | 'REJECTED' | 'CANCELLED' | 'RETURNED';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'pending', label: 'Pending approvals' },
  { id: 'approved', label: 'Approved passes' },
  { id: 'away', label: 'Currently away' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'history', label: 'History & filters' },
];

const HISTORY_FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'REJECTED', label: 'Rejected' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'RETURNED', label: 'Returned' },
];

const LEAVE_TYPES: Record<string, string> = {
  DAY_OUTING: 'Day outing',
  NIGHT_OUT: 'Night out',
  HOME_VISIT: 'Home visit',
  MEDICAL: 'Medical',
};

const STATUS_STYLES: Record<string, string> = {
  SUBMITTED: 'bg-amber-500/15 text-amber-300 border-amber-700',
  APPROVED: 'bg-emerald-500/15 text-emerald-300 border-emerald-700',
  DEPARTED: 'bg-sky-500/15 text-sky-300 border-sky-700',
  OVERDUE: 'bg-red-500/20 text-red-300 border-red-700',
  RETURNED: 'bg-slate-600/20 text-slate-300 border-slate-600',
  REJECTED: 'bg-red-500/15 text-red-300 border-red-800',
  CANCELLED: 'bg-slate-700/30 text-slate-400 border-slate-700',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "1h 20m late" for an overdue return, "—" otherwise. */
function lateBy(expectedReturn: string): string {
  const diff = Date.now() - new Date(expectedReturn).getTime();
  if (diff <= 0) return '—';
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m late` : `${rest}m late`;
}

export default function Leaves({ userName, onNavigate, onLogout }: LeavesProps) {
  const [tab, setTab] = useState<Tab>('pending');
  const [stats, setStats] = useState<LeaveStats | null>(null);
  const [pending, setPending] = useState<LeaveRequest[]>([]);
  const [approved, setApproved] = useState<LeaveRequest[]>([]);
  const [away, setAway] = useState<LeaveRequest[]>([]);
  const [overdue, setOverdue] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Requests that arrived over the socket while the warden was looking at a
  // tab that cannot show them. Never let a submission go unseen.
  const [newRequests, setNewRequests] = useState(0);

  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('ALL');
  const [historyRows, setHistoryRows] = useState<LeaveRequest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [decisionTarget, setDecisionTarget] = useState<LeaveRequest | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [decisionBusy, setDecisionBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);

  const [gateOpen, setGateOpen] = useState(false);
  const [gateCode, setGateCode] = useState('');
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [nextStats, submitted, approvedPasses, active, overdueRows] = await Promise.all([
        fetchLeaveStats(),
        fetchLeaves({ status: 'SUBMITTED' }),
        fetchLeaves({ status: 'APPROVED' }),
        fetchActiveLeaves(),
        fetchOverdueLeaves(),
      ]);
      setStats(nextStats);
      setPending(submitted.data);
      setApproved(approvedPasses.data);
      setAway(active);
      setOverdue(overdueRows);
      // Another warden may have cleared the queue; the banner must not keep
      // claiming "N waiting" once nothing is pending.
      if (submitted.data.length === 0) setNewRequests(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load leave requests');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (filter: HistoryFilter) => {
    setHistoryLoading(true);
    try {
      const result = await fetchLeaves({
        status: filter === 'ALL' ? undefined : filter,
        limit: 100,
      });
      setHistoryRows(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load leave history');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadHistory(historyFilter);
  }, [historyFilter, loadHistory]);

  // Live board: the server emits every leave transition to the wardens room.
  useLeaveSocket((event) => {
    if (event === 'created') setNewRequests((count) => count + 1);
    void load(false);
    void loadHistory(historyFilter);
  });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (kind: 'success' | 'error', text: string) => setToast({ kind, text });

  function selectTab(next: Tab) {
    setTab(next);
    if (next === 'pending') setNewRequests(0);
  }

  function openDecision(leave: LeaveRequest) {
    setDecisionTarget(leave);
    setDecisionNote(leave.reviewRemarks ?? '');
  }

  async function decide(status: 'APPROVED' | 'REJECTED') {
    if (!decisionTarget) return;
    setDecisionBusy(status);
    try {
      const updated = await reviewLeave(
        decisionTarget.id,
        status,
        decisionNote.trim() || undefined,
      );
      showToast(
        'success',
        status === 'APPROVED'
          ? `Approved ${decisionTarget.student.name} — gate pass ${updated.gatePassCode ?? 'issued'}.`
          : `Rejected ${decisionTarget.student.name}'s request.`,
      );
      setDecisionTarget(null);
      setDecisionNote('');
      await load(false);
      void loadHistory(historyFilter);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setDecisionBusy(null);
    }
  }

  async function recordReturn(leave: LeaveRequest) {
    setBusyId(leave.id);
    try {
      await recordGateReturn(leave.id);
      showToast('success', `${leave.student.name} is back in the hostel.`);
      await load(false);
      void loadHistory(historyFilter);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not record the return');
    } finally {
      setBusyId(null);
    }
  }

  function openGateModal(code?: string) {
    setGateCode(code ?? '');
    setGateError(null);
    setGateOpen(true);
  }

  async function submitGate(event: FormEvent) {
    event.preventDefault();
    const code = gateCode.trim().toUpperCase();
    if (!code) {
      setGateError('Enter the gate pass code (HG-XXXXXX).');
      return;
    }

    setGateBusy(true);
    setGateError(null);
    try {
      // Departure: the pass must be APPROVED.
      const approvedRows =
        approved.length > 0 ? approved : (await fetchLeaves({ status: 'APPROVED' })).data;
      const departing = approvedRows.find(
        (leave) => (leave.gatePassCode ?? '').toUpperCase() === code,
      );

      if (departing) {
        await recordGateDeparture(departing.id, code);
        showToast(
          'success',
          `Departure recorded for ${departing.student.name} (Room ${departing.student.roomNumber}).`,
        );
        setGateOpen(false);
        setGateCode('');
        await load(false);
        void loadHistory(historyFilter);
        return;
      }

      // Return: the pass may belong to a DEPARTED or OVERDUE leave.
      const awayRows = [...away, ...overdue];
      const returning = awayRows.find(
        (leave) => (leave.gatePassCode ?? '').toUpperCase() === code,
      );

      if (returning) {
        await recordGateReturn(returning.id);
        showToast('success', `Return recorded for ${returning.student.name}.`);
        setGateOpen(false);
        setGateCode('');
        await load(false);
        void loadHistory(historyFilter);
        return;
      }

      setGateError(`No approved or away leave matches ${code}. Check the code and try again.`);
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Could not verify the gate pass');
    } finally {
      setGateBusy(false);
    }
  }

  const rows =
    tab === 'pending'
      ? pending
      : tab === 'approved'
        ? approved
        : tab === 'away'
          ? away
          : tab === 'overdue'
            ? overdue
            : historyRows;

  const showSpinner = tab === 'history' ? historyLoading : loading;

  return (
    <div className="min-h-screen bg-slate-950">
      <AppHeader current="leaves" userName={userName} onNavigate={onNavigate} onLogout={onLogout}>
        <button
          type="button"
          onClick={() => openGateModal()}
          className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-600"
        >
          Gate check
        </button>
        <button
          type="button"
          onClick={() => {
            void load();
            void loadHistory(historyFilter);
          }}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          Refresh
        </button>
      </AppHeader>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Pending approvals"
            value={stats?.pendingApprovals ?? pending.length}
            accent="text-amber-300"
            active={tab === 'pending'}
            onClick={() => selectTab('pending')}
          />
          <StatCard
            label="Approved passes"
            value={stats?.approvedPasses ?? approved.length}
            accent="text-emerald-300"
            active={tab === 'approved'}
            onClick={() => selectTab('approved')}
          />
          <StatCard
            label="Currently away"
            value={stats?.currentlyAway ?? away.length}
            accent="text-sky-300"
            active={tab === 'away'}
            onClick={() => selectTab('away')}
          />
          <StatCard
            label="Overdue"
            value={stats?.overdueCount ?? overdue.length}
            accent="text-red-300"
            active={tab === 'overdue'}
            onClick={() => selectTab('overdue')}
          />
        </div>

        {newRequests > 0 && (
          <div
            role="alert"
            data-testid="new-leave-banner"
            className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-3 text-sm text-amber-100"
          >
            <p className="font-medium">
              🔔 {newRequests} new leave request{newRequests === 1 ? '' : 's'} waiting for review
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => selectTab('pending')}
                className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-600"
              >
                Review
              </button>
              <button
                type="button"
                onClick={() => setNewRequests(0)}
                aria-label="Dismiss new-leave banner"
                className="rounded px-2 text-amber-300 hover:text-amber-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => selectTab(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                tab === entry.id
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === 'history' && (
          <div className="mb-4 flex flex-wrap gap-2" aria-label="History status filter">
            {HISTORY_FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setHistoryFilter(entry.id)}
                aria-pressed={historyFilter === entry.id}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  historyFilter === entry.id
                    ? 'border-slate-500 bg-slate-800 text-white'
                    : 'border-slate-700 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}

        {toast && (
          <p
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              toast.kind === 'success'
                ? 'border-emerald-800 bg-emerald-950/50 text-emerald-200'
                : 'border-red-800 bg-red-950/50 text-red-200'
            }`}
            role="status"
          >
            {toast.text}
          </p>
        )}

        {error && (
          <p className="mb-4 rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200">
            {error}
          </p>
        )}

        {showSpinner ? (
          <p className="py-16 text-center text-slate-400">Loading leave requests…</p>
        ) : rows.length === 0 ? (
          <EmptyState tab={tab} historyFilter={historyFilter} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Student</th>
                  <th className="px-4 py-3">Room</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Destination</th>
                  <th className="px-4 py-3">Departure</th>
                  <th className="px-4 py-3">Expected return</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {rows.map((leave) => (
                  <tr key={leave.id} className={leave.status === 'OVERDUE' ? 'bg-red-950/20' : ''}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-white">{leave.student.name}</p>
                      <p className="max-w-[220px] truncate text-xs text-slate-500" title={leave.reason}>
                        {leave.reason}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{leave.student.roomNumber}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {LEAVE_TYPES[leave.type] ?? leave.type}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{leave.destination}</td>
                    <td className="px-4 py-3 text-slate-300">{formatDateTime(leave.departureTime)}</td>
                    <td className="px-4 py-3">
                      <p className="text-slate-300">{formatDateTime(leave.expectedReturn)}</p>
                      {(leave.status === 'OVERDUE' || leave.status === 'DEPARTED') && (
                        <p className="text-xs text-red-300">{lateBy(leave.expectedReturn)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{formatDateTime(leave.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${
                          STATUS_STYLES[leave.status] ?? STATUS_STYLES.CANCELLED
                        }`}
                      >
                        {leave.status}
                      </span>
                      {leave.gatePassCode && (
                        <p className="mt-1 font-mono text-xs text-slate-400">{leave.gatePassCode}</p>
                      )}
                      {leave.reviewRemarks && (
                        <p className="mt-1 max-w-[220px] truncate text-xs text-amber-300" title={leave.reviewRemarks}>
                          {leave.reviewRemarks}
                        </p>
                      )}
                      {leave.reviewer && (
                        <p className="mt-1 text-xs text-slate-500">by {leave.reviewer.name}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {tab === 'pending' && (
                          <button
                            type="button"
                            onClick={() => openDecision(leave)}
                            className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-600"
                          >
                            Review
                          </button>
                        )}
                        {tab === 'approved' && (
                          <button
                            type="button"
                            onClick={() => openGateModal(leave.gatePassCode ?? '')}
                            className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-600"
                          >
                            Record departure
                          </button>
                        )}
                        {(tab === 'away' || tab === 'overdue') && (
                          <button
                            type="button"
                            disabled={busyId === leave.id}
                            onClick={() => void recordReturn(leave)}
                            className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-600 disabled:opacity-50"
                          >
                            Record return
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Decision dialog: details + optional note + both decisions */}
      {decisionTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6">
            <h2 className="text-lg font-bold text-white">Review leave request</h2>
            <p className="mt-1 text-sm text-slate-400">
              {decisionTarget.student.name} · Room {decisionTarget.student.roomNumber} ·{' '}
              {LEAVE_TYPES[decisionTarget.type] ?? decisionTarget.type}
            </p>

            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Destination</dt>
                <dd className="text-slate-200">{decisionTarget.destination}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Contact</dt>
                <dd className="text-slate-200">{decisionTarget.emergencyContact}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Departure</dt>
                <dd className="text-slate-200">{formatDateTime(decisionTarget.departureTime)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Expected return</dt>
                <dd className="text-slate-200">{formatDateTime(decisionTarget.expectedReturn)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs uppercase tracking-wide text-slate-500">Reason</dt>
                <dd className="text-slate-200">{decisionTarget.reason}</dd>
              </div>
            </dl>

            <label className="mt-4 block text-sm text-slate-300">
              <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
                Decision note (optional, shown to the student)
              </span>
              <textarea
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                rows={3}
                maxLength={500}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                placeholder="e.g. Guardian consent not on file"
              />
            </label>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDecisionTarget(null);
                  setDecisionNote('');
                }}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={decisionBusy !== null}
                onClick={() => void decide('REJECTED')}
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-50"
              >
                {decisionBusy === 'REJECTED' ? 'Rejecting…' : 'Reject request'}
              </button>
              <button
                type="button"
                disabled={decisionBusy !== null}
                onClick={() => void decide('APPROVED')}
                className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
              >
                {decisionBusy === 'APPROVED' ? 'Approving…' : 'Approve & issue pass'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gate verification */}
      {gateOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={(event) => void submitGate(event)}
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6"
          >
            <h2 className="text-lg font-bold text-white">Gate verification</h2>
            <p className="mt-1 text-sm text-slate-400">
              Enter the student's HG-XXXXXX gate pass code. An approved pass records departure; a
              pass already away records the return.
            </p>
            <label className="mt-4 block text-sm text-slate-300">
              <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
                Gate pass code
              </span>
              <input
                autoFocus
                value={gateCode}
                onChange={(event) => setGateCode(event.target.value.toUpperCase())}
                placeholder="HG-1A2B3C"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-lg tracking-widest text-white"
              />
            </label>
            {gateError && <p className="mt-3 text-sm text-red-300">{gateError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setGateOpen(false)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={gateBusy}
                className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
              >
                {gateBusy ? 'Checking…' : 'Verify & record'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  active,
  onClick,
}: {
  label: string;
  value: number;
  accent: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-left transition ${
        active
          ? 'border-slate-600 bg-slate-800'
          : 'border-slate-800 bg-slate-900 hover:border-slate-700'
      }`}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent}`}>{value}</p>
    </button>
  );
}

function EmptyState({ tab, historyFilter }: { tab: Tab; historyFilter: HistoryFilter }) {
  const copy: Record<Tab, string> = {
    pending: 'No leave requests waiting for review.',
    approved: 'No approved passes waiting at the gate.',
    away: 'Everyone is inside the hostel right now.',
    overdue: 'No student is past their expected return.',
    history:
      historyFilter === 'ALL'
        ? 'No leave requests have been reviewed or cancelled yet.'
        : `No ${historyFilter.toLowerCase()} leave requests.`,
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 px-6 py-16 text-center">
      <p className="text-slate-300">{copy[tab]}</p>
    </div>
  );
}
