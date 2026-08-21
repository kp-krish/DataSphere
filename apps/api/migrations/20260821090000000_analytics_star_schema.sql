-- Up Migration
--
-- DataSphere analytical star schema.
--
-- Everything the dynamic query engine is allowed to touch lives in the
-- `analytics` schema and nowhere else. Catalog introspection filters on
-- table_schema = 'analytics', so application tables (dashboards, widgets,
-- migration bookkeeping) are structurally unreachable from a user query
-- even if the allowlist check were somehow bypassed.
--
-- No analytical indexes are created here on purpose. The benchmark harness
-- needs a genuine "no index" baseline to measure against, so every index
-- beyond the primary keys lives in its own later migration that can be
-- rolled back and re-applied independently.

CREATE SCHEMA IF NOT EXISTS analytics;

-- ---------------------------------------------------------------------------
-- dim_date
--
-- Classic Kimball date dimension keyed on an integer YYYYMMDD "smart key"
-- rather than a surrogate sequence. Four bytes, joins compile to integer
-- comparison, and a raw fact row stays human-readable when you eyeball it.
-- Pre-computing the calendar attributes means grouping by month or quarter
-- is a plain GROUP BY on an indexed column instead of a date_trunc() call
-- that the planner cannot use an index for.
-- ---------------------------------------------------------------------------
CREATE TABLE analytics.dim_date (
  date_key      integer   PRIMARY KEY,
  full_date     date      NOT NULL UNIQUE,
  day_of_month  smallint  NOT NULL,
  day_of_week   smallint  NOT NULL,
  day_name      text      NOT NULL,
  week_of_year  smallint  NOT NULL,
  month_num     smallint  NOT NULL,
  month_name    text      NOT NULL,
  quarter_num   smallint  NOT NULL,
  year_num      smallint  NOT NULL,
  is_weekend    boolean   NOT NULL
);

COMMENT ON TABLE analytics.dim_date IS 'Calendar dimension, one row per day. Keyed YYYYMMDD.';
COMMENT ON COLUMN analytics.dim_date.date_key IS 'Integer YYYYMMDD smart key, e.g. 20240317.';
COMMENT ON COLUMN analytics.dim_date.day_of_week IS 'ISO day number, 1 = Monday through 7 = Sunday.';

-- ---------------------------------------------------------------------------
-- dim_customer
--
-- Dimension keys are plain integers rather than IDENTITY columns: these tables
-- are reference data owned by the seed/ETL process, never inserted into by the
-- application, so there is no sequence worth keeping in sync.
-- ---------------------------------------------------------------------------
CREATE TABLE analytics.dim_customer (
  customer_id   integer  PRIMARY KEY,
  customer_name text     NOT NULL,
  email         text     NOT NULL,
  segment       text     NOT NULL,
  country       text     NOT NULL,
  region        text     NOT NULL,
  city          text     NOT NULL,
  signup_date   date     NOT NULL,
  CONSTRAINT dim_customer_segment_check
    CHECK (segment IN ('Consumer', 'Corporate', 'Home Office', 'Small Business'))
);

COMMENT ON TABLE analytics.dim_customer IS 'Customer dimension. Roughly 50k rows in the seeded dataset.';

-- ---------------------------------------------------------------------------
-- dim_product
-- ---------------------------------------------------------------------------
CREATE TABLE analytics.dim_product (
  product_id   integer       PRIMARY KEY,
  product_name text          NOT NULL,
  sku          text          NOT NULL UNIQUE,
  category     text          NOT NULL,
  subcategory  text          NOT NULL,
  brand        text          NOT NULL,
  unit_cost    numeric(10,2) NOT NULL,
  list_price   numeric(10,2) NOT NULL,
  CONSTRAINT dim_product_price_check CHECK (list_price >= unit_cost)
);

COMMENT ON TABLE analytics.dim_product IS 'Product dimension with a category > subcategory hierarchy.';

