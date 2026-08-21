/**
 * Filter operand validation.
 *
 * Operands never reach the SQL text - they are always bind parameters - so
 * this is not the injection control. It is a correctness and blast-radius
 * control: it stops a string being compared against an integer column (where
 * Postgres would either error at runtime or apply a surprising cast), and it
 * rejects the shapes that turn a cheap filter into an expensive one.
 */

import { QueryCompileError } from '../errors.js';
import type { ColumnKind, FilterValue } from '../types.js';

/**
 * Upper bound on operands to a single `in`/`not_in`.
 *
 * A filter with a hundred thousand operands is not a filter, it is a denial of
 * service with extra steps: the array has to be parsed, sent, and matched
 * against every row.
 */
export const MAX_IN_OPERANDS = 1_000;

/** `YYYY-MM-DD`, with the month and day ranges checked properly below. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` optionally followed by a time, and optionally a zone. */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function fail(message: string, detail: Record<string, unknown>): never {
  throw new QueryCompileError('invalid_value', message, detail);
}

/**
 * Check one operand against the semantic kind of the column it filters.
 *
 * Returns the value unchanged. Nothing is coerced: silently turning the string
 * "5" into the number 5 would mean the query that runs is not the query the
 * client described, and that divergence is exactly what makes injection bugs
 * hard to reason about.
 */
export function assertValueMatchesKind(
  value: unknown,
  kind: ColumnKind,
  context: Record<string, unknown>,
): FilterValue {
  // NULL is never a valid operand. Comparing to NULL with `=` yields NULL, not
  // true, so a client meaning "no value" must say so with is_null.
  if (value === null || value === undefined) {
    fail('Use the is_null or is_not_null operator instead of a null operand', {
      ...context,
      value,
    });
  }

  switch (kind) {
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('Expected a finite number for an integer column', { ...context, value });
      }
      if (!Number.isInteger(value)) {
        fail('Expected a whole number for an integer column', { ...context, value });
      }
      // Beyond this, JavaScript numbers stop being exact integers and the
      // value sent would not be the value meant.
      if (!Number.isSafeInteger(value)) {
        fail('Integer operand is outside the safe integer range', { ...context, value });
      }
      return value;
    }

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('Expected a finite number', { ...context, value });
      }
      return value;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail('Expected true or false', { ...context, value });
      }
      return value;
    }

    case 'string': {
      if (typeof value !== 'string') {
        fail('Expected a string', { ...context, value });
      }
      // A NUL byte truncates the value inside libpq's C string handling, so
      // the value stored/compared would differ from the value supplied.
      if (value.includes('\0')) {
        fail('String operand contains a NUL byte', { ...context });
      }
      return value;
    }

    case 'date': {
      if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isRealDate(value)) {
        fail('Expected a calendar date in YYYY-MM-DD form', { ...context, value });
      }
      return value;
    }

    case 'timestamp': {
      if (
        typeof value !== 'string' ||
        !TIMESTAMP_PATTERN.test(value) ||
        Number.isNaN(Date.parse(value))
      ) {
        fail('Expected an ISO 8601 date or date-time', { ...context, value });
      }
      return value;
    }
  }
}

/**
 * Reject dates that match the pattern but do not exist, such as 2024-02-31.
 *
 * Postgres would raise a runtime error on those; catching it here turns a
 * database error into a precise 400 naming the offending filter.
 */
function isRealDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Validate a whole operand list, enforcing the `in` size ceiling. */
export function assertValuesMatchKind(
  values: readonly unknown[],
  kind: ColumnKind,
  context: Record<string, unknown>,
): FilterValue[] {
  if (values.length > MAX_IN_OPERANDS) {
    throw new QueryCompileError(
      'invalid_arity',
      `A filter may not take more than ${MAX_IN_OPERANDS} operands`,
      { ...context, count: values.length },
    );
  }
  return values.map((value, index) =>
    assertValueMatchesKind(value, kind, { ...context, operandIndex: index }),
  );
}
