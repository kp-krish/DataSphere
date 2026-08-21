/**
 * Compiler behaviour.
 *
 * These tests assert what the compiler *produces*. The companion file,
 * injection.test.ts, asserts what it refuses to produce.
 *
 * Everything here compiles against FIXTURE_CATALOG, which is generated from
 * the real migrated database by `npm run dump:catalog`. So "column
 * fact_orders.revenue is numeric(12,2)" is not an assumption baked into a
 * hand-written fixture - it is what the database actually reported.
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_CATALOG } from '../__fixtures__/catalog.js';
import { QueryCompileError } from '../errors.js';
import { compileQuery, SPEC_LIMITS, type CompileOptions } from './compile.js';
import type { QuerySpec } from '../types.js';

const OPTIONS: CompileOptions = { maxRows: 10_000, defaultLimit: 500 };

function compile(spec: Partial<QuerySpec>) {
  return compileQuery(
    { dataset: 'orders', dimensions: [], measures: [], ...spec } as QuerySpec,
    FIXTURE_CATALOG,
    OPTIONS,
  );
}

/** Assert a spec is rejected, and with which code. */
function expectRejected(spec: Partial<QuerySpec>, code: string): QueryCompileError {
  try {
    compile(spec);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryCompileError);
    expect((error as QueryCompileError).code).toBe(code);
    return error as QueryCompileError;
  }
  throw new Error(`Expected the spec to be rejected with "${code}", but it compiled`);
}

/* -------------------------------------------------------------------------- */

