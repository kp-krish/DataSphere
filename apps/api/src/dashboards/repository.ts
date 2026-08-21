/**
 * Data access for dashboards and widgets.
 *
 * Every statement here is hand-written and parameterised. Note the contrast
 * with the analytics side: these queries are *fixed* - their shape is decided
 * at build time and only the values vary - which is exactly why they need no
 * compiler. The compiler exists for the queries whose shape a user chooses.
 *
 * SQL lives in this module and nowhere else, so the routes deal in domain
 * objects and there is one place to look when a query needs tuning.
 */

import type { PoolClient } from 'pg';
import type { Dashboard, QuerySpec, Widget, WidgetConfig } from '@datasphere/core';
import { pool, withTransaction } from '../db/pool.js';
import type {
  CreateDashboardInput,
  CreateWidgetInput,
  UpdateDashboardInput,
  UpdateWidgetInput,
} from '../schemas/dashboards.js';

/* -------------------------------------------------------------------------- */
/* Row shapes and mapping                                                     */
/* -------------------------------------------------------------------------- */

interface DashboardRow {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

interface WidgetRow {
  id: string;
  dashboard_id: string;
  title: string;
  type: Widget['type'];
  query_spec: QuerySpec;
  config: WidgetConfig;
  position: number;
  width: number;
  height: number;
  created_at: Date;
  updated_at: Date;
}

// snake_case in the database, camelCase over the wire. The translation lives
// here so no route has to think about it.
function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toWidget(row: WidgetRow): Widget {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    title: row.title,
    type: row.type,
    // jsonb comes back already parsed by `pg`.
    querySpec: row.query_spec,
    config: row.config,
    position: row.position,
    width: row.width,
    height: row.height,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const DASHBOARD_COLUMNS = 'id, name, description, created_at, updated_at';
const WIDGET_COLUMNS =
  'id, dashboard_id, title, type, query_spec, config, position, width, height, created_at, updated_at';

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary extends Dashboard {
  widgetCount: number;
}

/**
 * All dashboards, newest activity first, each with its widget count.
 *
 * The count comes from a lateral subquery rather than a join with GROUP BY:
 * grouping would force every dashboard column into the GROUP BY clause for no
 * benefit, and this reads closer to what it means.
 */
export async function listDashboards(): Promise<DashboardSummary[]> {
  const { rows } = await pool.query<DashboardRow & { widget_count: string }>(
    `SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
            (SELECT count(*) FROM app.widgets w WHERE w.dashboard_id = d.id) AS widget_count
       FROM app.dashboards d
      ORDER BY d.updated_at DESC, d.id`,
  );

  return rows.map((row) => ({ ...toDashboard(row), widgetCount: Number(row.widget_count) }));
}

export async function findDashboard(id: string): Promise<Dashboard | null> {
  const { rows } = await pool.query<DashboardRow>(
    `SELECT ${DASHBOARD_COLUMNS} FROM app.dashboards WHERE id = $1`,
    [id],
  );
  return rows[0] ? toDashboard(rows[0]) : null;
}

/** A dashboard together with its widgets in display order. */
export async function findDashboardWithWidgets(id: string): Promise<Dashboard | null> {
  const dashboard = await findDashboard(id);
  if (!dashboard) return null;

  return { ...dashboard, widgets: await listWidgets(id) };
}

export async function createDashboard(input: CreateDashboardInput): Promise<Dashboard> {
  const { rows } = await pool.query<DashboardRow>(
    `INSERT INTO app.dashboards (name, description)
     VALUES ($1, $2)
     RETURNING ${DASHBOARD_COLUMNS}`,
    [input.name, input.description ?? null],
  );
  return toDashboard(rows[0]!);
}

/**
 * Partial update.
 *
 * COALESCE with a sentinel would misread an explicit `null` description as
 * "leave unchanged", so the SET list is assembled from the keys actually
 * present. The column names come from a fixed map, never from the request.
 */
export async function updateDashboard(
  id: string,
  input: UpdateDashboardInput,
): Promise<Dashboard | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    assignments.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    assignments.push(`description = $${values.length}`);
  }
  if (assignments.length === 0) return findDashboard(id);

  values.push(id);
  const { rows } = await pool.query<DashboardRow>(
    `UPDATE app.dashboards
        SET ${assignments.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${DASHBOARD_COLUMNS}`,
    values,
  );
  return rows[0] ? toDashboard(rows[0]) : null;
}

