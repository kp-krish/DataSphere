/**
 * Dashboard and widget CRUD.
 *
 * One rule shapes most of this file: a widget's query spec is compiled against
 * the catalog before the widget is written. A dashboard containing a widget
 * that cannot compile is a dashboard that looks fine in the list and breaks
 * only when someone opens it, and by then whoever created it has moved on.
 * Compiling at write time moves the failure to the person who can still fix
 * it, and the error they get is the compiler's own - naming the column, not
 * just saying "invalid".
 */

import { Router } from 'express';
import type { QuerySpec } from '@datasphere/core';
import {
  createDashboardSchema,
  createWidgetSchema,
  reorderWidgetsSchema,
  updateDashboardSchema,
  updateWidgetSchema,
  uuidParamSchema,
} from '../schemas/dashboards.js';
import * as repository from '../dashboards/repository.js';
import { ReorderMismatchError } from '../dashboards/repository.js';
import { compileOnly, executeQuery } from '../query/service.js';
import { ApiError } from '../http/errors.js';

export const dashboardsRouter: Router = Router();

/**
 * Parse a path parameter as a UUID.
 *
 * Without this, `GET /api/dashboards/not-a-uuid` reaches Postgres and comes
 * back as a 500 from a failed uuid cast. With it, the caller gets a 400 that
 * says what was wrong.
 */
function parseId(value: string | undefined, resource: string): string {
  const parsed = uuidParamSchema.safeParse(value);
  if (!parsed.success) {
    throw ApiError.badRequest('invalid_id', `"${value}" is not a valid ${resource} id`);
  }
  return parsed.data;
}

/** Compile the spec purely to validate it; the SQL is discarded. */
async function assertSpecIsQueryable(spec: QuerySpec): Promise<void> {
  await compileOnly(spec);
}

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

dashboardsRouter.get('/dashboards', async (_req, res) => {
  res.json({ dashboards: await repository.listDashboards() });
});

dashboardsRouter.post('/dashboards', async (req, res) => {
  const input = createDashboardSchema.parse(req.body);
  const dashboard = await repository.createDashboard(input);

  res.status(201).location(`/api/dashboards/${dashboard.id}`).json(dashboard);
});

dashboardsRouter.get('/dashboards/:id', async (req, res) => {
  const id = parseId(req.params.id, 'dashboard');

  const dashboard = await repository.findDashboardWithWidgets(id);
  if (!dashboard) throw ApiError.notFound('dashboard', id);

  res.json(dashboard);
});

dashboardsRouter.patch('/dashboards/:id', async (req, res) => {
  const id = parseId(req.params.id, 'dashboard');
  const input = updateDashboardSchema.parse(req.body);

  const dashboard = await repository.updateDashboard(id, input);
  if (!dashboard) throw ApiError.notFound('dashboard', id);

  res.json(dashboard);
});

dashboardsRouter.delete('/dashboards/:id', async (req, res) => {
  const id = parseId(req.params.id, 'dashboard');

  // Widgets go with it: app.widgets.dashboard_id is ON DELETE CASCADE.
  const deleted = await repository.deleteDashboard(id);
  if (!deleted) throw ApiError.notFound('dashboard', id);

  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* Widgets on a dashboard                                                     */
/* -------------------------------------------------------------------------- */

dashboardsRouter.get('/dashboards/:id/widgets', async (req, res) => {
  const id = parseId(req.params.id, 'dashboard');

  // Distinguish "no widgets" from "no dashboard" - an empty array for a
  // dashboard that does not exist would hide a client bug.
  if (!(await repository.findDashboard(id))) throw ApiError.notFound('dashboard', id);

  res.json({ widgets: await repository.listWidgets(id) });
});

dashboardsRouter.post('/dashboards/:id/widgets', async (req, res) => {
  const dashboardId = parseId(req.params.id, 'dashboard');
  const input = createWidgetSchema.parse(req.body);

  if (!(await repository.findDashboard(dashboardId))) {
    throw ApiError.notFound('dashboard', dashboardId);
  }

  // Compiles or throws; a widget with an unqueryable spec is never written.
  await assertSpecIsQueryable(input.querySpec);

  const widget = await repository.createWidget(dashboardId, input);
  res.status(201).location(`/api/widgets/${widget.id}`).json(widget);
});

/**
 * Apply a new widget order.
 *
 * PUT because it replaces the ordering wholesale and is idempotent - sending
 * the same order twice leaves the same state, which matters when a drag
 * gesture retries on a flaky connection.
 */
dashboardsRouter.put('/dashboards/:id/widgets/order', async (req, res) => {
  const dashboardId = parseId(req.params.id, 'dashboard');
  const { widgetIds } = reorderWidgetsSchema.parse(req.body);

  if (!(await repository.findDashboard(dashboardId))) {
    throw ApiError.notFound('dashboard', dashboardId);
  }

  const unique = new Set(widgetIds);
  if (unique.size !== widgetIds.length) {
    throw ApiError.badRequest('duplicate_widget_id', 'The widget order contains duplicate ids');
  }

  try {
    const { widgets } = await repository.reorderWidgets(dashboardId, widgetIds);
    res.json({ widgets });
  } catch (error) {
    // Some id in the list is not on this dashboard. The transaction rolled
    // back, so the previous order is intact.
    if (error instanceof ReorderMismatchError) {
      throw ApiError.badRequest(
        'widget_not_on_dashboard',
        'Every widget id must belong to this dashboard',
        { expected: error.expected, matched: error.matched },
      );
    }
    throw error;
  }
});

/* -------------------------------------------------------------------------- */
/* Widgets by id                                                              */
/* -------------------------------------------------------------------------- */

export const widgetsRouter: Router = Router();

widgetsRouter.get('/widgets/:id', async (req, res) => {
  const id = parseId(req.params.id, 'widget');

  const widget = await repository.findWidget(id);
  if (!widget) throw ApiError.notFound('widget', id);

  res.json(widget);
});

widgetsRouter.patch('/widgets/:id', async (req, res) => {
  const id = parseId(req.params.id, 'widget');
  const input = updateWidgetSchema.parse(req.body);

  if (input.querySpec !== undefined) {
    await assertSpecIsQueryable(input.querySpec);
  }

  const widget = await repository.updateWidget(id, input);
  if (!widget) throw ApiError.notFound('widget', id);

  res.json(widget);
});

widgetsRouter.delete('/widgets/:id', async (req, res) => {
  const id = parseId(req.params.id, 'widget');

  const deleted = await repository.deleteWidget(id);
  if (!deleted) throw ApiError.notFound('widget', id);

  res.status(204).end();
});

/**
 * Run a widget's stored spec and return its data.
 *
 * GET, because it is a read with no body: the spec is already on the server.
 * This is the endpoint the dashboard grid polls, so it is the one whose cache
 * behaviour matters most - hence `?noCache=1` for a manual refresh.
 */
widgetsRouter.get('/widgets/:id/data', async (req, res) => {
  const id = parseId(req.params.id, 'widget');

  const widget = await repository.findWidget(id);
  if (!widget) throw ApiError.notFound('widget', id);

  const result = await executeQuery(widget.querySpec, {
    noCache: req.query.noCache === '1' || req.query.noCache === 'true',
    includeSql: req.query.includeSql === '1' || req.query.includeSql === 'true',
  });

  res.json({ widgetId: widget.id, ...result });
});
