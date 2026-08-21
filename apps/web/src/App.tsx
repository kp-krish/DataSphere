/**
 * Phase 1 placeholder.
 *
 * This is not the real UI - the query builder and dashboard grid arrive in
 * phase 5. What it does do is prove the deployment topology end to end:
 * browser -> nginx -> api -> postgres/redis. If this page shows both
 * dependencies up, the container wiring is correct.
 */

import { useQuery } from '@tanstack/react-query';

interface ReadyResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: {
    database: 'up' | 'down';
    cache: 'up' | 'down' | 'disabled';
  };
}

// Empty means same-origin, which is the norm: in the container nginx proxies
// /api to the API service, and in dev the Vite server proxies it. Set it only
// when the client is served from somewhere the API is not reachable from.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

async function fetchReadiness(): Promise<ReadyResponse> {
  const response = await fetch(`${API_BASE}/api/ready`);
  // /ready answers 503 with a valid body when a dependency is down, which is
  // information we want to render rather than an error to throw on.
  if (!response.ok && response.status !== 503) {
    throw new Error(`Readiness check failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ReadyResponse;
}

function StatusPill({ label, state }: { label: string; state: string }) {
  const tone = state === 'up' ? 'var(--ok)' : state === 'disabled' ? 'var(--muted)' : 'var(--bad)';
  return (
    <div className="pill">
      <span className="dot" style={{ background: tone }} />
      <span className="pill-label">{label}</span>
      <span className="pill-state">{state}</span>
    </div>
  );
}

export default function App() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: 5000,
  });

  return (
    <main className="shell">
      <header>
        <h1>DataSphere</h1>
        <p className="tagline">
          Dynamic SQL query engine over a 2M-row Postgres star schema, cached in Redis.
        </p>
      </header>

      <section className="card">
        <h2>Stack status</h2>

        {isPending && <p className="muted">Checking services…</p>}

        {isError && (
          <p className="error">
            Cannot reach the API. {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        )}

        {data && (
          <div className="pills">
            <StatusPill label="API" state="up" />
            <StatusPill label="PostgreSQL" state={data.checks.database} />
            <StatusPill label="Redis" state={data.checks.cache} />
          </div>
        )}
      </section>

      <section className="card">
        <h2>Build progress</h2>
        <ol className="phases">
          <li className="done">Scaffold, compose stack, migrations, 2M-row seed</li>
          <li>Schema catalog and query compiler</li>
          <li>REST API: catalog, query execution, dashboard CRUD</li>
          <li>Redis caching, invalidation, hit/miss reporting</li>
          <li>Query builder UI and dashboard grid</li>
          <li>Indexes, benchmark harness, BENCHMARKS.md</li>
          <li>CI, README, polish</li>
        </ol>
      </section>
    </main>
  );
}
