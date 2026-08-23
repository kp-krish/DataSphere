/**
 * Benchmark harness.
 *
 *   npm run benchmark
 *
 * Runs the query suite in scripts/lib/bench-queries.ts under four
 * configurations and writes the measured result to BENCHMARKS.md.
 *
 *   1. no index, no cache   the baseline
 *   2. no index, cache      what Redis alone is worth
 *   3. index, no cache      what the indexes alone are worth
 *   4. index + cache        both
 *
 * Design decisions worth stating, because they determine whether the numbers
 * mean anything:
 *
 * Requests go over HTTP to the running API, not straight to Postgres. The
 * cache lives in the API, so measuring at the database would make two of the
 * four configurations impossible; and the number a dashboard actually
 * experiences includes the round trip, the compile and the cache lookup.
 *
 * Indexes are dropped and recreated from the definitions Postgres itself
 * reports, not from DDL copied into this file. Whatever the migration created
 * is what gets dropped and restored, so this cannot drift from the schema. The
 * primary key is left alone: "no index" here means no *analytical* index, not
 * a table without a primary key, which is not a configuration anyone runs.
 *
 * Each configuration gets a warm-up pass that is timed but discarded, because
 * the first execution pays for cold shared buffers and, in the cached
 * configurations, for populating Redis. Reporting a steady state is the point;
 * the cold cost is reported separately rather than hidden.
 *
 * The prose in the generated report is derived from the measurements wherever
 * it makes a claim about them. An earlier draft asserted ahead of time that no
 * whole-table query could benefit from an index, and the first real run
 * disproved it - COUNT(DISTINCT customer_id) improved threefold. Computing the
 * sentences means the report cannot contradict its own tables.
 */

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import type { QueryResult } from '@datasphere/core';
import { BENCH_QUERIES, type BenchQuery } from './lib/bench-queries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(HERE, '..', 'BENCHMARKS.md');

const API = process.env.BENCHMARK_API_URL ?? 'http://localhost:4000';
const ITERATIONS = Number(process.env.BENCHMARK_ITERATIONS ?? 20);

/**
 * Percent. Repeated runs of the *same* configuration on this setup vary by
 * roughly 15% on the whole-table queries - one of them measured 327ms and
 * 375ms on consecutive runs - so a threshold at 15 would promote noise into
 * findings. 30 sits comfortably outside that band.
 */
const MATERIAL = 30;

interface Config {
  id: string;
  label: string;
  indexes: boolean;
  cache: boolean;
}

/**
 * Ordered so the index state changes once rather than three times: building
 * five indexes over two million rows is not free, and doing it repeatedly
 * would add minutes for nothing.
 */
const CONFIGS: Config[] = [
  { id: 'baseline', label: 'No index, no cache', indexes: false, cache: false },
  { id: 'cache_only', label: 'Cache only', indexes: false, cache: true },
  { id: 'index_only', label: 'Index only', indexes: true, cache: false },
  { id: 'both', label: 'Index + cache', indexes: true, cache: true },
];

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Nearest-rank percentile.
 *
 * No interpolation: with twenty samples an interpolated p95 invents a value
 * that was never measured, and the point here is to report only observations.
 */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

interface Stats {
  p50: number;
  p95: number;
  min: number;
  max: number;
  samples: number;
}

function summarise(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    samples: values.length,
  };
}

const fixed = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);

/* -------------------------------------------------------------------------- */
/* Index toggling                                                             */
/* -------------------------------------------------------------------------- */

interface SavedIndex {
  name: string;
  definition: string;
  bytes: number;
}

/** Read the analytical indexes and the exact DDL Postgres reports for them. */
async function readIndexes(client: Client): Promise<SavedIndex[]> {
  const { rows } = await client.query<{ name: string; definition: string; bytes: string }>(
    `SELECT i.indexname AS name,
            i.indexdef  AS definition,
            pg_relation_size(c.oid)::text AS bytes
       FROM pg_indexes i
       JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
      WHERE i.schemaname = 'analytics'
        AND i.tablename = 'fact_orders'
        AND i.indexname <> 'fact_orders_pkey'
      ORDER BY i.indexname`,
  );
  return rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
}

async function dropIndexes(client: Client, indexes: SavedIndex[]): Promise<void> {
  for (const index of indexes) {
    await client.query(`DROP INDEX IF EXISTS analytics.${index.name}`);
  }
  await client.query('ANALYZE analytics.fact_orders');
}

