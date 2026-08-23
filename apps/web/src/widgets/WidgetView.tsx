/**
 * Renders a result set as whichever widget type was chosen.
 *
 * This is also where the chart/table toggle lives, because every chart form
 * needs the same table-view twin and it would be wasteful to reimplement the
 * fallback per type.
 *
 * Deciding which column is the axis and which are the series is done here
 * rather than being demanded of the user: a saved widget's config may name
 * them explicitly, but a spec compiled a moment ago in the builder has not
 * been configured yet, and it should still render something sensible.
 */

import type { QueryResult, WidgetConfig, WidgetType } from '@datasphere/core';
import type { ValueFormat } from '../lib/format.js';
import { seriesColor } from '../lib/palette.js';
import { ChartEmpty, ChartLegend, isTemporalColumn } from '../components/ChartParts.js';
import { DataTable } from '../components/DataTable.js';
import { BarWidget } from './BarWidget.js';
import { KpiWidget } from './KpiWidget.js';
import { LineWidget } from './LineWidget.js';
import { PieWidget, pieLegendItems } from './PieWidget.js';

export interface WidgetViewProps {
  type: WidgetType;
  result: QueryResult;
  config?: WidgetConfig;
  /** Plot height in px, excluding the legend beneath it. */
  height?: number;
  /** Show the table twin instead of the chart. */
  asTable?: boolean;
}

/**
 * Work out the axis and series columns.
 *
 * A compiled result puts dimensions before measures in `columns`, so the split
 * point is the first column whose values are numeric. That is more reliable
 * than counting, because a spec may have no dimensions at all (a KPI) or no
 * measures (a distinct list).
 */
export function inferKeys(result: QueryResult): { dimensions: string[]; measures: string[] } {
  const first = result.rows[0];
  if (!first) return { dimensions: result.columns, measures: [] };

  const measures = result.columns.filter((column) => typeof first[column] === 'number');
  const dimensions = result.columns.filter((column) => !measures.includes(column));

  return { dimensions, measures };
}

export function WidgetView({
  type,
  result,
  config = {},
  height = 240,
  asTable = false,
}: WidgetViewProps) {
  const { rows, columns } = result;
  const { dimensions, measures } = inferKeys(result);

  const format: ValueFormat = config.format ?? 'number';

  const xKey = config.xKey && columns.includes(config.xKey) ? config.xKey : dimensions[0];
  const yKeys =
    config.yKeys?.filter((key) => columns.includes(key)) ?? (measures.length > 0 ? measures : []);

  if (rows.length === 0) return <ChartEmpty />;

  /* ---- table view, and the `table` type itself --------------------------- */
  if (asTable || type === 'table') {
    return (
      <DataTable
        columns={columns}
        rows={rows}
        numericColumns={measures}
        format={format}
        maxRows={500}
      />
    );
  }

  /* ---- KPI --------------------------------------------------------------- */
  if (type === 'kpi') {
    const valueKey =
      (config.valueKey && columns.includes(config.valueKey) ? config.valueKey : undefined) ??
      measures[0] ??
      columns[0]!;

    return <KpiWidget rows={rows} valueKey={valueKey} format={format} labelKey={dimensions[0]} />;
  }

  /* ---- pie --------------------------------------------------------------- */
  if (type === 'pie') {
    const labelKey = xKey ?? columns[0]!;
    const valueKey = config.valueKey ?? yKeys[0] ?? measures[0];

    if (!valueKey) {
      return <ChartEmpty>A pie needs one measure to size its slices.</ChartEmpty>;
    }

    return (
      <div className="chart">
        <PieWidget
          rows={rows}
          labelKey={labelKey}
          valueKey={valueKey}
          format={format}
          height={height}
        />
        {/* Rendered outside the SVG so it wraps and stays selectable text. */}
        <ChartLegend items={pieLegendItems(rows, labelKey, valueKey)} />
      </div>
    );
  }

  /* ---- line and bar ------------------------------------------------------ */
  if (!xKey || yKeys.length === 0) {
    return (
      <ChartEmpty>
        This chart needs one dimension for the axis and at least one measure. The table view shows
        the raw result.
      </ChartEmpty>
    );
  }

  const xIsDate = isTemporalColumn(rows, xKey);
  const legendItems = yKeys.map((key, index) => ({ label: key, color: seriesColor(index) }));

  return (
    <div className="chart">
      {type === 'line' ? (
        <LineWidget
          rows={rows}
          xKey={xKey}
          yKeys={yKeys}
          format={format}
          height={height}
          xIsDate={xIsDate}
        />
      ) : (
        <BarWidget
          rows={rows}
          xKey={xKey}
          yKeys={yKeys}
          format={format}
          height={height}
          stacked={config.stacked ?? false}
          xIsDate={xIsDate}
        />
      )}
      <ChartLegend items={legendItems} />
    </div>
  );
}

/** Sensible defaults for a newly created widget, derived from its result. */
export function defaultConfigFor(type: WidgetType, result: QueryResult): WidgetConfig {
  const { dimensions, measures } = inferKeys(result);

  const config: WidgetConfig = { showLegend: true };
  if (dimensions[0]) config.xKey = dimensions[0];
  if (measures.length > 0) config.yKeys = measures;
  if (measures[0]) config.valueKey = measures[0];
  if (type === 'kpi') config.format = 'number';

  return config;
}
