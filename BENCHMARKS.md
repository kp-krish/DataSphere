# Benchmarks

Measured, not estimated. Every number below was produced by `npm run benchmark`,
which runs the suite in
[`scripts/lib/bench-queries.ts`](scripts/lib/bench-queries.ts) under four
configurations and writes this file. Re-running it overwrites these numbers.

**Run:** 2026-08-23T18:28:52.351Z · 98s ·
20 measured iterations per query per configuration
(840 requests total).

---

## Headline

Median across the ten-query suite, measured end to end over HTTP:

| Configuration | p50 (ms) | p95 (ms) | vs baseline |
| ------------- | -------: | -------: | ----------- |
| No index, no cache | 136.6 | 180.1 | — |
| Cache only | 3.5 | 4.4 | −97.5% (39.3×) |
| Index only | 135.2 | 144.6 | −1.0% (1.0×) |
| Index + cache | 3.0 | 3.9 | −97.8% (45.3×) |

**That "index only" row understates what the indexes do.** The suite is
deliberately weighted towards whole-table aggregation, so the *median* query in
it is one indexes barely touch — while the best-served query in the same suite
improves 8.4× (Revenue by day, one week). A single median cannot represent a workload that
bimodal, which is why this report leads with the per-query split rather than an
average. The index numbers worth reading are further down.

---

## Method

- **Where it measures.** Wall clock around an HTTP `POST /api/query` against
  the running API — the same path a dashboard widget takes, including the round
  trip, the spec compile and the cache lookup. Measuring at the database would
  make the two cached configurations impossible to run at all.
- **What "no index" means.** The five analytical indexes are dropped and later
  restored from the definitions Postgres itself reports, so whatever the
  migration created is exactly what is removed. The primary key stays: a fact
  table without one is not a configuration anyone would deploy.
- **Warm-up.** Each query gets one discarded pass per configuration, paying for
  cold shared buffers and, where caching is on, for populating Redis. The
  reported figures are steady state; the cold cost is reported separately below
  rather than hidden.
- **Percentiles.** Nearest-rank, no interpolation — every figure is an
  observation that actually happened. With 20 samples, p95 is the
  19th slowest.
- **Suite figures** are the median across the ten queries, not a mean, so one
  expensive query does not set the headline.

---

## Per-query results

p50 in milliseconds.

| Query | Shape | Baseline | Cache only | Index only | Index + cache | Best vs baseline |
| ----- | ----- | -------: | ---------: | ---------: | ------------: | ---------------- |
| Revenue by category | `full-scan` | 292.9 | 3.9 | 243.2 | 2.9 | −99.0% (100.3×) |
| Top 10 subcategories by revenue | `full-scan` | 296.1 | 3.6 | 240.3 | 3.1 | −98.9% (95.0×) |
| Revenue and profit by channel | `full-scan` | 308.1 | 3.6 | 300.5 | 3.2 | −99.0% (97.4×) |
| Total revenue (KPI) | `full-scan` | 136.6 | 3.5 | 135.2 | 3.0 | −97.8% (46.2×) |
| Distinct customers (KPI) | `full-scan` | 526.6 | 3.5 | 137.1 | 3.0 | −99.4% (174.4×) |
| Revenue by segment and region | `full-scan` | 457.9 | 3.5 | 460.8 | 3.4 | −99.3% (134.9×) |
| Revenue for one month | `selective` | 63.8 | 3.4 | 9.8 | 3.2 | −95.0% (19.9×) |
| Revenue by day, one week | `selective` | 68.0 | 3.4 | 8.1 | 3.0 | −95.5% (22.4×) |
| Revenue by category for one store | `selective` | 66.9 | 3.4 | 18.3 | 3.0 | −95.5% (22.4×) |
| Revenue by month, one quarter | `selective` | 108.8 | 3.4 | 89.8 | 2.9 | −97.3% (37.0×) |

---

## What the indexes alone are worth

This is the part worth reading carefully, because the effect is not uniform —
and a benchmark reporting only an average would hide exactly the thing that
matters.