describe('projection', () => {
  it('compiles a dimension and a measure into a grouped aggregate', () => {
    const { text, values, columns } = compile({
      dimensions: [{ table: 'dim_product', column: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });

    expect(columns).toEqual(['category', 'revenue_sum']);
    expect(text).toContain('"dim_product"."category" AS "category"');
    expect(text).toContain('SUM("fact_orders"."revenue") AS "revenue_sum"');
    expect(text).toContain('FROM "analytics"."fact_orders" AS "fact_orders"');
    expect(text).toContain('GROUP BY "dim_product"."category"');
    // Only the limit is bound here.
    expect(values).toEqual([500]);
  });

  it('omits GROUP BY when the query has measures but no dimensions', () => {
    const { text } = compile({
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });
    expect(text).not.toContain('GROUP BY');
  });

  it('groups by every dimension when there are no measures, giving DISTINCT semantics', () => {
    const { text } = compile({
      dimensions: [
        { table: 'dim_product', column: 'category' },
        { table: 'dim_product', column: 'subcategory' },
      ],
    });
    expect(text).toContain('GROUP BY "dim_product"."category", "dim_product"."subcategory"');
  });

  it('rejects a spec that selects nothing', () => {
    expectRejected({}, 'empty_projection');
  });

  it('supports every aggregate function', () => {
    for (const fn of ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'] as const) {
      const { text } = compile({
        measures: [{ table: 'fact_orders', column: 'revenue', fn }],
      });
      expect(text).toContain(`${fn}("fact_orders"."revenue")`);
    }

    const distinct = compile({
      measures: [{ table: 'fact_orders', column: 'customer_id', fn: 'COUNT_DISTINCT' }],
    });
    expect(distinct.text).toContain('COUNT(DISTINCT "fact_orders"."customer_id")');
  });

  it('refuses to group by a continuous numeric measure', () => {
    // revenue is numeric(12,2): grouping by it yields ~one group per row.
    const error = expectRejected(
      { dimensions: [{ table: 'fact_orders', column: 'revenue' }] },
      'not_groupable',
    );
    expect(error.detail.kind).toBe('number');
  });

  it('refuses to SUM a non-numeric column', () => {
    expectRejected(
      { measures: [{ table: 'fact_orders', column: 'order_status', fn: 'SUM' }] },
      'not_aggregatable',
    );
  });

  it('allows COUNT on a non-numeric column', () => {
    const { text } = compile({
      measures: [{ table: 'fact_orders', column: 'order_status', fn: 'COUNT' }],
    });
    expect(text).toContain('COUNT("fact_orders"."order_status")');
  });
});

/* -------------------------------------------------------------------------- */

describe('joins', () => {
  it('joins only the dimensions the query actually references', () => {
    const { text } = compile({
      dimensions: [{ table: 'dim_product', column: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });

    expect(text).toContain('JOIN "analytics"."dim_product"');
    // Nothing referenced dim_customer, dim_store or dim_date.
    expect(text).not.toContain('dim_customer');
    expect(text).not.toContain('dim_store');
    expect(text).not.toContain('dim_date');
  });

  it('pulls in a dimension referenced only by a filter', () => {
    const { text } = compile({
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      filters: [{ table: 'dim_store', column: 'channel', operator: 'eq', values: ['Online'] }],
    });
    expect(text).toContain('JOIN "analytics"."dim_store"');
    expect(text).toContain('ON "dim_store"."store_id" = "fact_orders"."store_id"');
  });

  it('uses INNER JOIN when the fact-side key is NOT NULL', () => {
    const { text } = compile({
      dimensions: [{ table: 'dim_date', column: 'year_num' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });
    // Every FK column in this schema is NOT NULL, so no LEFT JOIN is expected.
    expect(text).toContain('JOIN "analytics"."dim_date"');
    expect(text).not.toContain('LEFT JOIN');
  });

  it('uses LEFT JOIN when the fact-side key is nullable, so rows are not dropped', () => {
    // Nullable FKs do not occur in DataSphere's schema, so this variant is
    // constructed to prove the rule rather than to describe the real catalog.
    const nullableCatalog = structuredClone(FIXTURE_CATALOG);
    const fact = nullableCatalog.tables.find((table) => table.name === 'fact_orders')!;
    fact.columns.find((column) => column.name === 'store_id')!.nullable = true;

    const { text } = compileQuery(
      {
        dataset: 'orders',
        dimensions: [{ table: 'dim_store', column: 'channel' }],
        measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      },
      nullableCatalog,
      OPTIONS,
    );
    expect(text).toContain('LEFT JOIN "analytics"."dim_store"');
  });
});

/* -------------------------------------------------------------------------- */

describe('date grain', () => {
  it('buckets a date column and casts the result back to date', () => {
    const { text, columns } = compile({
      dimensions: [{ table: 'dim_date', column: 'full_date', grain: 'month' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });

    expect(text).toContain(`date_trunc('month', "dim_date"."full_date")::date`);
    expect(columns).toEqual(['full_date_month', 'revenue_sum']);
  });

  it('does not cast when bucketing a timestamp column', () => {
    const { text } = compile({
      dimensions: [{ table: 'fact_orders', column: 'ordered_at', grain: 'day' }],
    });
    expect(text).toContain(`date_trunc('day', "fact_orders"."ordered_at")`);
    expect(text).not.toContain('::date');
  });

  it('groups by the bucketed expression, not the raw column', () => {
    const { text } = compile({
      dimensions: [{ table: 'dim_date', column: 'full_date', grain: 'quarter' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });
    expect(text).toContain(`GROUP BY date_trunc('quarter', "dim_date"."full_date")::date`);
  });

  it('rejects a grain on a non-temporal column', () => {
    expectRejected(
      { dimensions: [{ table: 'dim_product', column: 'category', grain: 'month' }] },
      'invalid_grain',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('filters', () => {
  const measure = [{ table: 'fact_orders' as const, column: 'revenue', fn: 'SUM' as const }];

  it('binds a simple equality operand rather than inlining it', () => {
    const { text, values } = compile({
      measures: measure,
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
      ],
    });

    expect(text).toContain('WHERE "fact_orders"."order_status" = $1');
    expect(values[0]).toBe('completed');
  });

  it('maps each comparison operator to the right SQL operator', () => {
    const cases = [
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<='],
      ['neq', '<>'],
    ] as const;

    for (const [operator, sql] of cases) {
      const { text } = compile({
        measures: measure,
        filters: [{ table: 'fact_orders', column: 'quantity', operator, values: [3] }],
      });
      expect(text).toContain(`"fact_orders"."quantity" ${sql} $1`);
    }
  });

  it('compiles IN to a single = ANY placeholder regardless of operand count', () => {
    const { text, values } = compile({
      measures: measure,
      filters: [
        { table: 'dim_date', column: 'year_num', operator: 'in', values: [2023, 2024, 2025] },
      ],
    });

    expect(text).toContain('"dim_date"."year_num" = ANY($1)');
    expect(values[0]).toEqual([2023, 2024, 2025]);
    // One placeholder for the list, one for the limit.
    expect(values).toHaveLength(2);
  });

  it('negates NOT IN around the ANY comparison', () => {
    const { text } = compile({
      measures: measure,
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'not_in', values: ['cancelled'] },
      ],
    });
    expect(text).toContain('NOT ("fact_orders"."order_status" = ANY($1))');
  });

  it('compiles BETWEEN to two bound operands', () => {
    const { text, values } = compile({
      measures: measure,
      filters: [
        {
          table: 'dim_date',
          column: 'full_date',
          operator: 'between',
          values: ['2024-01-01', '2024-12-31'],
        },
      ],
    });

    expect(text).toContain('"dim_date"."full_date" BETWEEN $1 AND $2');
    expect(values.slice(0, 2)).toEqual(['2024-01-01', '2024-12-31']);
  });

  it('binds null checks with no operands at all', () => {
    const { text, values } = compile({
      measures: measure,
      filters: [{ table: 'fact_orders', column: 'order_status', operator: 'is_null' }],
    });

    expect(text).toContain('"fact_orders"."order_status" IS NULL');
    expect(values).toEqual([500]); // limit only
  });

  it('escapes LIKE wildcards so a literal % is not treated as a wildcard', () => {
    const { text, values } = compile({
      measures: measure,
      filters: [
        { table: 'dim_product', column: 'product_name', operator: 'contains', values: ['50%_off'] },
      ],
    });

    expect(text).toContain('ILIKE $1');
    expect(text).toContain("ESCAPE '\\'");
    expect(values[0]).toBe('%50\\%\\_off%');
  });

  it('anchors starts_with and ends_with on the correct side', () => {
    const starts = compile({
      measures: measure,
      filters: [
        { table: 'dim_product', column: 'brand', operator: 'starts_with', values: ['Nor'] },
      ],
    });
    expect(starts.values[0]).toBe('Nor%');

    const ends = compile({
      measures: measure,
      filters: [{ table: 'dim_product', column: 'brand', operator: 'ends_with', values: ['ind'] }],
    });
    expect(ends.values[0]).toBe('%ind');
  });

  it('joins multiple filters with AND', () => {
    const { text } = compile({
      measures: measure,
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
        { table: 'dim_store', column: 'channel', operator: 'eq', values: ['Online'] },
      ],
    });
    expect(text).toMatch(/WHERE .+\n {2}AND /s);
  });

  it('rejects an operator the column kind does not support', () => {
    // Ordering comparisons on text are collation-dependent and withheld.
    expectRejected(
      {
        measures: measure,
        filters: [
          { table: 'fact_orders', column: 'order_status', operator: 'gt', values: ['completed'] },
        ],
      },
      'invalid_operator',
    );
  });

  it('rejects wrong operand counts', () => {
    expectRejected(
      {
        measures: measure,
        filters: [
          { table: 'dim_date', column: 'full_date', operator: 'between', values: ['2024-01-01'] },
        ],
      },
      'invalid_arity',
    );
  });

  it('rejects an operand whose type does not match the column', () => {
    expectRejected(
      {
        measures: measure,
        filters: [
          { table: 'dim_date', column: 'year_num', operator: 'eq', values: ['2024'] as never },
        ],
      },
      'invalid_value',
    );
  });

  it('rejects a calendar date that does not exist', () => {
    expectRejected(
      {
        measures: measure,
        filters: [
          { table: 'dim_date', column: 'full_date', operator: 'eq', values: ['2024-02-31'] },
        ],
      },
      'invalid_value',
    );
  });

  it('rejects a null operand and points at is_null', () => {
    const error = expectRejected(
      {
        measures: measure,
        filters: [{ table: 'fact_orders', column: 'order_status', operator: 'eq', values: [null] }],
      },
      'invalid_value',
    );
    expect(error.message).toContain('is_null');
  });
});

/* -------------------------------------------------------------------------- */

describe('aliases', () => {
  it('derives aliases from the column and function when none are given', () => {
    const { columns } = compile({
      dimensions: [{ table: 'dim_store', column: 'channel' }],
      measures: [
        { table: 'fact_orders', column: 'revenue', fn: 'SUM' },
        { table: 'fact_orders', column: 'quantity', fn: 'AVG' },
      ],
    });
    expect(columns).toEqual(['channel', 'revenue_sum', 'quantity_avg']);
  });

  it('honours explicit aliases', () => {
    const { columns, text } = compile({
      dimensions: [{ table: 'dim_store', column: 'channel', alias: 'sales_channel' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'total' }],
    });
    expect(columns).toEqual(['sales_channel', 'total']);
    expect(text).toContain('AS "sales_channel"');
  });

  it('rejects duplicate output names instead of silently shadowing one', () => {
    // dim_customer.city and dim_store.city both default to "city".
    expectRejected(
      {
        dimensions: [
          { table: 'dim_customer', column: 'city' },
          { table: 'dim_store', column: 'city' },
        ],
      },
      'duplicate_alias',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('sorting', () => {
  it('sorts by an output alias with NULLS LAST in both directions', () => {
    const { text } = compile({
      dimensions: [{ table: 'dim_product', column: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      sort: [
        { alias: 'revenue_sum', direction: 'desc' },
        { alias: 'category', direction: 'asc' },
      ],
    });
    expect(text).toContain('ORDER BY "revenue_sum" DESC NULLS LAST, "category" ASC NULLS LAST');
  });

  it('rejects sorting by something that is not an output column', () => {
    expectRejected(
      {
        measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
        sort: [{ alias: 'not_selected', direction: 'asc' }],
      },
      'unknown_sort_alias',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('limit and offset', () => {
  it('applies the default limit when the spec does not ask for one', () => {
    const { appliedLimit, values } = compile({
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });
    expect(appliedLimit).toBe(500);
    expect(values.at(-1)).toBe(500);
  });

  it('clamps a limit above the ceiling rather than rejecting it', () => {
    const { appliedLimit } = compile({
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      limit: 5_000_000,
    });
    expect(appliedLimit).toBe(10_000);
  });

  it('binds limit and offset as parameters, not inline integers', () => {
    const { text, values } = compile({
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      limit: 25,
      offset: 50,
    });

    expect(text).toContain('LIMIT $1');
    expect(text).toContain('OFFSET $2');
    expect(values).toEqual([25, 50]);
  });

  it('omits OFFSET entirely when it is zero', () => {
    const { text } = compile({
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
    });
    expect(text).not.toContain('OFFSET');
  });

  it('rejects a non-integer or negative limit', () => {
    const measures = [{ table: 'fact_orders' as const, column: 'revenue', fn: 'SUM' as const }];
    expectRejected({ measures, limit: 0 }, 'invalid_limit');
    expectRejected({ measures, limit: -5 }, 'invalid_limit');
    expectRejected({ measures, limit: 1.5 }, 'invalid_limit');
    expectRejected({ measures, offset: -1 }, 'invalid_offset');
  });
});

/* -------------------------------------------------------------------------- */

describe('spec size limits', () => {
  it('rejects a spec carrying more filters than the ceiling allows', () => {
    const filters = Array.from({ length: SPEC_LIMITS.filters + 1 }, () => ({
      table: 'fact_orders',
      column: 'order_status',
      operator: 'eq' as const,
      values: ['completed'],
    }));

    expectRejected(
      { measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }], filters },
      'too_many_fields',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('placeholder integrity', () => {
  it('numbers placeholders consecutively and binds exactly as many values', () => {
    const { text, values } = compile({
      dimensions: [{ table: 'dim_product', column: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
        { table: 'dim_date', column: 'year_num', operator: 'in', values: [2024, 2025] },
        {
          table: 'dim_date',
          column: 'full_date',
          operator: 'between',
          values: ['2024-01-01', '2025-12-31'],
        },
      ],
      limit: 100,
      offset: 10,
    });

    const placeholders = [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(placeholders).toEqual([1, 2, 3, 4, 5, 6]);
    expect(values).toHaveLength(6);
  });
});