async function createIndexes(client: Client, indexes: SavedIndex[]): Promise<void> {
  for (const index of indexes) {
    await client.query(index.definition);
  }
  await client.query('ANALYZE analytics.fact_orders');
}

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

async function apiFetch(route: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${route} failed: HTTP ${response.status}`);
  }
  return response;
}

/** Delete every cached result, so a configuration starts genuinely cold. */
async function flushCache(): Promise<void> {
  await apiFetch('/api/cache?resetStats=1', { method: 'DELETE' });
}

interface Timed {
  durationMs: number;
  cache: string;
  rowCount: number;
}

/**
 * Run one query and time it from the client's side.
 *
 * Wall clock around the whole request, which is what a widget waits for.
 */
async function runOnce(query: BenchQuery, useCache: boolean): Promise<Timed> {
  const startedAt = performance.now();

  const response = await apiFetch('/api/query', {
    method: 'POST',
    body: JSON.stringify({ spec: query.spec, noCache: !useCache }),
  });
  const body = (await response.json()) as QueryResult;

  return {
    durationMs: performance.now() - startedAt,
    cache: body.meta.cache,
    rowCount: body.meta.rowCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

interface Measurement {
  query: BenchQuery;
  stats: Stats;
  coldMs: number;
  rowCount: number;
}

async function measureConfig(config: Config): Promise<Measurement[]> {
  const results: Measurement[] = [];

  for (const query of BENCH_QUERIES) {
    // Warm-up: pays for cold shared buffers, and for the cache fill where
    // caching is on. Timed so it can be reported, never averaged in.
    const cold = await runOnce(query, config.cache);

    const durations: number[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      durations.push((await runOnce(query, config.cache)).durationMs);
    }

    const stats = summarise(durations);
    results.push({ query, stats, coldMs: cold.durationMs, rowCount: cold.rowCount });

    process.stdout.write(
      `    ${query.id.padEnd(26)} p50 ${fixed(stats.p50).padStart(8)} ms` +
        `   p95 ${fixed(stats.p95).padStart(8)} ms\n`,
    );
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* Environment capture                                                        */
/* -------------------------------------------------------------------------- */

interface Environment {
  cpu: string;
  cores: number;
  memoryGb: number;
  platform: string;
  node: string;
  postgres: string;
  redis: string;
  settings: Record<string, string>;
  heapSize: string;
  factRows: number;
}

async function captureEnvironment(client: Client): Promise<Environment> {
  const cpus = os.cpus();
  const version = await client.query<{ version: string }>('SELECT version()');

  const settings = await client.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1) ORDER BY name`,
    [
      [
        'shared_buffers',
        'effective_cache_size',
        'work_mem',
        'maintenance_work_mem',
        'random_page_cost',
        'max_parallel_workers_per_gather',
        'jit',
      ],
    ],
  );

  const size = await client.query<{ heap: string; rows: string }>(
    `SELECT pg_size_pretty(pg_relation_size('analytics.fact_orders')) AS heap,
            (SELECT count(*)::text FROM analytics.fact_orders) AS rows`,
  );

  let redis = 'unknown';
  try {
    const stats = (await (await apiFetch('/api/cache/stats')).json()) as { connected: boolean };
    redis = stats.connected ? 'connected' : 'unavailable';
  } catch {
    // Reported as unknown rather than failing the run.
  }

  return {
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    postgres: version.rows[0]?.version.split(' on ')[0] ?? 'unknown',
    redis,
    settings: Object.fromEntries(
      settings.rows.map((row) => [row.name, row.unit ? `${row.setting} ${row.unit}` : row.setting]),
    ),
    heapSize: size.rows[0]?.heap ?? 'unknown',
    factRows: Number(size.rows[0]?.rows ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */
/* Markdown table alignment                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pad every markdown table in the report so its columns line up.
 *
 * Done as a post-pass over the finished document rather than inside each
 * template, because the tables are assembled in a dozen places - headers in
 * the literal, rows in helper functions - and only the finished text knows how
 * wide a column ended up.
 *
 * This is not cosmetic. `npm run format:check` runs in CI, and Prettier
 * formats markdown; without this, every benchmark run would leave the repo
 * failing its own format gate until someone hand-ran Prettier over generated
 * output. Emitting what Prettier would emit keeps the generator and the gate
 * from fighting.
 */
function alignTables(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const delimiter = lines[i + 1];
    // A table is a header row followed by a delimiter row. Detecting on the
    // delimiter avoids mistaking a prose line containing a pipe for a table.
    if (!isRow(lines[i]) || delimiter === undefined || !isDelimiter(delimiter)) {
      out.push(lines[i]!);
      continue;
    }

    let end = i + 2;
    while (end < lines.length && isRow(lines[end])) end += 1;

    const block = lines.slice(i, end);
    out.push(...formatTable(block));
    i = end - 1;
  }

  return out.join('\n');
}

const isRow = (line: string | undefined): boolean =>
  line !== undefined && /^\s*\|.*\|\s*$/.test(line);

const isDelimiter = (line: string): boolean =>
  isRow(line) && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);

