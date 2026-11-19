import { useEffect, useState } from 'react';
import { clearSession, getStoredUser, getToken } from './api/client';
import { unregisterPushToken } from './services/push';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import Leaves from './pages/Leaves';
import type { AppView } from './components/AppHeader';

/**
 * Three-view shell. Deliberately NOT react-router: the dashboard has three
 * real routes plus the /alerts/:id deep link the service worker opens, and
 * adding a router dependency for that is not worth the bundle or the upgrade
 * surface. History and Leaves are paths (`/history`, `/leaves`) so refresh and
 * back work.
 */
function viewFromPath(): AppView {
  if (window.location.pathname === '/history') return 'history';
  if (window.location.pathname === '/leaves') return 'leaves';
  return 'board';
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(getToken()));
  const [view, setView] = useState<AppView>(viewFromPath);

  useEffect(() => {
    const onPopState = () => setView(viewFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (next: AppView) => {
    const path = next === 'history' ? '/history' : next === 'leaves' ? '/leaves' : '/';
    window.history.pushState(null, '', path);
    setView(next);
  };

  const handleLogout = () => {
    // Remove this browser's push registration before dropping the session.
    // Push cleanup failing must never block logout — clearSession always runs.
    void unregisterPushToken()
      .catch(() => undefined)
      .finally(clearSession);
    setAuthenticated(false);
    navigate('board');
  };

  if (!authenticated) {
    return <Login onLogin={() => setAuthenticated(true)} />;
  }

  const userName = getStoredUser()?.name ?? 'Warden';

  return view === 'history' ? (
    <History userName={userName} onNavigate={navigate} onLogout={handleLogout} />
  ) : view === 'leaves' ? (
    <Leaves userName={userName} onNavigate={navigate} onLogout={handleLogout} />
  ) : (
    <Dashboard userName={userName} onNavigate={navigate} onLogout={handleLogout} />
  );
}
