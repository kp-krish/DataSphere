/**
 * SQL identifier and pattern handling.
 *
 * This module and the compiler are the only places in DataSphere that produce
 * SQL text. The rule they enforce is absolute: an identifier may only ever
 * reach the SQL string after being matched against the introspected catalog,
 * and a *value* never reaches the SQL string at all - it becomes a bind
 * parameter.
 *
 * The quoting here is therefore defence in depth rather than the primary
 * control. By the time `quoteIdent` runs, the name has already been proven to
 * be one of the identifiers the database itself reported. Quoting it anyway
 * means that even a catalog poisoned through some other route cannot break out
 * of the identifier position.
 */

import { QueryCompileError } from '../errors.js';

/**
 * Postgres truncates identifiers at NAMEDATALEN - 1 = 63 bytes. An alias
 * longer than that would be silently shortened, and two aliases differing only
 * past byte 63 would collide into one output column.
 */
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Aliases are the one identifier a user supplies directly, so they get a
 * deliberately narrow grammar: ASCII letters, digits and underscore, not
 * starting with a digit. Anything outside it is rejected rather than
 * sanitised - silently rewriting a user's alias produces output columns they
 * did not ask for, and "sanitise" is where escaping bugs live.
 */
const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Double-quote an identifier for use in SQL.
 *
 * Doubling any embedded quote is what makes the result unambiguous: the
 * identifier `a"b` becomes `"a""b"`, which Postgres reads back as the literal
 * name rather than as a terminated identifier followed by loose syntax.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new QueryCompileError('unknown_column', 'Cannot quote an empty identifier');
  }
  // A NUL byte truncates the string inside libpq's C string handling, which
  // would make the SQL the server executes differ from the SQL we built.
  if (name.includes('\0')) {
    throw new QueryCompileError('unknown_column', 'Identifier contains a NUL byte', { name });
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Qualify a column with its table: `"dim_product"."category"`. */
export function quoteQualified(table: string, column: string): string {
  return `${quoteIdent(table)}.${quoteIdent(column)}`;
}

/**
 * Validate a user-supplied output alias, returning it unchanged.
 *
 * Throws rather than repairing. See ALIAS_PATTERN above for why.
 */
export function assertValidAlias(alias: string, context: Record<string, unknown> = {}): string {
  if (typeof alias !== 'string' || alias.length === 0) {
    throw new QueryCompileError('invalid_alias', 'Alias must be a non-empty string', {
      ...context,
      alias,
    });
  }
  if (alias.length > MAX_IDENTIFIER_LENGTH) {
    throw new QueryCompileError(
      'invalid_alias',
      `Alias exceeds ${MAX_IDENTIFIER_LENGTH} characters`,
      { ...context, alias },
    );
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw new QueryCompileError(
      'invalid_alias',
      'Alias may contain only letters, digits and underscores, and may not start with a digit',
      { ...context, alias },
    );
  }
  return alias;
}

/**
 * Derive a safe alias from catalog-supplied parts.
 *
 * Used when the client does not name an output column. The inputs are already
 * catalog identifiers, but the result is still filtered through the alias
 * grammar so generated and user-supplied aliases are indistinguishable
 * downstream.
 */
export function deriveAlias(...parts: string[]): string {
  const joined = parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

  const candidate = joined.length === 0 ? 'value' : joined;
  const trimmed = candidate.slice(0, MAX_IDENTIFIER_LENGTH);

  // A name starting with a digit is legal as a quoted identifier but fails the
  // alias grammar, and we want one grammar for both paths.
  return /^[0-9]/.test(trimmed) ? `f_${trimmed}`.slice(0, MAX_IDENTIFIER_LENGTH) : trimmed;
}

/**
 * Escape the wildcards in a value being used as a LIKE/ILIKE pattern.
 *
 * Without this, a user filtering for the literal text `50%` would match
 * anything starting with `50`, and `_` would match any single character. The
 * compiler pairs the escaped value with an explicit `ESCAPE '\'` clause so the
 * behaviour does not depend on the server's standard_conforming_strings.
 *
 * Note this is not a security control - the pattern is still a bind parameter.
 * It is a correctness one.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