| Query | Shape | No index (ms) | With index (ms) | Change |
| ----- | ----- | ------------: | --------------: | ------ |
| Revenue by category | `full-scan` | 292.9 | 243.2 | −17.0% (1.2×) |
| Top 10 subcategories by revenue | `full-scan` | 296.1 | 240.3 | −18.9% (1.2×) |
| Revenue and profit by channel | `full-scan` | 308.1 | 300.5 | −2.5% (1.0×) |
| Total revenue (KPI) | `full-scan` | 136.6 | 135.2 | −1.0% (1.0×) |
| Distinct customers (KPI) | `full-scan` | 526.6 | 137.1 | −74.0% (3.8×) |
| Revenue by segment and region | `full-scan` | 457.9 | 460.8 | +0.6% (1.0×) |
| Revenue for one month | `selective` | 63.8 | 9.8 | −84.7% (6.5×) |
| Revenue by day, one week | `selective` | 68.0 | 8.1 | −88.1% (8.4×) |
| Revenue by category for one store | `selective` | 66.9 | 18.3 | −72.6% (3.6×) |
| Revenue by month, one quarter | `selective` | 108.8 | 89.8 | −17.4% (1.2×) |

Indexes alone moved 4 of the 10 queries by more than 30%: **Distinct customers (KPI)** (74%), **Revenue for one month** (85%), **Revenue by day, one week** (88%), **Revenue by category for one store** (73%). The other 6 changed by less, which at this sample size is not distinguishable from run-to-run noise.

Note which ones: **Distinct customers (KPI)** (74%) is marked `full-scan` and still improved sharply. That is worth explaining rather than waving away.

The rule that actually predicts the outcome is **not** "full scan versus
filtered" — it is **how many bytes the query has to move**. An index helps
whenever it lets Postgres read less, and there are two separate ways that
happens.

**1. Reading fewer rows.** A dashboard scoped to a month touches ~1.7% of the
table. With `fact_orders_date_key_idx` carrying the measures as `INCLUDE`
columns, Postgres answers those with an index-only scan:

```
Aggregate
  ->  Index Only Scan using fact_orders_date_key_idx
        Index Cond: ((date_key >= 20240301) AND (date_key <= 20240331))
        Heap Fetches: 0
        Buffers: shared hit=1 read=167
```

168 buffers instead of 7,968, and `Heap Fetches: 0` — the heap is never
touched.

**2. Reading narrower rows.** This is the case the obvious reasoning gets
wrong. `COUNT(DISTINCT customer_id)` must visit all two million rows, so by
the "a full scan cannot be helped" rule an index should be useless here. It is
not: the query needs exactly one 4-byte column, and the index *is* a narrow
copy of that column, so Postgres scans it instead of the heap.

```
Aggregate
  ->  Index Only Scan using fact_orders_customer_id_idx
        Heap Fetches: 25
        Buffers: shared hit=1775
```

1,775 buffers against roughly 26,000 for the heap — every row, a fraction of
the bytes.

There is a satisfying detail here. `fact_orders_customer_id_idx` is the
*smallest* index on the table despite indexing the column with the *most*
distinct values, because it is the only one without `INCLUDE` columns and so
the only one B-tree deduplication can compress. The same decision that made it
cheap to store is what makes it fast to scan.

The queries that genuinely cannot be helped are the ones needing columns no
index carries — `revenue` alongside a join key, say. Those must reach the heap
for every row, and a parallel sequential scan is already the optimal plan.

Index-only scans depend on the visibility map, which is why the seed runs
`VACUUM` after loading. Without it Postgres cannot prove a tuple is visible
from the index alone and falls back to heap fetches, losing most of the benefit.

---

## What the cache is worth

Redis removes the database from the path entirely, so the saving is roughly the
whole query cost regardless of shape — which is why caching helps the
whole-table aggregates that indexing cannot touch.

Notice that "index + cache" and "cache only" are almost identical. That is
expected, and it is not evidence the indexes are redundant: **on a cache hit
the index cannot matter, because the database is never consulted.** What the
index determines is how expensive a cache *miss* is — and misses are not rare.
Every entry expires on its TTL, and every write to the fact table invalidates
the dataset outright. The cache sets the best case; the index sets the worst
one, which is the number a user actually feels after their data changes.

The first request still pays full price. Cold versus warm, in the index + cache
configuration:

