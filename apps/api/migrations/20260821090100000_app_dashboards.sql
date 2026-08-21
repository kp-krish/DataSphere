-- Up Migration
--
-- Application state: saved dashboards and the widgets on them.
--
-- These live in the `app` schema, deliberately separate from `analytics`.
-- The query engine's allowlist is built by introspecting `analytics` only, so
-- no query spec a user can construct is capable of naming these tables.

CREATE SCHEMA IF NOT EXISTS app;

-- Shared trigger function keeping updated_at honest without the API having to
-- remember to set it on every UPDATE path.
CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- dashboards
--
-- UUID primary keys rather than serials: dashboard ids appear in URLs that
-- get shared, and a sequential id leaks how many dashboards exist while also
-- inviting people to walk the range.
-- ---------------------------------------------------------------------------
CREATE TABLE app.dashboards (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboards_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TRIGGER dashboards_set_updated_at
  BEFORE UPDATE ON app.dashboards
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

COMMENT ON TABLE app.dashboards IS 'A saved dashboard: a named container for widgets.';

-- ---------------------------------------------------------------------------
-- widgets
--
-- query_spec is jsonb, not text: it is read and compared far more often than
-- it is written, jsonb parses once on write instead of on every read, and it
-- lets us query into the spec later (for example, to find every widget that
-- touches a given table when invalidating cache).
-- ---------------------------------------------------------------------------
CREATE TABLE app.widgets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid        NOT NULL REFERENCES app.dashboards (id) ON DELETE CASCADE,
  title        text        NOT NULL,
  type         text        NOT NULL,
  query_spec   jsonb       NOT NULL,
  config       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  position     integer     NOT NULL DEFAULT 0,
  width        smallint    NOT NULL DEFAULT 6,
  height       smallint    NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT widgets_type_check
    CHECK (type IN ('line', 'bar', 'pie', 'kpi', 'table')),
  CONSTRAINT widgets_width_check  CHECK (width BETWEEN 1 AND 12),
  CONSTRAINT widgets_height_check CHECK (height BETWEEN 1 AND 6),
  CONSTRAINT widgets_title_not_blank CHECK (length(btrim(title)) > 0)
);

CREATE TRIGGER widgets_set_updated_at
  BEFORE UPDATE ON app.widgets
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Every widget read is "give me the widgets for this dashboard, in order".
-- The composite index serves both the filter and the sort, so the plan is an
-- index scan with no sort node on top.
CREATE INDEX widgets_dashboard_position_idx
  ON app.widgets (dashboard_id, position);

COMMENT ON TABLE app.widgets IS 'A single visualization on a dashboard, storing the query spec that feeds it.';
COMMENT ON COLUMN app.widgets.query_spec IS 'The JSON query spec compiled to SQL by the query engine.';
COMMENT ON COLUMN app.widgets.position IS 'Ordinal within the dashboard grid, maintained by drag-to-reorder.';

-- Down Migration

DROP SCHEMA IF EXISTS app CASCADE;
