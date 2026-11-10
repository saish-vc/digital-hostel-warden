import { useEffect, useMemo, useState } from 'react';
import {
  downloadHistoryCsv,
  fetchHistory,
  type AlertHistoryRow,
  type HistoryPagination,
} from '../api/client';
import AppHeader, { type AppView } from '../components/AppHeader';

interface HistoryProps {
  userName: string;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
}

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'RESOLVED', label: 'Resolved' },
];

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** `from` is the start of the chosen day (UTC), `to` the end of it. */
function startOfDay(date: string): string | undefined {
  return date ? new Date(`${date}T00:00:00.000Z`).toISOString() : undefined;
}

function endOfDay(date: string): string | undefined {
  return date ? new Date(`${date}T23:59:59.999Z`).toISOString() : undefined;
}

export default function History({ userName, onNavigate, onLogout }: HistoryProps) {
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [studentName, setStudentName] = useState('');
  const [appliedName, setAppliedName] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AlertHistoryRow[]>([]);
  const [pagination, setPagination] = useState<HistoryPagination>({
    page: 1,
    limit: PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      statuses: status ? [status] : [],
      from: startOfDay(from),
      to: endOfDay(to),
      studentName: appliedName || undefined,
    }),
    [page, status, from, to, appliedName],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchHistory(query)
      .then((response) => {
        if (cancelled) return;
        setRows(response.data);
        setPagination(response.pagination);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query]);

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      // Same filters as the table, no page bound: the server streams every
      // matching row (bounded batches, not one in-memory array).
      await downloadHistoryCsv({ ...query, page: 1, limit: 100 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV export failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <AppHeader
        current="history"
        userName={userName}
        onNavigate={onNavigate}
        onLogout={onLogout}
      />

      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Alert history</h2>
            <p className="text-sm text-slate-400">
              The audit trail: every alert, who acknowledged it, how it was closed.
            </p>
          </div>

          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || rows.length === 0}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>

        <form
          className="mb-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedName(studentName.trim());
            setPage(1);
          }}
        >
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
              Status
            </span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
              From
            </span>
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>

          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
              To
            </span>
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>

          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
              Student name
            </span>
            <input
              type="search"
              value={studentName}
              onChange={(event) => setStudentName(event.target.value)}
              placeholder="e.g. Diya"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white placeholder:text-slate-600"
            />
          </label>

          <button
            type="submit"
            className="self-end rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-600"
          >
            Apply filters
          </button>
        </form>

        {error && (
          <p className="mb-4 rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200">
            {error}
          </p>
        )}

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Date/Time</th>
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Room</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Acknowledged by</th>
                <th className="px-4 py-3">Resolved at</th>
                <th className="px-4 py-3">Resolution note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                    {loading
                      ? 'Loading history…'
                      : 'No alerts match these filters. Try widening the date range.'}
                  </td>
                </tr>
              )}

              {rows.map((row) => (
                <tr key={row.id} className="align-top text-slate-200">
                  <td className="whitespace-nowrap px-4 py-3">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="px-4 py-3">{row.student.name}</td>
                  <td className="px-4 py-3">{row.student.roomNumber}</td>
                  <td className="px-4 py-3">{row.type}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                        row.status === 'RESOLVED'
                          ? 'bg-emerald-700/60 text-emerald-100'
                          : row.status === 'ACKNOWLEDGED'
                            ? 'bg-amber-700/60 text-amber-100'
                            : 'bg-red-700/60 text-red-100'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">{row.acknowledgedByName ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {formatDateTime(row.resolvedAt)}
                  </td>
                  <td className="max-w-[280px] px-4 py-3 text-slate-400">
                    {row.resolutionNote ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
          <span>
            {pagination.total} row{pagination.total === 1 ? '' : 's'} · page{' '}
            {pagination.page} of {pagination.totalPages}
          </span>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={pagination.page <= 1 || loading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={pagination.page >= pagination.totalPages || loading}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
