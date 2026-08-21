/**
 * Identifier handling and type-kind mapping.
 *
 * These are the primitives the compiler is built on. They are tested directly
 * rather than only through the compiler, because a subtle regression here -
 * quoting that stops doubling quotes, a type that starts mapping to `string`
 * instead of `null` - would weaken the whole engine while the higher-level
 * tests carried on passing.
 */

import { describe, expect, it } from 'vitest';
import { QueryCompileError } from '../errors.js';
import { columnKindForPostgresType, isGroupable, operatorAcceptsKind } from '../catalog/rules.js';
import { assertValidAlias, deriveAlias, escapeLikePattern, quoteIdent } from './identifiers.js';

describe('quoteIdent', () => {
  it('wraps a plain name in double quotes', () => {
    expect(quoteIdent('revenue')).toBe('"revenue"');
  });

  it('doubles embedded quotes so the name cannot terminate early', () => {
    // Were the quote not doubled, this would close the identifier and leave
    // `; DROP TABLE x; --` sitting in statement position.
    expect(quoteIdent('a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
  });

  it('leaves other punctuation inert inside the quotes', () => {
    expect(quoteIdent('a b;c--d')).toBe('"a b;c--d"');
  });

  it('rejects a NUL byte, which would truncate the statement inside libpq', () => {
    expect(() => quoteIdent('rev\0enue')).toThrow(QueryCompileError);
  });

  it('rejects an empty identifier', () => {
    expect(() => quoteIdent('')).toThrow(QueryCompileError);
  });
});

describe('assertValidAlias', () => {
  it('accepts identifiers matching the narrow grammar', () => {
    for (const alias of ['revenue', '_private', 'total_2024', 'a']) {
      expect(assertValidAlias(alias)).toBe(alias);
    }
  });

  it('rejects anything outside it rather than repairing it', () => {
    for (const alias of ['1st', 'a b', 'a-b', 'a"b', 'a;b', 'café', '', 'a'.repeat(64)]) {
      expect(() => assertValidAlias(alias), alias).toThrow(QueryCompileError);
    }
  });
});

describe('deriveAlias', () => {
  it('builds a snake_case alias from catalog parts', () => {
    expect(deriveAlias('revenue', 'sum')).toBe('revenue_sum');
    expect(deriveAlias('full_date', 'month')).toBe('full_date_month');
  });

  it('drops the trailing separator when a part is empty', () => {
    expect(deriveAlias('category', '')).toBe('category');
  });

  it('produces something that always satisfies the alias grammar', () => {
    for (const parts of [['Unit Cost'], ['2024_total'], ['a'.repeat(80)], ['%%%']]) {
      expect(() => assertValidAlias(deriveAlias(...parts)), parts.join()).not.toThrow();
    }
  });
});

describe('escapeLikePattern', () => {
  it('escapes the three characters LIKE treats specially', () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern("O'Brien & Sons")).toBe("O'Brien & Sons");
  });
});

describe('columnKindForPostgresType', () => {
  it('maps the types the schema actually uses', () => {
    const cases: [string, string][] = [
      ['smallint', 'integer'],
      ['integer', 'integer'],
      ['bigint', 'integer'],
      ['numeric(12,2)', 'number'],
      ['double precision', 'number'],
      ['text', 'string'],
      ['character varying(255)', 'string'],
      ['uuid', 'string'],
      ['boolean', 'boolean'],
      ['date', 'date'],
      ['timestamp with time zone', 'timestamp'],
    ];

    for (const [dataType, kind] of cases) {
      expect(columnKindForPostgresType(dataType), dataType).toBe(kind);
    }
  });

  it('fails closed on types the compiler has no rules for', () => {
    // A column of an unmapped type is left out of the catalog entirely, so it
    // cannot be named in a query spec. Adding jsonb to a migration must not
    // silently make it queryable.
    for (const dataType of ['jsonb', 'json', 'integer[]', 'tsvector', 'point', 'bytea', 'xml']) {
      expect(columnKindForPostgresType(dataType), dataType).toBeNull();
    }
  });
});

describe('usage rules', () => {
  it('excludes continuous numerics from GROUP BY but keeps integers', () => {
    expect(isGroupable('number')).toBe(false);
    expect(isGroupable('integer')).toBe(true);
    expect(isGroupable('string')).toBe(true);
    expect(isGroupable('date')).toBe(true);
  });

  it('withholds ordering comparisons from text', () => {
    // Collation-dependent and rarely what a dashboard user means.
    expect(operatorAcceptsKind('gt', 'string')).toBe(false);
    expect(operatorAcceptsKind('gt', 'integer')).toBe(true);
    expect(operatorAcceptsKind('contains', 'string')).toBe(true);
    expect(operatorAcceptsKind('contains', 'integer')).toBe(false);
  });
});
