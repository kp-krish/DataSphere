/**
 * Shared chart chrome: tooltip and legend.
 *
 * Both are written by hand rather than using Recharts' defaults, because the
 * defaults wear the series colour on their text. Text stays in ink tokens; a
 * coloured swatch beside it carries identity. That keeps every label legible
 * at the palette's lower-contrast slots.
 */

import type { ReactNode } from 'react';
import type { ValueFormat } from '../lib/format.js';
import { formatDate, formatValue, humanizeAlias, looksTemporal } from '../lib/format.js';
import { CHART_INK } from '../lib/palette.js';

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                    */
/* -------------------------------------------------------------------------- */

interface TooltipEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: unknown;
  format?: ValueFormat;
  /** Renders the category label; dates get formatted, everything else is text. */
  labelIsDate?: boolean;
}

export function ChartTooltip({
  active,
  payload,
  label,
  format = 'number',
  labelIsDate = false,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="tooltip" role="tooltip">
      {label !== undefined && label !== null && (
        <div className="tooltip__label">{labelIsDate ? formatDate(label) : String(label)}</div>
      )}
      {payload.map((entry, index) => (
        <div className="tooltip__row" key={`${String(entry.dataKey)}-${index}`}>
          <span className="chart__swatch" style={{ background: entry.color }} aria-hidden="true" />
          <span>{humanizeAlias(String(entry.name ?? entry.dataKey ?? ''))}</span>
          <span className="tooltip__value">{formatValue(entry.value, format)}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Legend                                                                     */
/* -------------------------------------------------------------------------- */

export interface LegendItem {
  label: string;
  color: string;
}

/**
 * A legend is always present for two or more series, so identity never rests
 * on colour alone. A single series needs none - the widget title names it.
 */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;

  return (
    <div className="chart__legend">
      {items.map((item) => (
        <span className="chart__legend-item" key={item.label}>
          <span className="chart__swatch" style={{ background: item.color }} aria-hidden="true" />
          {humanizeAlias(item.label)}
        </span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Axis defaults                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Recessive axis styling, applied identically everywhere.
 *
 * Hairline, solid, one step off the surface. Dashed gridlines read as
 * "threshold" or "projection" when they are just a grid.
 */
export const AXIS_PROPS = {
  stroke: CHART_INK.axis,
  tick: { fill: CHART_INK.muted, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: CHART_INK.axis },
} as const;

export const GRID_PROPS = {
  stroke: CHART_INK.grid,
  strokeWidth: 1,
  vertical: false,
} as const;

/** Height reserved for the x-axis band, so the plot never crowds its labels. */
export const X_AXIS_HEIGHT = 28;

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

export function ChartEmpty({ children }: { children?: ReactNode }) {
  return (
    <div className="empty" style={{ padding: '2rem 1rem' }}>
      {children ?? 'No rows matched this query.'}
    </div>
  );
}

/**
 * Decide whether a dimension column should be treated as temporal, so the axis
 * and tooltip format it as a date rather than printing a raw ISO string.
 */
export function isTemporalColumn(rows: Record<string, unknown>[], key: string): boolean {
  return looksTemporal(rows.map((row) => row[key]));
}
