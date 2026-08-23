/**
 * Line chart — change over time.
 *
 * Mark specs, from the visualization method:
 *   - 2px stroke, round join and cap
 *   - markers ≥8px (r≥4) with a 2px ring in the surface colour, so a point
 *     stays legible where two lines cross
 *   - hairline horizontal grid only; a vertical grid on a time axis is noise
 *   - crosshair + tooltip, because an SVG chart *is* interactive
 *
 * Markers are hidden when the series is dense: a dot on every one of 60 points
 * is a solid bar of colour, not a set of readable marks.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ValueFormat } from '../lib/format.js';
import { formatAxisTick, formatDate } from '../lib/format.js';
import { CHART_INK, SURFACE_GAP_PX, seriesColor } from '../lib/palette.js';
import { AXIS_PROPS, ChartTooltip, GRID_PROPS, X_AXIS_HEIGHT } from '../components/ChartParts.js';

export interface SeriesChartProps {
  rows: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  format?: ValueFormat;
  height: number;
  xIsDate?: boolean;
}

/** Past this many points, per-point markers stop being readable marks. */
const MARKER_DENSITY_LIMIT = 40;

export function LineWidget({
  rows,
  xKey,
  yKeys,
  format = 'number',
  height,
  xIsDate = false,
}: SeriesChartProps) {
  const showMarkers = rows.length <= MARKER_DENSITY_LIMIT;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis
          {...AXIS_PROPS}
          dataKey={xKey}
          height={X_AXIS_HEIGHT}
          tickFormatter={(value: unknown) => (xIsDate ? formatDate(value) : String(value ?? ''))}
          minTickGap={24}
        />
        <YAxis {...AXIS_PROPS} width={56} tickFormatter={formatAxisTick} />
        <Tooltip
          content={<ChartTooltip format={format} labelIsDate={xIsDate} />}
          // The crosshair is what makes a multi-series line readable: it ties
          // every series' value at one x to a single hover.
          cursor={{ stroke: CHART_INK.axis, strokeWidth: 1 }}
        />
        {yKeys.map((key, index) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={seriesColor(index)}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={
              showMarkers
                ? {
                    r: 4,
                    fill: seriesColor(index),
                    // The surface ring separates overlapping marks without
                    // drawing a border around them.
                    stroke: CHART_INK.surface,
                    strokeWidth: SURFACE_GAP_PX,
                  }
                : false
            }
            activeDot={{
              r: 5,
              fill: seriesColor(index),
              stroke: CHART_INK.surface,
              strokeWidth: SURFACE_GAP_PX,
            }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
