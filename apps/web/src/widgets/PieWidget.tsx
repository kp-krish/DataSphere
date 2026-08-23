/**
 * Pie chart — part-to-whole, at a glance.
 *
 * Two constraints shape this component, both of them real limits rather than
 * styling choices.
 *
 * 1. Slices are capped at six, with the tail folded into a single neutral
 *    "Other". Past roughly six segments adjacent slices blur together, and past
 *    eight there is no ninth colour to give out — generating one would produce
 *    a hue indistinguishable from an existing slot under colour-vision
 *    deficiency.
 *
 * 2. Every slice is direct-labelled. A pie compares every slice with every
 *    other, so the all-pairs colour gate applies, and the first four slots of
 *    this palette clear it only in the 6–8 ΔE band — which is legal *only*
 *    with secondary encoding. The labels are that encoding, so identity never
 *    rests on colour alone. See lib/palette.ts.
 *
 * A pie is also often the wrong form: it is poor at comparing close values, and
 * a two-slice pie should be a stat tile. It is offered because part-to-whole at
 * a glance is a real job, not because it is a good default.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { ValueFormat } from '../lib/format.js';
import { CHART_INK, OTHER_COLOR, SURFACE_GAP_PX, seriesColor } from '../lib/palette.js';
import { ChartTooltip } from '../components/ChartParts.js';

export interface PieWidgetProps {
  rows: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
  format?: ValueFormat;
  height: number;
}

/** Beyond this, adjacent slices stop being separable. */
const MAX_SLICES = 6;

interface Slice {
  name: string;
  value: number;
  color: string;
}

/**
 * Sort by size, keep the top slices, and fold the rest into one "Other".
 *
 * Colour is assigned from the fold's own stable order, so a slice keeps its
 * hue as long as its rank does; "Other" always takes the neutral.
 */
function buildSlices(rows: Record<string, unknown>[], labelKey: string, valueKey: string): Slice[] {
  const parsed = rows
    .map((row) => ({
      name: String(row[labelKey] ?? '—'),
      value: Number(row[valueKey]),
    }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
    .sort((a, b) => b.value - a.value);

  if (parsed.length <= MAX_SLICES) {
    return parsed.map((entry, index) => ({ ...entry, color: seriesColor(index) }));
  }

  const head = parsed.slice(0, MAX_SLICES - 1);
  const tail = parsed.slice(MAX_SLICES - 1);

  return [
    ...head.map((entry, index) => ({ ...entry, color: seriesColor(index) })),
    {
      name: `Other (${tail.length})`,
      value: tail.reduce((sum, entry) => sum + entry.value, 0),
      color: OTHER_COLOR,
    },
  ];
}

export function PieWidget({ rows, labelKey, valueKey, format = 'number', height }: PieWidgetProps) {
  const slices = buildSlices(rows, labelKey, valueKey);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  if (slices.length === 0) return null;

  // Leave room for the outside labels so they are never clipped by the frame.
  const radius = Math.max(40, Math.min(height / 2 - 34, 120));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <Pie
          data={slices}
          dataKey="value"
          nameKey="name"
          outerRadius={radius}
          // A modest inner radius makes small slices easier to compare by arc
          // length, and gives the labels a cleaner leader line.
          innerRadius={radius * 0.55}
          // The gap between slices is the surface showing through.
          paddingAngle={1}
          stroke={CHART_INK.surface}
          strokeWidth={SURFACE_GAP_PX}
          isAnimationActive={false}
          labelLine={{ stroke: CHART_INK.axis }}
          // Direct labels: the secondary encoding the palette gate requires.
          //
          // Rendered through a custom element rather than by returning a
          // string, because Recharts paints a returned string in the *slice's*
          // colour - and text must never wear the data colour. It also lets a
          // low-share slice drop its label instead of colliding with its
          // neighbour, while staying readable in the tooltip and table view.
          label={renderSliceLabel(total)}
        >
          {slices.map((slice) => (
            <Cell key={slice.name} fill={slice.color} />
          ))}
        </Pie>
        <Tooltip
          content={
            <ChartTooltip
              format={format}
              // Recharts hands the slice name through as the label here.
              labelIsDate={false}
            />
          }
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

/**
 * Slice label renderer.
 *
 * Recharts hands over the polar geometry it already computed, so the label sits
 * on the same leader line it would have drawn anyway - only the fill and the
 * text are ours.
 */
interface SliceLabelProps {
  x?: number;
  y?: number;
  cx?: number;
  textAnchor?: string;
  name?: string;
  value?: number;
}

function renderSliceLabel(total: number) {
  return function SliceLabel(props: SliceLabelProps) {
    const { x = 0, y = 0, cx = 0, name = '', value = 0 } = props;
    const share = total > 0 ? (value / total) * 100 : 0;

    // Below ~5% the label collides with its neighbours. Those slices stay
    // readable through the legend, the tooltip and the table view.
    if (share < 5) return null;

    return (
      <text
        x={x}
        y={y}
        // Ink, not the slice colour.
        fill={CHART_INK.textSecondary}
        fontSize={11}
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
      >
        {`${name} ${share.toFixed(0)}%`}
      </text>
    );
  };
}

/** Legend entries, so the card can render them outside the SVG. */
export function pieLegendItems(
  rows: Record<string, unknown>[],
  labelKey: string,
  valueKey: string,
): { label: string; color: string }[] {
  return buildSlices(rows, labelKey, valueKey).map((slice) => ({
    label: slice.name,
    color: slice.color,
  }));
}
