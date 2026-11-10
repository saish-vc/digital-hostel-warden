import type { ReactNode } from 'react';

export type AppView = 'board' | 'history';

interface AppHeaderProps {
  current: AppView;
  userName: string;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
  /** View-specific controls (connection/push indicators, alarm, refresh). */
  children?: ReactNode;
}

/**
 * Shared header: brand | Active Alerts | History | [Name] | Logout.
 * Both pages render it, so the nav can never drift between views.
 */
export default function AppHeader({
  current,
  userName,
  onNavigate,
  onLogout,
  children,
}: AppHeaderProps) {
  const tabClass = (view: AppView): string =>
    `rounded-lg px-3 py-1.5 text-sm transition ${
      current === view
        ? 'bg-slate-800 text-white'
        : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
    }`;

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-red-500">
              Hostel Emergency
            </p>
            <h1 className="text-lg font-bold text-white">Warden dashboard</h1>
          </div>

          <nav aria-label="Primary" className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onNavigate('board')}
              aria-current={current === 'board' ? 'page' : undefined}
              className={tabClass('board')}
            >
              Active Alerts
            </button>
            <button
              type="button"
              onClick={() => onNavigate('history')}
              aria-current={current === 'history' ? 'page' : undefined}
              className={tabClass('history')}
            >
              History
            </button>
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {children}
          <span className="hidden text-sm text-slate-300 sm:inline">{userName}</span>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Log out
          </button>
        </div>
      </div>
    </header>
  );
}
