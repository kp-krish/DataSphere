/**
 * Numeric coercion for query results.
 *
 * `pg` returns `numeric` and `bigint` as JavaScript strings, and it is right
 * to: both can hold values a float64 cannot represent, so parsing them
 * unconditionally would be unsafe. But a chart needs numbers, and pushing
 * `parseFloat` into every widget makes every widget a place to forget it. So
 * the conversion happens here, once.
 *
 * The rule is about *magnitude*, not about digits, and the distinction is
 * worth being precise on:
 *
 *   Integers are converted only within the safe-integer range. Past 2^53 a
 *   double cannot represent consecutive integers, so converting a bigint id
 *   would produce a different id - silently, and wrongly. Those stay strings.
 *
 *   Decimals are converted whenever the magnitude is inside that same range.
 *   Refusing to convert does not preserve precision: any JavaScript consumer
 *   that later parses the string gets the identical double. It only defers the
 *   same lossy step, and in the meantime leaves a string where a chart wanted
 *   a number. Above the range the double cannot represent even the units
 *   place, so the value would be visibly wrong and is left as text.
 *
 * This does not undermine the choice of `numeric` in the schema. Exactness
 * matters for the *accumulation* - SUM over two million rows, done in Postgres
 * in exact arithmetic. What crosses this boundary is a handful of aggregated
 * results, and a total like 637081797.57 is eleven significant digits, well
 * inside a double's fifteen.
 *
 * Only the analytical query path uses this; the dashboard repository leaves
 * its own values alone.
 */

import type { FieldDef } from 'pg';

/**
 * Postgres type OIDs that `pg` hands back as strings.
 *
 * int2/int4/float4/float8 are already parsed into numbers by the driver, so
 * they are absent here deliberately.
 */
const INT8_OID = 20;
const NUMERIC_OID = 1700;

const STRINGY_NUMERIC_OIDS = new Set([INT8_OID, NUMERIC_OID]);

/** Convert when the magnitude is representable, otherwise leave it alone. */
export function coerceNumericString(value: string): string | number {
  const parsed = Number(value);

  // NaN, Infinity, or Postgres' 'NaN' for numeric.
  if (!Number.isFinite(parsed)) return value;

  // Beyond the safe-integer range a double cannot resolve the units place, so
  // the converted value would differ from the stored one in ways a reader
  // would notice. Applies to both integers and decimals.
  if (Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return value;

  // An integer-valued string that is *not* a safe integer was caught above;
  // everything reaching here is representable.
  return parsed;
}

/**
 * Coerce the string-typed numeric columns of a result set, in place.
 *
 * Field metadata decides which columns to touch, so a text column holding
 * something that merely looks like a number is never converted - a `sku` of
 * "0012345" must stay a string, and it does, because its OID is `text`.
 */
export function coerceRows<T extends Record<string, unknown>>(
  rows: T[],
  fields: readonly FieldDef[],
): T[] {
  const numericColumns = fields
    .filter((field) => STRINGY_NUMERIC_OIDS.has(field.dataTypeID))
    .map((field) => field.name);

  if (numericColumns.length === 0 || rows.length === 0) return rows;

  for (const row of rows) {
    for (const column of numericColumns) {
      const value = (row as Record<string, unknown>)[column];
      if (typeof value === 'string') {
        (row as Record<string, unknown>)[column] = coerceNumericString(value);
      }
    }
  }
  return rows;
}