/** Returns true when a row was actually removed. Widgets cascade. */
export async function deleteDashboard(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM app.dashboards WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

export async function listWidgets(dashboardId: string): Promise<Widget[]> {
  // Served by widgets_dashboard_position_idx: index scan, no sort node.
  const { rows } = await pool.query<WidgetRow>(
    `SELECT ${WIDGET_COLUMNS}
       FROM app.widgets
      WHERE dashboard_id = $1
      ORDER BY position, created_at`,
    [dashboardId],
  );
  return rows.map(toWidget);
}

export async function findWidget(id: string): Promise<Widget | null> {
  const { rows } = await pool.query<WidgetRow>(
    `SELECT ${WIDGET_COLUMNS} FROM app.widgets WHERE id = $1`,
    [id],
  );
  return rows[0] ? toWidget(rows[0]) : null;
}

/**
 * Append a widget to a dashboard.
 *
 * When the client does not pin a position, the next one is computed in the
 * same statement. Doing it in a separate SELECT would race two concurrent
 * creates into the same position.
 */
export async function createWidget(dashboardId: string, input: CreateWidgetInput): Promise<Widget> {
  const { rows } = await pool.query<WidgetRow>(
    `INSERT INTO app.widgets (dashboard_id, title, type, query_spec, config, position, width, height)
     VALUES (
       $1, $2, $3, $4::jsonb, $5::jsonb,
       COALESCE($6, (SELECT COALESCE(max(position), -1) + 1 FROM app.widgets WHERE dashboard_id = $1)),
       COALESCE($7, 6), COALESCE($8, 1)
     )
     RETURNING ${WIDGET_COLUMNS}`,
    [
      dashboardId,
      input.title,
      input.type,
      JSON.stringify(input.querySpec),
      JSON.stringify(input.config ?? {}),
      input.position ?? null,
      input.width ?? null,
      input.height ?? null,
    ],
  );
  return toWidget(rows[0]!);
}

export async function updateWidget(id: string, input: UpdateWidgetInput): Promise<Widget | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  const push = (fragment: (placeholder: string) => string, value: unknown): void => {
    values.push(value);
    assignments.push(fragment(`$${values.length}`));
  };

  if (input.title !== undefined) push((p) => `title = ${p}`, input.title);
  if (input.type !== undefined) push((p) => `type = ${p}`, input.type);
  if (input.querySpec !== undefined) {
    push((p) => `query_spec = ${p}::jsonb`, JSON.stringify(input.querySpec));
  }
  if (input.config !== undefined) push((p) => `config = ${p}::jsonb`, JSON.stringify(input.config));
  if (input.position !== undefined) push((p) => `position = ${p}`, input.position);
  if (input.width !== undefined) push((p) => `width = ${p}`, input.width);
  if (input.height !== undefined) push((p) => `height = ${p}`, input.height);

  if (assignments.length === 0) return findWidget(id);

  values.push(id);
  const { rows } = await pool.query<WidgetRow>(
    `UPDATE app.widgets
        SET ${assignments.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${WIDGET_COLUMNS}`,
    values,
  );
  return rows[0] ? toWidget(rows[0]) : null;
}

export async function deleteWidget(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM app.widgets WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export interface ReorderOutcome {
  /** False when an id in the list does not belong to this dashboard. */
  ok: boolean;
  widgets: Widget[];
}

/**
 * Assign positions from the given order.
 *
 * One UPDATE joined against the id array `WITH ORDINALITY`, which is where the
 * new position comes from. Sending one UPDATE per widget would be N round
 * trips and would briefly leave the board in an order the user never chose.
 *
 * The `dashboard_id` predicate is what stops a caller reordering widgets that
 * belong to somebody else's dashboard by listing their ids: those rows simply
 * do not match, the affected count comes up short, and the whole transaction
 * rolls back.
 */
export async function reorderWidgets(
  dashboardId: string,
  widgetIds: string[],
): Promise<ReorderOutcome> {
  return withTransaction(async (client: PoolClient) => {
    const result = await client.query(
      `UPDATE app.widgets AS w
          SET position = v.ord - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, ord)
        WHERE w.id = v.id
          AND w.dashboard_id = $1`,
      [dashboardId, widgetIds],
    );

    if ((result.rowCount ?? 0) !== widgetIds.length) {
      throw new ReorderMismatchError(widgetIds.length, result.rowCount ?? 0);
    }

    const { rows } = await client.query<WidgetRow>(
      `SELECT ${WIDGET_COLUMNS}
         FROM app.widgets
        WHERE dashboard_id = $1
        ORDER BY position, created_at`,
      [dashboardId],
    );

    return { ok: true, widgets: rows.map(toWidget) };
  });
}

/** Thrown when a reorder names widgets that are not on the target dashboard. */
export class ReorderMismatchError extends Error {
  readonly expected: number;
  readonly matched: number;

  constructor(expected: number, matched: number) {
    super(`Expected to reorder ${expected} widget(s) but ${matched} matched this dashboard`);
    this.name = 'ReorderMismatchError';
    this.expected = expected;
    this.matched = matched;
    Object.setPrototypeOf(this, ReorderMismatchError.prototype);
  }
}
