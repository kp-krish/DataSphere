# DataSphere

A cloud data visualization platform. Users compose analytical queries through a
UI — no SQL — and DataSphere compiles that JSON spec into parameterised SQL,
runs it against a 2-million-row PostgreSQL star schema, caches the result in
Redis, and renders it as live dashboard widgets.

> **Status: phase 1 of 7 complete.** The infrastructure, schema and data
> generator are done and verified. The query engine, API, caching layer and
> frontend are being built in sequence — see [Roadmap](#roadmap).

---

## Architecture

```mermaid
flowchart LR
    subgraph browser["Browser"]
        UI["React + Vite<br/>Recharts · TanStack Query"]
    end

    subgraph edge["web container"]
        NGINX["nginx (unprivileged)<br/>static bundle + /api proxy"]
    end

    subgraph api["api container"]
        EXP["Express + TypeScript"]
        COMP["Query compiler<br/>@datasphere/core"]
        CACHE["Cache layer"]
    end

    subgraph data["Data services"]
        PG[("PostgreSQL 17<br/>analytics + app schemas")]
        RD[("Redis 7<br/>allkeys-lru")]
    end

    UI -->|"/api/*"| NGINX
    NGINX --> EXP
    EXP --> COMP
    COMP -->|"parameterised SQL"| PG
    EXP --> CACHE
    CACHE <--> RD
    EXP -->|"introspects"| PG
```

The **query compiler** is the security boundary. It lives in
`packages/core` as a pure, dependency-free function: a JSON query spec goes in,
`{ text, values }` comes out. Table and column names are validated against an
allowlist derived from introspecting the database, and every user-supplied
value becomes a bind parameter. Nothing is string-concatenated.

Schemas are split for the same reason:

| Schema      | Contents                                                              | Reachable by the query engine                  |
| ----------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `analytics` | `fact_orders`, `dim_date`, `dim_customer`, `dim_product`, `dim_store` | yes — the catalog introspects this schema only |
| `app`       | `dashboards`, `widgets`                                               | no                                             |

Application tables are structurally unreachable from a user-composed query,
independent of the allowlist check.

---

## Quick start

Requirements: Docker with Compose v2.

```bash
git clone https://github.com/kp-krish/DataSphere.git
cd DataSphere
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:5173>.

Boot order is enforced with healthchecks, not sleeps:

```
postgres + redis  →  init (migrate + seed)  →  api  →  web
```

The `init` service runs migrations, generates 2M rows, and exits. The API waits
on `service_completed_successfully`, so it never starts against an unmigrated
or unseeded database. First boot takes roughly a minute; subsequent boots reuse
the volume and skip seeding entirely.

For a faster first run, seed less data:

```bash
SEED_FACT_ROWS=100000 docker compose up --build
```

### Local development

```bash
npm install
docker compose up -d postgres redis   # data services only
npm run migrate
npm run seed
npm run dev:api                       # http://localhost:4000
npm run dev:web                       # http://localhost:5173
```

---

## Dataset

A classic Kimball star schema modelling e-commerce order lines.

| Table          | Rows      | On disk |
| -------------- | --------- | ------- |
| `fact_orders`  | 2,000,000 | 249 MB  |
| `dim_customer` | 50,000    | 7.5 MB  |
| `dim_product`  | 5,000     | 1.1 MB  |
| `dim_date`     | 1,826     | 288 kB  |
| `dim_store`    | 200       | 72 kB   |

The generator is deliberately not uniform, because uniformly random data makes
every filter equally selective and produces benchmark numbers that do not
survive contact with real data:

- **Power-law popularity** for customers, products and stores
- **Seasonality**: monthly and weekday demand curves over 18% compounding
  annual growth, so time series show a real trend and date-range filters vary
  in selectivity
- **Price-coherent measures**: cost clusters around per-subcategory means and
  quantity scales inversely with price. Office Supplies leads on line count and
  trails on revenue; Technology inverts it.
- **Deterministic**: a given `SEED_RANDOM_SEED` reproduces the identical
  dataset on any machine, so benchmark runs are comparable

Loading uses `COPY FROM STDIN` streamed under backpressure at ~190k rows/s in
the container, with foreign keys dropped for the load and restored afterwards.

---

## Repository layout

```
packages/core     Shared contracts + the query compiler. Zero runtime deps,
                  so it is exhaustively unit-testable without a database.
apps/api          Express + TypeScript REST API, and the migrations.
apps/web          React + Vite client.
scripts           Seeding and the benchmark harness.
```

---

## Configuration

All settings come from the environment and are validated at boot — the API
either starts with a fully typed, valid config or refuses to start. See
[`.env.example`](.env.example) for the annotated list. The ones that matter:

| Variable            | Default   | Purpose                                                        |
| ------------------- | --------- | -------------------------------------------------------------- |
| `QUERY_MAX_ROWS`    | `10000`   | Hard ceiling on rows per query; clamps any client-side `LIMIT` |
| `QUERY_TIMEOUT_MS`  | `15000`   | `statement_timeout` applied to every analytical query          |
| `CACHE_TTL_SECONDS` | `300`     | Redis TTL for cached query results                             |
| `SEED_FACT_ROWS`    | `2000000` | Fact rows to generate                                          |

No secrets are committed. `.env` is gitignored; only `.env.example` ships, and
its values are throwaway local-container credentials.

---

## Roadmap

- [x] **1** — Scaffold, compose stack, migrations, 2M-row seed
- [ ] **2** — Schema catalog + query compiler + injection tests
- [ ] **3** — REST API: catalog, query execution, dashboard/widget CRUD
- [ ] **4** — Redis caching, invalidation, hit/miss reporting
- [ ] **5** — Query builder UI, dashboard grid, all widget types
- [ ] **6** — Indexes, benchmark harness, `BENCHMARKS.md`
- [ ] **7** — CI, docs, polish

## Screenshots

_Added in phase 5, once the dashboard UI exists._

## Benchmarks

_Added in phase 6. Numbers will be whatever the runs actually produce, measured
on stated hardware under the Postgres configuration pinned in
`docker-compose.yml`._
