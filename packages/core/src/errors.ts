/**
 * Errors raised while validating and compiling a query spec.
 *
 * Every rejection carries a machine-readable `code` alongside the message.
 * The API maps these to HTTP 400 with the code intact, so the query builder UI
 * can point at the offending control instead of showing a wall of text, and so
 * tests can assert on *why* something was rejected rather than string-matching
 * a message that may later be reworded.
 */

export type CompileErrorCode =
  /* Structure */
  | 'empty_projection'
  | 'too_many_fields'
  /* Catalog lookups - the allowlist rejections */
  | 'unknown_dataset'
  | 'unknown_table'
  | 'unknown_column'
  | 'table_not_joinable'
  /* Field usage */
  | 'not_aggregatable'
  | 'not_groupable'
  | 'invalid_aggregate'
  | 'invalid_grain'
  /* Filters */
  | 'invalid_operator'
  | 'invalid_arity'
  | 'invalid_value'
  /* Output shaping */
  | 'invalid_alias'
  | 'duplicate_alias'
  | 'unknown_sort_alias'
  | 'invalid_sort_direction'
  | 'invalid_limit'
  | 'invalid_offset';

export class QueryCompileError extends Error {
  readonly code: CompileErrorCode;
  /** Structured context: which table, column, operator and so on. */
  readonly detail: Record<string, unknown>;

  constructor(code: CompileErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'QueryCompileError';
    this.code = code;
    this.detail = detail;

    // Without this, `instanceof QueryCompileError` fails when the package is
    // compiled to a target older than ES2015 - a footgun worth closing off
    // permanently rather than rediscovering later.
    Object.setPrototypeOf(this, QueryCompileError.prototype);
  }
}

export function isQueryCompileError(error: unknown): error is QueryCompileError {
  return error instanceof QueryCompileError;
}