| Query | Cold (ms) | Warm p50 (ms) | Change |
| ----- | --------: | ------------: | ------ |
| Revenue by category | 267.9 | 2.9 | −98.9% (91.8×) |
| Top 10 subcategories by revenue | 241.3 | 3.1 | −98.7% (77.4×) |
| Revenue and profit by channel | 370.0 | 3.2 | −99.1% (117.0×) |
| Total revenue (KPI) | 168.9 | 3.0 | −98.2% (57.1×) |
| Distinct customers (KPI) | 136.1 | 3.0 | −97.8% (45.1×) |
| Revenue by segment and region | 412.9 | 3.4 | −99.2% (121.7×) |
| Revenue for one month | 11.4 | 3.2 | −71.8% (3.5×) |
| Revenue by day, one week | 8.6 | 3.0 | −64.4% (2.8×) |
| Revenue by category for one store | 19.4 | 3.0 | −84.6% (6.5×) |
| Revenue by month, one quarter | 89.6 | 2.9 | −96.7% (30.4×) |

---

## The cost side

Indexes are not free, and on this table they are **larger than the data**:

| Index | Size |
| ----- | ---: |
| `fact_orders_customer_id_idx` | 14 MB |
| | <sub>`analytics.fact_orders USING btree (customer_id)`</sub> |
| `fact_orders_date_key_idx` | 77 MB |
| | <sub>`analytics.fact_orders USING btree (date_key) INCLUDE (revenue, cost, quantity)`</sub> |
| `fact_orders_ordered_at_idx` | 43 MB |
| | <sub>`analytics.fact_orders USING btree (ordered_at DESC)`</sub> |
| `fact_orders_product_id_idx` | 60 MB |
| | <sub>`analytics.fact_orders USING btree (product_id) INCLUDE (revenue, quantity)`</sub> |
| `fact_orders_store_id_idx` | 60 MB |
| | <sub>`analytics.fact_orders USING btree (store_id) INCLUDE (revenue)`</sub> |
| **Total (excl. primary key)** | **254 MB** |

Heap is 206 MB. Every insert into `fact_orders` now maintains
five more B-trees, which is why the seed script drops them — bulk-loading two
million rows with these in place is dramatically slower than building them
afterwards.

---

## Environment

| | |
| --- | --- |
| CPU | AMD Ryzen 7 4800HS with Radeon Graphics (16 logical cores) |
| Memory | 15 GB |
| Host OS | win32 10.0.28120 |
| Node.js | v24.14.1 |
| PostgreSQL | PostgreSQL 17.11 |
| Redis | connected |
| Fact table | 2,000,025 rows, 206 MB heap |

Postgres and Redis run in Docker Desktop containers, so the database does not
have the host's full resources. Postgres settings, pinned in
[`docker-compose.yml`](docker-compose.yml) so this is reproducible:

| Setting | Value |
| ------- | ----- |
| `effective_cache_size` | 196608 8kB |
| `jit` | off |
| `maintenance_work_mem` | 262144 kB |
| `max_parallel_workers_per_gather` | 2 |
| `random_page_cost` | 1.1 |
| `shared_buffers` | 65536 8kB |
| `work_mem` | 32768 kB |

`jit` is off deliberately: JIT compilation adds tens of milliseconds of
nondeterministic overhead at this scale, and the point is to measure the effect
of indexes and caching rather than the JIT's compile time.

---

## Caveats

- **Run-to-run variance is roughly 15%** on the whole-table queries — the same
  query under the same configuration measured 327ms and 375ms on consecutive
  runs. Differences smaller than that are not findings, which is why the
  analysis above only calls out changes above 30%.
- Single-machine, single-client. There is no concurrency here, so these numbers
  say nothing about behaviour under load — a real dashboard with ten widgets
  issues ten of these at once.
- The client, API, Postgres and Redis all share one host, so the network is
  loopback. A deployed system pays real network latency, which the cache would
  hide more of, not less.
- Docker Desktop on Windows adds a virtualisation layer; the same code on Linux
  would likely show lower absolute numbers, though the ratios should hold.
- The dataset is synthetic but deliberately skewed (power-law popularity,
  seasonality). Uniformly random data would make every filter equally selective
  and would overstate the indexing result.
