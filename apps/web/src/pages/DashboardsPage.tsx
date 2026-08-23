/**
 * Dashboard index, plus the cache panel.
 *
 * The cache stats live here rather than being hidden in a debug view: the hit
 * rate and the invalidation controls are the point of the caching layer, and a
 * number nobody can see is indistinguishable from a claim.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createDashboard,
  getCacheStats,
  invalidateCache,
  listDashboards,
  simulateOrders,
} from '../lib/api.js';
import { formatBytes, formatRelativeTime } from '../lib/format.js';

export function DashboardsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const { data, error, isPending } = useQuery({
    queryKey: ['dashboards'],
    queryFn: listDashboards,
  });

  const create = useMutation({
    mutationFn: () =>
      createDashboard({ name: name.trim(), description: description.trim() || null }),
    onSuccess: () => {
      setCreating(false);
      setName('');
      setDescription('');
      void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    },
  });

  return (
    <>
      <header className="page__header">
        <div>
          <h1 className="page__title">Dashboards</h1>
          <p className="page__subtitle">
            Saved collections of widgets, each backed by a stored query spec.
          </p>
        </div>
        <div className="page__actions">
          <Link className="btn" to="/explore">
            Query builder
          </Link>
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            New dashboard
          </button>
        </div>
      </header>

      {error && (
        <div className="notice notice--error" style={{ marginBottom: '1rem' }}>
          {error instanceof ApiError ? error.message : 'Could not load dashboards.'}
        </div>
      )}

      {isPending && <p className="muted">Loading…</p>}

      {data && data.dashboards.length === 0 && (
        <div className="empty">
          <p>No dashboards yet.</p>
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            Create the first one
          </button>
        </div>
      )}

      {data && data.dashboards.length > 0 && (
        <div className="dash-list">
          {data.dashboards.map((dashboard) => (
            <Link className="dash-card" key={dashboard.id} to={`/dashboards/${dashboard.id}`}>
              <div className="dash-card__name">{dashboard.name}</div>
              <div className="dash-card__meta">
                {dashboard.widgetCount} widget{dashboard.widgetCount === 1 ? '' : 's'} · updated{' '}
                {formatRelativeTime(dashboard.updatedAt)}
              </div>
            </Link>
          ))}
        </div>
      )}

      <CachePanel />

      {creating && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setCreating(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="New dashboard">
            <h2 className="modal__title">New dashboard</h2>
            <div className="stack">
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="input"
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Revenue overview"
                />
              </label>
              <label className="field">
                <span className="field__label">Description (optional)</span>
                <input
                  className="input"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>

              {create.isError && (
                <div className="notice notice--error">
                  {create.error instanceof ApiError
                    ? create.error.message
                    : 'Could not create the dashboard.'}
                </div>
              )}
            </div>

            <div className="modal__actions">
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={!name.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function CachePanel() {
  const queryClient = useQueryClient();

  const { data: stats } = useQuery({
    queryKey: ['cache-stats'],
    queryFn: getCacheStats,
    refetchInterval: 10_000,
  });

  const invalidate = useMutation({
    mutationFn: () => invalidateCache(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cache-stats'] }),
  });

  const simulate = useMutation({
    mutationFn: () => simulateOrders(25),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cache-stats'] }),
  });

  if (!stats) return null;

  return (
    <section className="card" style={{ marginTop: '2rem' }}>
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <h2 className="card__title" style={{ margin: 0 }}>
          Redis query cache
        </h2>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button
            className="btn btn--sm"
            onClick={() => simulate.mutate()}
            disabled={simulate.isPending}
            title="Append 25 synthetic order lines. The cache is invalidated in the same request, and open dashboards refetch over SSE."
          >
            {simulate.isPending ? 'Inserting…' : 'Simulate 25 orders'}
          </button>
          <button
            className="btn btn--sm"
            onClick={() => invalidate.mutate()}
            disabled={invalidate.isPending}
            title="Bump every dataset's generation, making all cached results unreachable"
          >
            Invalidate all
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: '2rem' }}>
        <Stat
          label="Hit rate"
          value={stats.hitRate === null ? '—' : `${(stats.hitRate * 100).toFixed(1)}%`}
        />
        <Stat label="Hits" value={stats.hits.toLocaleString()} />
        <Stat label="Misses" value={stats.misses.toLocaleString()} />
        <Stat label="Entries" value={stats.entries.toLocaleString()} />
        <Stat label="TTL" value={`${stats.ttlSeconds}s`} />
        <Stat label="Redis memory" value={formatBytes(stats.memoryUsedBytes)} />
        <Stat
          label="Generation"
          value={Object.entries(stats.generations)
            .map(([dataset, generation]) => `${dataset} v${generation}`)
            .join(', ')}
        />
      </div>

      {simulate.isSuccess && (
        <p className="muted" style={{ marginBottom: 0, marginTop: '0.75rem' }}>
          Inserted {simulate.data.inserted} order lines. Cache generation is now v
          {simulate.data.generation} — any open dashboard has already refetched.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="field__label">{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{value}</div>
    </div>
  );
}
