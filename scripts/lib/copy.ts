/**
 * Bulk load helpers built on PostgreSQL's COPY protocol.
 *
 * Inserting two million rows with INSERT statements - even multi-row ones -
 * spends most of its time in per-statement parse/plan/execute overhead and
 * round trips. COPY FROM STDIN streams rows over a single command in the
 * server's native text format and is roughly an order of magnitude faster.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import type { Client } from 'pg';

/**
 * Escape a value for COPY's default TEXT format.
 *
 * In TEXT format columns are tab-separated, rows are newline-separated, and
 * backslash is the escape character - so any of those appearing inside a value
 * would silently corrupt the row boundaries. NULL is the literal `\N`.
 */
export function copyEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'number') return String(value);

  // Fast path: the overwhelming majority of generated values contain none of
  // the characters that need escaping, and testing once beats four replaces.
  if (!/[\\\t\n\r]/.test(value)) return value;

  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** Join pre-escaped column values into one COPY TEXT row. */
export function copyRow(values: readonly string[]): string {
  return values.join('\t');
}

/**
 * Stream an async/sync iterable of row-chunks into a COPY command.
 *
 * The iterable should yield newline-terminated *batches* of rows rather than
 * single rows: one chunk per row means one stream write per row, and the
 * per-write bookkeeping starts to rival the cost of generating the data.
 * Backpressure is handled by `pipeline`, so a slow server throttles the
 * generator instead of buffering the whole dataset in memory.
 */
export async function copyInto(
  client: Client,
  copySql: string,
  chunks: Iterable<string> | AsyncIterable<string>,
): Promise<void> {
  const target = client.query(copyFrom(copySql));
  await pipeline(Readable.from(chunks, { objectMode: false }), target);
}
