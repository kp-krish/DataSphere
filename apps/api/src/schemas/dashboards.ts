/**
 * Request schemas for dashboard and widget endpoints.
 *
 * A widget's `querySpec` is validated by the same schema the query endpoint
 * uses, and then compiled against the catalog before the widget is saved.
 * Storing a widget whose spec cannot compile would mean a dashboard that
 * looks fine in the list and fails only when someone opens it - so the
 * failure is moved to the moment of saving, where the person who caused it is
 * still looking at it.
 */

import { z } from 'zod';
import { querySpecSchema } from './query.js';

export const uuidParamSchema = z.uuid('Expected a UUID');

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

export const createDashboardSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name cannot be blank').max(120),
  description: z.string().trim().max(1_000).nullish(),
});

/**
 * PATCH semantics: every field optional, but at least one present. An empty
 * body is almost always a client bug, and answering 200 to it hides that.
 */
export const updateDashboardSchema = createDashboardSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

export const widgetConfigSchema = z.strictObject({
  xKey: z.string().max(63).optional(),
  yKeys: z.array(z.string().max(63)).max(12).optional(),
  valueKey: z.string().max(63).optional(),
  format: z.enum(['number', 'currency', 'percent', 'compact']).optional(),
  stacked: z.boolean().optional(),
  showLegend: z.boolean().optional(),
  /**
   * Seconds between automatic refreshes; 0 disables live updates. Floored at
   * 5 so a widget cannot be configured to hammer the API every tick.
   */
  refreshInterval: z.union([z.literal(0), z.number().int().min(5).max(3_600)]).optional(),
});

export const createWidgetSchema = z.strictObject({
  title: z.string().trim().min(1, 'Title cannot be blank').max(120),
  type: z.enum(['line', 'bar', 'pie', 'kpi', 'table']),
  querySpec: querySpecSchema,
  config: widgetConfigSchema.default({}),
  // Bounds mirror the CHECK constraints on app.widgets, so a violation is a
  // 400 with a useful message rather than a 500 from Postgres.
  width: z.number().int().min(1).max(12).optional(),
  height: z.number().int().min(1).max(6).optional(),
  position: z.number().int().min(0).max(1_000).optional(),
});

export const updateWidgetSchema = createWidgetSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * Drag-to-reorder. The client sends the widget ids in their new visual order
 * and the server assigns positions from that, rather than the client sending
 * computed indices. Fewer ways for the two to disagree.
 */
export const reorderWidgetsSchema = z.strictObject({
  widgetIds: z.array(uuidParamSchema).min(1).max(100),
});

export type CreateDashboardInput = z.infer<typeof createDashboardSchema>;
export type UpdateDashboardInput = z.infer<typeof updateDashboardSchema>;
export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;
