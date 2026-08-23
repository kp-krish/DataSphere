/**
 * Tabular view of a result set.
 *
 * Used both as the `table` widget type and as the accessible twin behind every
 * chart. That twin is not a nicety: colour encoding alone fails for readers who
 * cannot distinguish the hues, and a tooltip that is the only way to read a
 * value is unreachable by keyboard. The table is the WCAG-clean equivalent, so
 * every value a chart shows is readable without relying on colour or hover.
 */

import type { ValueFormat } from '../lib/format.js';
import { formatDate, formatValue, humanizeAlias, looksTemporal } from '../lib/format.js';

export interface DataTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Aliases that hold measures, so they can be right-aligned and formatted. */
  numericColumns?: string[];
  format?: ValueFormat;
  maxRows?: number;
}

export function DataTable({
  columns,
  rows,
  numericColumns = [],
  format = 'number',
  maxRows,
}: DataTableProps) {
  const visible = maxRows ? rows.slice(0, maxRows) : rows;
  const numeric = new Set(numericColumns);

  // Detect date columns once for the whole table rather than per cell.
  const temporal = new Set(
    columns.filter(
      (column) => !numeric.has(column) && looksTemporal(rows.map((row) => row[column])),
    ),
  );

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className={numeric.has(column) ? 'th--numeric' : undefined}
                scope="col"
              >
                {humanizeAlias(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const value = row[column];
                return (
                  <td key={column} className={numeric.has(column) ? 'td--numeric' : undefined}>
                    {numeric.has(column)
                      ? formatValue(value, format)
                      : temporal.has(column)
                        ? formatDate(value)
                        : ((value ?? '—') as string)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {maxRows && rows.length > maxRows && (
        <p className="muted" style={{ padding: '0.5rem 0.6rem', margin: 0, fontSize: '0.78rem' }}>
          Showing {maxRows.toLocaleString()} of {rows.length.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}
