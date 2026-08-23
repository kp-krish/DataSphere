/**
 * Bar / column chart — magnitude comparison.
 *
 * Mark specs, from the visualization method:
 *   - bars capped at 24px thick; the band's leftover width is air, not bar
 *   - 4px rounded data-end, square at the baseline, growing from one baseline
 *   - a 2px surface-coloured gap between adjacent bars and between stacked
 *     segments — negative space does the separating, never a stroke
 *   - hairline horizontal grid; the categorical axis needs no gridlines
 *
 * One series gets one colour (slot 1) for every bar. Colouring each bar
 * darker-where-bigger would double-encode length as hue and burn the only free
 * channel on information the bar length already shows.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ValueFormat } from '../lib/format.js';
import { formatAxisTick, formatDate } from '../lib/format.js';
import { CHART_INK, SURFACE_GAP_PX, seriesColor } from '../lib/palette.js';
import { AXIS_PROPS, ChartTooltip, GRID_PROPS, X_AXIS_HEIGHT } from '../components/ChartParts.js';

export interface BarWidgetProps {
  rows: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  format?: ValueFormat;
  height: number;
  stacked?: boolean;
  xIsDate?: boolean;
}

const MAX_BAR_THICKNESS = 24;

export function BarWidget({
  rows,
  xKey,
  yKeys,
  format = 'number',
  height,
  stacked = false,
  xIsDate = false,
}: BarWidgetProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis
          {...AXIS_PROPS}
          dataKey={xKey}
          height={X_AXIS_HEIGHT}
          tickFormatter={(value: unknown) => (xIsDate ? formatDate(value) : String(value ?? ''))}
          interval="preserveStartEnd"
        />
        <YAxis {...AXIS_PROPS} width={56} tickFormatter={formatAxisTick} />
        <Tooltip
          content={<ChartTooltip format={format} labelIsDate={xIsDate} />}
          // A translucent wash rather than a filled block: the cursor should
          // locate the band, not repaint it.
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
        />
        {yKeys.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            fill={seriesColor(index)}
            maxBarSize={MAX_BAR_THICKNESS}
            // Rounded at the data end, square at the baseline. Recharts takes
            // the radius corner-wise starting top-left.
            radius={stacked && index < yKeys.length - 1 ? 0 : [4, 4, 0, 0]}
            {...(stacked
              ? {
                  stackId: 'stack',
                  // The gap between stacked segments is painted in the surface
                  // colour, which is what separates them without a border.
                  stroke: CHART_INK.surface,
                  strokeWidth: SURFACE_GAP_PX,
                }
              : {})}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
