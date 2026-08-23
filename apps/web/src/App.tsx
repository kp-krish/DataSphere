/**
 * App shell and routing.
 *
 * The SSE subscription is mounted here, once, so a single stream serves every
 * widget on the page. One EventSource per widget would open a connection per
 * card, and each would separately invalidate the same shared query cache.
 */

import { NavLink, Route, Routes } from 'react-router-dom';
import { useLiveUpdates } from './hooks/useLiveUpdates.js';
import { DashboardsPage } from './pages/DashboardsPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ExplorePage } from './pages/ExplorePage.js';
import { formatRelativeTime } from './lib/format.js';

const LIVE_LABEL = {
  connected: 'live',
  connecting: 'connecting',
  disconnected: 'offline',
} as const;

export default function App() {
  const { status, lastEvent } = useLiveUpdates();

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          DataSphere<span>analytics</span>
        </div>

        <nav className="topbar__nav">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `topbar__link${isActive ? ' topbar__link--active' : ''}`}
          >
            Dashboards
          </NavLink>
          <NavLink
            to="/explore"
            className={({ isActive }) => `topbar__link${isActive ? ' topbar__link--active' : ''}`}
          >
            Query builder
          </NavLink>
        </nav>

        <div className="topbar__spacer" />

        {/* Status is never colour-alone: the word carries it too. */}
        <span
          className={`live${status === 'connected' ? ' live--connected' : ''}`}
          title={
            lastEvent
              ? `Last change: ${lastEvent.reason} (${formatRelativeTime(lastEvent.at)})`
              : 'Subscribed to server-sent invalidation events'
          }
        >
          <span className="live__dot" aria-hidden="true" />
          {LIVE_LABEL[status]}
        </span>
      </header>

      <main className="page">
        <Routes>
          <Route path="/" element={<DashboardsPage />} />
          <Route path="/dashboards/:id" element={<DashboardPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route
            path="*"
            element={
              <div className="empty">
                <p>That page does not exist.</p>
                <NavLink className="btn" to="/">
                  Back to dashboards
                </NavLink>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