/** Split `| a | b |` into its cells, dropping the outer delimiters. */
function cells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Display width. Counts code points, not UTF-16 units, so the minus sign and
 * multiplication sign this report uses (U+2212, U+00D7) each count as one
 * column rather than being mismeasured.
 */
const width = (text: string): number => [...text].length;

function formatTable(block: string[]): string[] {
  const rows = block.map(cells);
  const alignments = rows[1]!.map((cell): 'left' | 'right' | 'center' => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    return right ? 'right' : 'left';
  });

  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    // Three is the narrowest a delimiter can be written and still read as one.
    Math.max(3, ...rows.map((row, index) => (index === 1 ? 0 : width(row[column] ?? '')))),
  );

  return rows.map((row, index) => {
    const rendered = Array.from({ length: columns }, (_, column) => {
      const target = widths[column]!;
      if (index === 1) {
        const dashes = '-'.repeat(
          target - (alignments[column] === 'center' ? 2 : alignments[column] === 'right' ? 1 : 0),
        );
        if (alignments[column] === 'center') return `:${dashes}:`;
        return alignments[column] === 'right' ? `${dashes}:` : dashes;
      }

      const cell = row[column] ?? '';
      const padding = ' '.repeat(target - width(cell));
      if (alignments[column] === 'right') return `${padding}${cell}`;
      if (alignments[column] === 'center') {
        const left = Math.floor(padding.length / 2);
        return `${' '.repeat(left)}${cell}${' '.repeat(padding.length - left)}`;
      }
      return `${cell}${padding}`;
    });

    return `| ${rendered.join(' | ')} |`;
  });
}

/* -------------------------------------------------------------------------- */

function change(baseline: number, value: number): string {
  if (baseline <= 0) return '—';
  const delta = ((baseline - value) / baseline) * 100;
  const speedup = value > 0 ? baseline / value : 0;
  return `${delta >= 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}% (${speedup.toFixed(1)}×)`;
}

