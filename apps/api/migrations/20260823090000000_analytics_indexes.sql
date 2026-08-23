-- Up Migration
--
-- Analytical indexes for fact_orders.
--
-- Kept in their own migration, separate from the schema, for one reason: the
-- benchmark harness needs to measure the same query suite with and without
-- them. `npm run benchmark` drops and recreates exactly these, so the "no
-- index" configuration is a real baseline rather than an estimate.
--
-- Every index below was chosen against measured statistics from the seeded
-- 2M-row table, not from intuition. The relevant numbers, read from pg_stats:
--
--   column        n_distinct   correlation   most common value
--   date_key           1,826        -0.002               0.18%
--   customer_id       42,396        -0.003               0.09%
--   product_id         4,947         0.002               2.10%
--   store_id             200        -0.001               2.37%
--   order_status           4         0.780              87.90%
--
-- Two of those numbers decided as much as anything else here:
--
--   correlation ~= 0 on date_key. The seed draws each row's date from a
--   seasonality distribution, so rows for a given day are scattered across the
--   whole heap rather than sitting together. That rules out BRIN, which is the
--   usual recommendation for a "time column on a big fact table" and would
--   have been the wrong call: BRIN summarises physical block ranges, and with
--   no correlation every block range contains every date, so every scan
--   degrades to a full scan plus overhead. B-tree it is.
--
--   87.9% of rows share one order_status. See the note at the bottom for why
--   that column is deliberately left unindexed.

-- ---------------------------------------------------------------------------
-- 1. Time-filtered aggregates - the flagship dashboard access pattern
--
-- "Revenue for a period, grouped by something" is what a dashboard mostly
-- asks. The INCLUDE columns carry the three measures those queries aggregate,
-- which lets Postgres answer them with an index-only scan: it never touches
-- the heap, so the cost scales with the *selected* date range instead of with
-- the table.
--
-- That only works because the seed runs VACUUM, which populates the visibility
-- map. Without it Postgres cannot prove a tuple is visible from the index
-- alone and falls back to heap fetches, losing most of the benefit.
--
-- INCLUDE rather than a composite key: the measures are payload, never
-- searched or ordered on, so putting them in the key would bloat the internal
-- pages and buy nothing.
-- ---------------------------------------------------------------------------
CREATE INDEX fact_orders_date_key_idx
  ON analytics.fact_orders (date_key)
  INCLUDE (revenue, cost, quantity);

COMMENT ON INDEX analytics.fact_orders_date_key_idx IS
  'Date-range filtered aggregates. INCLUDE carries the measures so the common case is an index-only scan.';

-- ---------------------------------------------------------------------------
-- 2, 3, 4. Foreign key columns
--
-- A foreign key constraint does not create an index on the referencing side,
-- so without these the fact table has no access path by dimension key at all.
--
-- They earn their place in two ways. When a dashboard filters to a single
-- store (2.4% of rows) or a handful of products, the planner can use a nested
-- loop with an index scan instead of scanning 2M rows. And they make DELETEs
-- on a dimension row cheap, which otherwise requires a full scan of the fact
-- table per deleted row to enforce the constraint.
--
-- store_id and product_id carry revenue as payload; those two are routinely
-- aggregated after filtering on exactly this key, which again allows an
-- index-only scan. customer_id does not: per-customer revenue is a rare
-- dashboard question, and 2M extra numeric values is not worth carrying for it.
-- ---------------------------------------------------------------------------
CREATE INDEX fact_orders_store_id_idx
  ON analytics.fact_orders (store_id)
  INCLUDE (revenue);

CREATE INDEX fact_orders_product_id_idx
  ON analytics.fact_orders (product_id)
  INCLUDE (revenue, quantity);

CREATE INDEX fact_orders_customer_id_idx
  ON analytics.fact_orders (customer_id);

COMMENT ON INDEX analytics.fact_orders_store_id_idx IS
  'Store-filtered aggregates, and cheap FK enforcement on dim_store deletes.';
COMMENT ON INDEX analytics.fact_orders_product_id_idx IS
  'Product/category-filtered aggregates, and cheap FK enforcement on dim_product deletes.';
COMMENT ON INDEX analytics.fact_orders_customer_id_idx IS
  'Customer joins and FK enforcement. No INCLUDE: per-customer revenue is not a common dashboard question.';

-- ---------------------------------------------------------------------------
-- 5. Recency
--
-- DESC so "the most recent orders" is a forward scan of the index's leading
-- edge rather than a backward one. ordered_at is almost unique (n_distinct is
-- effectively one value per row), so this is a poor filter but an excellent
-- sort - which is exactly what a "latest activity" widget needs.
-- ---------------------------------------------------------------------------
CREATE INDEX fact_orders_ordered_at_idx
  ON analytics.fact_orders (ordered_at DESC);

COMMENT ON INDEX analytics.fact_orders_ordered_at_idx IS
  'Recency ordering for latest-activity views. DESC matches the direction those queries scan.';

-- ---------------------------------------------------------------------------
-- Deliberately NOT indexed
--
-- order_status. 87.9% of rows are 'completed', which is also the value nearly
-- every dashboard filters on. An index returning seven rows in eight is
-- strictly worse than a sequential scan - the planner knows this and would
-- correctly ignore the index, so it would cost write amplification and disk
-- for nothing. A partial index `WHERE order_status = 'completed'` fares no
-- better for the same reason: it would contain 87.9% of the table.
--
-- The dimension tables. dim_date is 1,826 rows, dim_store is 200, dim_product
-- is 5,000 - all of which Postgres reads in a handful of pages. Their primary
-- keys already serve the star joins, and a secondary index on, say,
-- dim_customer.segment would sit unused: with four distinct values across
-- 50,000 rows it is not selective, and the table is small enough that scanning
-- it is cheaper than the index lookup.
--
-- revenue, profit and the other measures. They are aggregated, never filtered
-- or joined on. There is no query shape that would use such an index.
-- ---------------------------------------------------------------------------

-- Refresh planner statistics so the new access paths are costed correctly on
-- the very next query rather than after autovacuum next runs.
ANALYZE analytics.fact_orders;

-- Down Migration

DROP INDEX IF EXISTS analytics.fact_orders_date_key_idx;
DROP INDEX IF EXISTS analytics.fact_orders_store_id_idx;
DROP INDEX IF EXISTS analytics.fact_orders_product_id_idx;
DROP INDEX IF EXISTS analytics.fact_orders_customer_id_idx;
DROP INDEX IF EXISTS analytics.fact_orders_ordered_at_idx;

ANALYZE analytics.fact_orders;
