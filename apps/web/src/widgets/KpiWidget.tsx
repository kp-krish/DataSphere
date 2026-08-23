/**
 * KPI stat tile — when the form is a single number.
 *
 * A one-bar bar chart is the classic way to miss this: if the story is one
 * value, the number *is* the chart. No axes, no legend, no plot.
 *
 * The tile deliberately shows no delta. A signed "vs last period" needs a
 * comparison window the widget was never asked to fetch, and inventing one
 * would be a fabricated number on a dashboard - the one place that is least
 * acceptable.
 *
 * The value uses proportional figures, not `tabular-nums`: equal-width digits
 * make a number like 121 look loose at display sizes. Tabular figures are for
 * columns that must align, which is the table view's job.
 */

import type { ValueFormat } from '../lib/format.js';
import { formatValue, humanizeAlias } from '../lib/format.js';

export interface KpiWidgetProps {
  rows: Record<string, unknown>[];
  valueKey: string;
  format?: ValueFormat;
  /** Dimension column, when the KPI is "the top row of a grouped result". */
  labelKey?: string;
}

export function KpiWidget({ rows, valueKey, format = 'number', labelKey }: KpiWidgetProps) {
  const row = rows[0];

  if (!row || row[valueKey] === undefined) {
    return (
      <div className="kpi">
        <div className="kpi__value muted">—</div>
        <div className="kpi__label">No value returned</div>
      </div>
    );
  }

  const value = row[valueKey];

  return (
    <div className="kpi">
      <div className="kpi__value" title={formatValue(value, format)}>
        {/* Auto-compact: 12.9K rather than 12,904, so the figure never wraps. */}
        {formatValue(value, format, true)}
      </div>
      <div className="kpi__label">{humanizeAlias(valueKey)}</div>

      {labelKey && row[labelKey] !== undefined && (
        <div className="kpi__context">{String(row[labelKey])}</div>
      )}

      {rows.length > 1 && (
        <div className="kpi__context">
          Top of {rows.length.toLocaleString()} rows — see the table view for the rest.
        </div>
      )}
    </div>
  );
}
