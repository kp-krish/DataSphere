/**
 * The benchmark suite: ten representative dashboard queries.
 *
 * These are query *specs*, not hand-written SQL, so the benchmark measures the
 * same path a real widget takes - through the compiler, the cache and the API.
 * Benchmarking hand-tuned SQL would measure something no user ever runs.
 *
 * The mix is deliberately split, because that is the honest shape of
 * the result:
 *
 *   Six aggregate the whole fact table. Most cannot be helped by an index - a
 *   sequential scan over two million rows is already the optimal plan. But not
 *   all: COUNT(DISTINCT customer_id) reads every row yet needs only one narrow
 *   column, and an index-only scan over that column moves a fraction of the
 *   bytes. The measured run makes that distinction visible instead of letting
 *   "full scan" stand in for "unhelpable".
 *
 *   Four carry a selective filter, which is what a dashboard scoped to a
 *   period or a store actually looks like. Those are where an index changes
 *   the plan outright, and the difference is large.
 *
 * Reporting only the first group would make indexing look useless; reporting
 * only the second would make it look like magic. Both are in here.
 */

import type { QuerySpec } from '@datasphere/core';

export interface BenchQuery {
  id: string;
  label: string;
  /** Whether the query can, in principle, use an index. */
  shape: 'full-scan' | 'selective';
  /** What this query stands in for on a real dashboard. */
  note: string;
  spec: QuerySpec;
}

const completed = {
  table: 'fact_orders',
  column: 'order_status',
  operator: 'eq' as const,
  values: ['completed'],
};

export const BENCH_QUERIES: BenchQuery[] = [
  /* ---- whole-table aggregates ------------------------------------------- */
  {
    id: 'revenue_by_category',
    label: 'Revenue by category',
    shape: 'full-scan',
    note: 'Headline breakdown; touches every row.',
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'category', alias: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      sort: [{ alias: 'revenue', direction: 'desc' }],
    },
  },
  {
    id: 'revenue_by_subcategory',
    label: 'Top 10 subcategories by revenue',
    shape: 'full-scan',
    note: 'Ranked bar chart. LIMIT does not reduce the scan - every row must be aggregated first.',
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'subcategory', alias: 'subcategory' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      sort: [{ alias: 'revenue', direction: 'desc' }],
      limit: 10,
    },
  },
  {
    id: 'profit_by_channel',
    label: 'Revenue and profit by channel',
    shape: 'full-scan',
    note: 'Two measures over one grouping.',
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_store', column: 'channel', alias: 'channel' }],
      measures: [
        { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
        { table: 'fact_orders', column: 'profit', fn: 'SUM', alias: 'profit' },
      ],
      sort: [{ alias: 'revenue', direction: 'desc' }],
    },
  },
  {
    id: 'total_revenue_kpi',
    label: 'Total revenue (KPI)',
    shape: 'full-scan',
    note: 'Single number, filtered on a value 87.9% of rows share - deliberately unindexed.',
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [completed],
    },
  },
  {
    id: 'distinct_customers_kpi',
    label: 'Distinct customers (KPI)',
    shape: 'full-scan',
    note: 'COUNT DISTINCT over 50k values - the most expensive query in the suite.',
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [
        { table: 'fact_orders', column: 'customer_id', fn: 'COUNT_DISTINCT', alias: 'customers' },
      ],
    },
  },
  {
    id: 'segment_by_region',
    label: 'Revenue by segment and region',
    shape: 'full-scan',
    note: 'Two-dimension grouping across a 50k-row dimension.',
    spec: {
      dataset: 'orders',
      dimensions: [
        { table: 'dim_customer', column: 'segment', alias: 'segment' },
        { table: 'dim_customer', column: 'region', alias: 'region' },
      ],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      sort: [{ alias: 'revenue', direction: 'desc' }],
      limit: 25,
    },
  },

  /* ---- selectively filtered --------------------------------------------- */
  {
    id: 'revenue_one_month',
    label: 'Revenue for one month',
    shape: 'selective',
    note: 'A dashboard scoped to a period. ~1.7% of rows; the covering index answers it without touching the heap.',
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [
        { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
        { table: 'fact_orders', column: 'quantity', fn: 'SUM', alias: 'units' },
      ],
      filters: [
        {
          table: 'fact_orders',
          column: 'date_key',
          operator: 'between',
          values: [20240301, 20240331],
        },
      ],
    },
  },
  {
    id: 'revenue_by_day_one_week',
    label: 'Revenue by day, one week',
    shape: 'selective',
    note: 'Time series at day grain over a narrow window - ~0.4% of rows.',
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'full_date', alias: 'day' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [
        {
          table: 'fact_orders',
          column: 'date_key',
          operator: 'between',
          values: [20240601, 20240607],
        },
      ],
      sort: [{ alias: 'day', direction: 'asc' }],
    },
  },
  {
    id: 'revenue_one_store',
    label: 'Revenue by category for one store',
    shape: 'selective',
    note: 'Drill-down to a single store - ~2.4% of rows.',
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'category', alias: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [{ table: 'fact_orders', column: 'store_id', operator: 'eq', values: [42] }],
      sort: [{ alias: 'revenue', direction: 'desc' }],
    },
  },
  {
    id: 'revenue_recent_quarter',
    label: 'Revenue by month, one quarter',
    shape: 'selective',
    note: 'The most common real dashboard shape: bucketed time series over a bounded range.',
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'full_date', grain: 'month', alias: 'month' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [
        {
          table: 'fact_orders',
          column: 'date_key',
          operator: 'between',
          values: [20251001, 20251231],
        },
        completed,
      ],
      sort: [{ alias: 'month', direction: 'asc' }],
    },
  },
];