-- ---------------------------------------------------------------------------
-- dim_store
--
-- store_id is a smallint: the seeded dataset has 200 stores and a real
-- retailer of this shape would have thousands, not billions. Two bytes here
-- instead of four saves 4 MB across a 2M-row fact table and, more usefully,
-- keeps the fact row inside a tighter alignment envelope (see below).
-- ---------------------------------------------------------------------------
CREATE TABLE analytics.dim_store (
  store_id   smallint PRIMARY KEY,
  store_name text     NOT NULL,
  channel    text     NOT NULL,
  country    text     NOT NULL,
  region     text     NOT NULL,
  city       text     NOT NULL,
  opened_on  date     NOT NULL,
  CONSTRAINT dim_store_channel_check
    CHECK (channel IN ('Online', 'Retail', 'Wholesale', 'Partner'))
);

COMMENT ON TABLE analytics.dim_store IS 'Store / sales channel dimension.';

-- ---------------------------------------------------------------------------
-- fact_orders
--
-- One row per order line. Column order is deliberate: Postgres aligns fixed
-- width columns to their natural boundary and pads the gaps, so the 8-byte
-- columns come first, then 4-byte, then 2-byte, then the variable-length
-- values. Declaring them in a naive order costs several bytes of padding per
-- row, which is real money at 2M rows.
--
-- Money columns are numeric, not double precision. numeric is slower to
-- aggregate, but SUM(revenue) over two million float8 values accumulates
-- representation error and a dashboard that reports revenue has to be exact.
-- BENCHMARKS.md quantifies what that choice costs.
--
-- `profit` is a stored generated column so revenue - cost can never drift out
-- of sync with its inputs, and so the query engine can expose profit as a
-- first-class measure without teaching the compiler about expressions.
--
-- Foreign keys are declared and enforced. They do not create indexes on the
-- fact side, which is exactly what the "no index" benchmark baseline needs.
-- ---------------------------------------------------------------------------
CREATE TABLE analytics.fact_orders (
  order_id     bigint        GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ordered_at   timestamptz   NOT NULL,
  date_key     integer       NOT NULL,
  customer_id  integer       NOT NULL,
  product_id   integer       NOT NULL,
  store_id     smallint      NOT NULL,
  quantity     smallint      NOT NULL,
  unit_price   numeric(10,2) NOT NULL,
  discount_pct numeric(5,4)  NOT NULL DEFAULT 0,
  revenue      numeric(12,2) NOT NULL,
  cost         numeric(12,2) NOT NULL,
  profit       numeric(12,2) GENERATED ALWAYS AS (revenue - cost) STORED,
  order_status text          NOT NULL,

  CONSTRAINT fact_orders_date_fk
    FOREIGN KEY (date_key)    REFERENCES analytics.dim_date (date_key),
  CONSTRAINT fact_orders_customer_fk
    FOREIGN KEY (customer_id) REFERENCES analytics.dim_customer (customer_id),
  CONSTRAINT fact_orders_product_fk
    FOREIGN KEY (product_id)  REFERENCES analytics.dim_product (product_id),
  CONSTRAINT fact_orders_store_fk
    FOREIGN KEY (store_id)    REFERENCES analytics.dim_store (store_id),

  CONSTRAINT fact_orders_quantity_check CHECK (quantity > 0),
  CONSTRAINT fact_orders_discount_check CHECK (discount_pct >= 0 AND discount_pct < 1),
  CONSTRAINT fact_orders_status_check
    CHECK (order_status IN ('completed', 'pending', 'returned', 'cancelled'))
);

COMMENT ON TABLE analytics.fact_orders IS
  'Order line fact table. Target grain: one row per product per order. ~2,000,000 rows seeded.';
COMMENT ON COLUMN analytics.fact_orders.ordered_at IS
  'Full timestamp of the order. Redundant with date_key by design: date_key drives the star join, ordered_at preserves intraday granularity.';
COMMENT ON COLUMN analytics.fact_orders.profit IS
  'Generated column: revenue - cost. Cannot drift out of sync with its inputs.';
COMMENT ON COLUMN analytics.fact_orders.discount_pct IS
  'Fractional discount, 0.0000 to 0.9999. numeric(5,4) is the narrowest exact type that holds it.';

-- Down Migration

DROP SCHEMA IF EXISTS analytics CASCADE;
