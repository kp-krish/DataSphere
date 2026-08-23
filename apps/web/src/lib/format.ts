/**
 * Value formatting.
 *
 * Axis ticks, stat-tile values and table cells each want a different amount of
 * precision, so the choice lives here rather than being re-decided inline in
 * every chart.
 */

import type { WidgetConfig } from '@datasphere/core';

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const compactCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export type ValueFormat = NonNullable<WidgetConfig['format']>;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // The API converts numeric/bigint where the magnitude allows, but a value
  // too large to represent stays a string on purpose. Show it as-is rather
  // than parsing it into something wrong.
  return null;
}

/**
 * Format a value for display.
 *
 * `compactFirst` is for places with no room to grow - axis ticks and stat-tile
 * values - where 12.9K beats 12,904 running into its neighbour.
 */
export function formatValue(
  value: unknown,
  format: ValueFormat = 'number',
  compactFirst = false,
): string {
  if (value === null || value === undefined) return '—';

  const numeric = toNumber(value);
  if (numeric === null) {
    return value instanceof Date ? formatDate(value) : String(value);
  }

  switch (format) {
    case 'currency':
      // Compact notation only earns its keep above a thousand: below that it
      // renders $499.8 where $500 is both shorter and what a reader expects.
      return compactFirst && Math.abs(numeric) >= 1_000
        ? compactCurrency.format(numeric)
        : currency.format(numeric);
    case 'percent':
      return `${plain.format(numeric * 100)}%`;
    case 'compact':
      return compact.format(numeric);
    case 'number':
    default:
      if (compactFirst && Math.abs(numeric) >= 10_000) return compact.format(numeric);
      return Number.isInteger(numeric) ? whole.format(numeric) : plain.format(numeric);
  }
}

/**
 * Dates arrive as ISO strings (or as Date, for a date_trunc'd dimension that
 * `pg` parsed). Rendered without a time component, because a bucketed date
 * dimension has no meaningful time.
 */
export function formatDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** True when a column's values look like dates, so an axis can format them. */
export function looksTemporal(values: unknown[]): boolean {
  const sample = values.find((value) => value !== null && value !== undefined);
  if (sample instanceof Date) return true;
  if (typeof sample !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}/.test(sample);
}

/** Axis ticks round to clean numbers and are comma'd. */
export function formatAxisTick(value: unknown): string {
  const numeric = toNumber(value);
  if (numeric === null) return String(value ?? '');
  return Math.abs(numeric) >= 10_000 ? compact.format(numeric) : whole.format(numeric);
}

export function formatMs(milliseconds: number): string {
  if (milliseconds < 1) return '<1 ms';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Turn a column alias into a readable label: `revenue_sum` -> "Revenue sum". */
export function humanizeAlias(alias: string): string {
  const words = alias.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