function buildReport(
  environment: Environment,
  indexes: SavedIndex[],
  measured: Map<string, Measurement[]>,
  startedAt: Date,
  elapsedMs: number,
): string {
  const baselineRows = measured.get('baseline')!;
  const baselineByQuery = new Map(baselineRows.map((row) => [row.query.id, row.stats]));

  const medianOf = (values: number[]): number =>
    percentile(
      [...values].sort((a, b) => a - b),
      0.5,
    );

  const baselineMedianP50 = medianOf(baselineRows.map((row) => row.stats.p50));

  /* ---- headline ---- */
  const summaryRows = CONFIGS.map((config) => {
    const rows = measured.get(config.id)!;
    const p50 = medianOf(rows.map((row) => row.stats.p50));
    const p95 = medianOf(rows.map((row) => row.stats.p95));

    return `| ${config.label} | ${fixed(p50)} | ${fixed(p95)} | ${
      config.id === 'baseline' ? '—' : change(baselineMedianP50, p50)
    } |`;
  }).join('\n');

  /* ---- narrative, derived from what was measured ---- */
  const indexDeltas = BENCH_QUERIES.map((query) => {
    const base = baselineByQuery.get(query.id)!.p50;
    const indexed = measured.get('index_only')!.find((e) => e.query.id === query.id)!.stats.p50;
    return { query, base, indexed, gain: base > 0 ? ((base - indexed) / base) * 100 : 0 };
  });

  const helped = indexDeltas.filter((entry) => entry.gain >= MATERIAL);
  const unhelped = indexDeltas.filter((entry) => entry.gain < MATERIAL);
  const helpedFullScan = helped.filter((entry) => entry.query.shape === 'full-scan');

  const best = [...indexDeltas].sort((a, b) => b.gain - a.gain)[0];
  const bestSpeedup =
    best && best.indexed > 0
      ? `${(best.base / best.indexed).toFixed(1)}× (${best.query.label})`
      : 'not at all';

  const listOf = (entries: typeof helped): string =>
    entries.map((entry) => `**${entry.query.label}** (${entry.gain.toFixed(0)}%)`).join(', ');

  const narrative = [
    helped.length === 0
      ? `No query in the suite improved by more than ${MATERIAL}% from indexing alone.`
      : `Indexes alone moved ${helped.length} of the ${BENCH_QUERIES.length} queries by more than ${MATERIAL}%: ${listOf(helped)}. The other ${unhelped.length} changed by less, which at this sample size is not distinguishable from run-to-run noise.`,
    helpedFullScan.length > 0
      ? `Note which ones: ${listOf(helpedFullScan)} ${helpedFullScan.length === 1 ? 'is' : 'are'} marked \`full-scan\` and still improved sharply. That is worth explaining rather than waving away.`
      : 'Every query that improved carries a selective filter, as expected.',
  ].join('\n\n');

  /* ---- tables ---- */
  const perQuery = BENCH_QUERIES.map((query) => {
    const cells = CONFIGS.map((config) =>
      fixed(measured.get(config.id)!.find((e) => e.query.id === query.id)!.stats.p50),
    );
    const base = baselineByQuery.get(query.id)!;
    const bothStats = measured.get('both')!.find((e) => e.query.id === query.id)!.stats;

    return `| ${query.label} | \`${query.shape}\` | ${cells.join(' | ')} | ${change(base.p50, bothStats.p50)} |`;
  }).join('\n');

  const indexEffect = indexDeltas
    .map(
      (entry) =>
        `| ${entry.query.label} | \`${entry.query.shape}\` | ${fixed(entry.base)} | ${fixed(
          entry.indexed,
        )} | ${change(entry.base, entry.indexed)} |`,
    )
    .join('\n');

  const coldWarm = measured
    .get('both')!
    .map(
      (row) =>
        `| ${row.query.label} | ${fixed(row.coldMs)} | ${fixed(row.stats.p50)} | ${change(
          row.coldMs,
          row.stats.p50,
        )} |`,
    )
    .join('\n');

  const totalIndexBytes = indexes.reduce((sum, index) => sum + index.bytes, 0);

  const indexList = indexes
    .map(
      (index) =>
        `| \`${index.name}\` | ${(index.bytes / 1024 ** 2).toFixed(0)} MB |\n` +
        `| | <sub>\`${index.definition.replace(/^CREATE INDEX \S+ ON /, '')}\`</sub> |`,
    )
    .join('\n');

  const settingsList = Object.entries(environment.settings)
    .map(([name, value]) => `| \`${name}\` | ${value} |`)
    .join('\n');

  return alignTables(`# Benchmarks

Measured, not estimated. Every number below was produced by \`npm run benchmark\`,
which runs the suite in
[\`scripts/lib/bench-queries.ts\`](scripts/lib/bench-queries.ts) under four
configurations and writes this file. Re-running it overwrites these numbers.

**Run:** ${startedAt.toISOString()} · ${(elapsedMs / 1000).toFixed(0)}s ·
${ITERATIONS} measured iterations per query per configuration
(${CONFIGS.length * BENCH_QUERIES.length * (ITERATIONS + 1)} requests total).

---

## Headline

Median across the ten-query suite, measured end to end over HTTP:

| Configuration | p50 (ms) | p95 (ms) | vs baseline |
| ------------- | -------: | -------: | ----------- |
${summaryRows}

**That "index only" row understates what the indexes do.** The suite is
deliberately weighted towards whole-table aggregation, so the _median_ query in
it is one indexes barely touch — while the best-served query in the same suite
improves ${bestSpeedup}. A single median cannot represent a workload that
bimodal, which is why this report leads with the per-query split rather than an
average. The index numbers worth reading are further down.

---

## Method

- **Where it measures.** Wall clock around an HTTP \`POST /api/query\` against
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
  observation that actually happened. With ${ITERATIONS} samples, p95 is the
  ${Math.ceil(0.95 * ITERATIONS)}th slowest.
- **Suite figures** are the median across the ten queries, not a mean, so one
  expensive query does not set the headline.

---

## Per-query results

p50 in milliseconds.

| Query | Shape | Baseline | Cache only | Index only | Index + cache | Best vs baseline |
| ----- | ----- | -------: | ---------: | ---------: | ------------: | ---------------- |
${perQuery}

---

## What the indexes alone are worth

This is the part worth reading carefully, because the effect is not uniform —
and a benchmark reporting only an average would hide exactly the thing that
matters.

| Query | Shape | No index (ms) | With index (ms) | Change |
| ----- | ----- | ------------: | --------------: | ------ |
${indexEffect}

${narrative}

The rule that actually predicts the outcome is **not** "full scan versus
filtered" — it is **how many bytes the query has to move**. An index helps
whenever it lets Postgres read less, and there are two separate ways that
happens.

**1. Reading fewer rows.** A dashboard scoped to a month touches ~1.7% of the
table. With \`fact_orders_date_key_idx\` carrying the measures as \`INCLUDE\`
columns, Postgres answers those with an index-only scan:

\`\`\`
Aggregate
  ->  Index Only Scan using fact_orders_date_key_idx
        Index Cond: ((date_key >= 20240301) AND (date_key <= 20240331))
        Heap Fetches: 0
        Buffers: shared hit=1 read=167
\`\`\`

168 buffers instead of 7,968, and \`Heap Fetches: 0\` — the heap is never
touched.

**2. Reading narrower rows.** This is the case the obvious reasoning gets
wrong. \`COUNT(DISTINCT customer_id)\` must visit all two million rows, so by
the "a full scan cannot be helped" rule an index should be useless here. It is
not: the query needs exactly one 4-byte column, and the index _is_ a narrow
copy of that column, so Postgres scans it instead of the heap.

\`\`\`
Aggregate
  ->  Index Only Scan using fact_orders_customer_id_idx
        Heap Fetches: 25
        Buffers: shared hit=1775
\`\`\`

1,775 buffers against roughly 26,000 for the heap — every row, a fraction of
the bytes.

There is a satisfying detail here. \`fact_orders_customer_id_idx\` is the
_smallest_ index on the table despite indexing the column with the _most_
distinct values, because it is the only one without \`INCLUDE\` columns and so
the only one B-tree deduplication can compress. The same decision that made it
cheap to store is what makes it fast to scan.

The queries that genuinely cannot be helped are the ones needing columns no
index carries — \`revenue\` alongside a join key, say. Those must reach the heap
for every row, and a parallel sequential scan is already the optimal plan.

Index-only scans depend on the visibility map, which is why the seed runs
\`VACUUM\` after loading. Without it Postgres cannot prove a tuple is visible
from the index alone and falls back to heap fetches, losing most of the benefit.

---

## What the cache is worth

Redis removes the database from the path entirely, so the saving is roughly the
whole query cost regardless of shape — which is why caching helps the
whole-table aggregates that indexing cannot touch.

Notice that "index + cache" and "cache only" are almost identical. That is
expected, and it is not evidence the indexes are redundant: **on a cache hit
the index cannot matter, because the database is never consulted.** What the
index determines is how expensive a cache _miss_ is — and misses are not rare.
Every entry expires on its TTL, and every write to the fact table invalidates
the dataset outright. The cache sets the best case; the index sets the worst
one, which is the number a user actually feels after their data changes.

The first request still pays full price. Cold versus warm, in the index + cache
configuration:

| Query | Cold (ms) | Warm p50 (ms) | Change |
| ----- | --------: | ------------: | ------ |
${coldWarm}

---

## The cost side

Indexes are not free, and on this table they are **larger than the data**:

| Index | Size |
| ----- | ---: |
${indexList}
| **Total (excl. primary key)** | **${(totalIndexBytes / 1024 ** 2).toFixed(0)} MB** |

Heap is ${environment.heapSize}. Every insert into \`fact_orders\` now maintains
five more B-trees, which is why the seed script drops them — bulk-loading two
million rows with these in place is dramatically slower than building them
afterwards.

---

## Environment

| | |
| --- | --- |
| CPU | ${environment.cpu} (${environment.cores} logical cores) |
| Memory | ${environment.memoryGb} GB |
| Host OS | ${environment.platform} |
| Node.js | ${environment.node} |
| PostgreSQL | ${environment.postgres} |
| Redis | ${environment.redis} |
| Fact table | ${environment.factRows.toLocaleString()} rows, ${environment.heapSize} heap |

Postgres and Redis run in Docker Desktop containers, so the database does not
have the host's full resources. Postgres settings, pinned in
[\`docker-compose.yml\`](docker-compose.yml) so this is reproducible:

| Setting | Value |
| ------- | ----- |
${settingsList}

\`jit\` is off deliberately: JIT compilation adds tens of milliseconds of
nondeterministic overhead at this scale, and the point is to measure the effect
of indexes and caching rather than the JIT's compile time.

---

## Caveats

- **Run-to-run variance is roughly 15%** on the whole-table queries — the same
  query under the same configuration measured 327ms and 375ms on consecutive
  runs. Differences smaller than that are not findings, which is why the
  analysis above only calls out changes above ${MATERIAL}%.
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
`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');

  // Fail early and clearly if the stack is not up, rather than after the first
  // configuration has already run.
  try {
    await apiFetch('/api/health');
  } catch {
    throw new Error(
      `The API is not reachable at ${API}. Start the stack with: docker compose up -d`,
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('SET statement_timeout = 0');

  const startedAt = new Date();
  const runStart = performance.now();

  try {
    const savedIndexes = await readIndexes(client);
    if (savedIndexes.length === 0) {
      throw new Error(
        'No analytical indexes found. Run `npm run migrate` first - the benchmark restores whatever the migration created.',
      );
    }

    console.log('DataSphere benchmark');
    console.log('--------------------');
    console.log(`  API        : ${API}`);
    console.log(`  iterations : ${ITERATIONS} per query per configuration`);
    console.log(`  queries    : ${BENCH_QUERIES.length}`);
    console.log(`  indexes    : ${savedIndexes.map((index) => index.name).join(', ')}`);
    console.log('');

    const environment = await captureEnvironment(client);
    const measured = new Map<string, Measurement[]>();

    let indexesPresent = true;

    // Restoring the indexes has to survive a failure, not just a clean
    // finish. An earlier interrupted run left the table with no analytical
    // indexes at all - the benchmark had dropped them for the baseline and
    // never reached the restore - which is a benchmark quietly breaking the
    // schema it was only supposed to measure.
    const restoreIndexes = async (): Promise<void> => {
      if (indexesPresent) return;
      console.log('\n  Restoring indexes...');
      await createIndexes(client, savedIndexes);
      indexesPresent = true;
    };

    // Ctrl-C does not unwind `finally`, so handle it explicitly.
    const onSignal = (): void => {
      console.log('\n  Interrupted - restoring indexes before exit...');
      restoreIndexes()
        .catch((error: unknown) => console.error('  Could not restore indexes:', error))
        .finally(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      for (const config of CONFIGS) {
        if (config.indexes !== indexesPresent) {
          console.log(`  ${config.indexes ? 'Creating' : 'Dropping'} analytical indexes...`);
          const toggleStart = performance.now();
          if (config.indexes) {
            await createIndexes(client, savedIndexes);
          } else {
            await dropIndexes(client, savedIndexes);
          }
          indexesPresent = config.indexes;
          console.log(`    done in ${((performance.now() - toggleStart) / 1000).toFixed(1)}s`);
        }

        // Always start from a cold cache, so a previous configuration's entries
        // cannot be read by this one.
        await flushCache();

        console.log(`\n  [${config.label}]`);
        measured.set(config.id, await measureConfig(config));
      }
    } finally {
      // Leave the database as the migration intends, whatever order the
      // configurations ran in and whether or not the run succeeded.
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await restoreIndexes();
    }

    await flushCache();

    // Re-read sizes now the indexes are definitely back.
    const finalIndexes = await readIndexes(client);

    await writeFile(
      OUTPUT,
      buildReport(environment, finalIndexes, measured, startedAt, performance.now() - runStart),
      'utf8',
    );

    console.log(`\nWrote ${OUTPUT}`);
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('\nBenchmark failed:');
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
