/**
 * Injection resistance.
 *
 * compile.test.ts asserts what the compiler produces. This file asserts what
 * it refuses to produce.
 *
 * The tests are organised around the two properties that actually matter,
 * because "we tested some SQL injection strings" is not a security argument:
 *
 *   A. Identifier positions are closed. Anything that becomes SQL text -
 *      table, column, aggregate, operator, grain, sort direction - must be
 *      matched against the introspected catalog or a closed union. There is no
 *      escaping step to get wrong, because unrecognised input is rejected
 *      rather than sanitised.
 *
 *   B. Value positions never become SQL text. A filter operand may contain
 *      anything at all, including a perfectly valid SQL statement, because it
 *      is transported as a bind parameter and the database never parses it as
 *      SQL.
 *
 * The final `describe` block checks both properties exhaustively: every
 * payload is fired at every user-controlled position, and each attempt must
 * either be rejected outright or leave no trace in the generated SQL.
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_CATALOG } from '../__fixtures__/catalog.js';
import { QueryCompileError } from '../errors.js';
import { compileQuery, type CompileOptions } from './compile.js';
import type { Catalog, QuerySpec } from '../types.js';

const OPTIONS: CompileOptions = { maxRows: 10_000, defaultLimit: 500 };

function compile(spec: unknown, catalog: Catalog = FIXTURE_CATALOG) {
  return compileQuery(spec as QuerySpec, catalog, OPTIONS);
}

function expectRejected(spec: unknown, code?: string): QueryCompileError {
  try {
    compile(spec);
  } catch (error) {
    expect(error, `expected a QueryCompileError, got ${String(error)}`).toBeInstanceOf(
      QueryCompileError,
    );
    if (code) expect((error as QueryCompileError).code).toBe(code);
    return error as QueryCompileError;
  }
  throw new Error('Expected the spec to be rejected, but it compiled');
}

/** The classic payloads, plus a few Postgres-specific ones. */
const PAYLOADS = [
  `'; DROP TABLE analytics.fact_orders; --`,
  `"; DROP TABLE analytics.fact_orders; --`,
  `' OR '1'='1`,
  `" OR 1=1 --`,
  `1; DELETE FROM app.dashboards`,
  `revenue) FROM analytics.fact_orders; SELECT pg_sleep(10) --`,
  `fact_orders" ; DROP TABLE x; --`,
  `UNION SELECT * FROM app.dashboards`,
  `pg_read_file('/etc/passwd')`,
  `(SELECT current_setting('is_superuser'))`,
  `x'||(SELECT version())||'`,
  `\\'; DROP TABLE x; --`,
  `category"), (SELECT password FROM users) AS "x`,
] as const;

const BASE_MEASURE = { table: 'fact_orders', column: 'revenue', fn: 'SUM' } as const;

/* -------------------------------------------------------------------------- */
/* A. Identifier positions are closed                                         */
/* -------------------------------------------------------------------------- */

describe('table and column names are allowlisted', () => {
  it('rejects a table name carrying a statement terminator', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [
          { table: `fact_orders; DROP TABLE analytics.dim_date; --`, column: 'revenue' },
        ],
        measures: [],
      },
      'unknown_table',
    );
  });

  it('rejects a schema-qualified table name, since the catalog stores bare names', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [{ table: 'analytics.fact_orders', column: 'order_status' }],
        measures: [],
      },
      'unknown_table',
    );
  });

  it('rejects a column name that tries to close the expression and append SQL', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [{ table: 'fact_orders', column: `revenue") AS x, (SELECT 1) AS "y`, fn: 'SUM' }],
      },
      'unknown_column',
    );
  });

  it('rejects application tables, which live in a schema the catalog never read', () => {
    // app.dashboards and app.widgets exist in the database. They are not in
    // the analytics catalog, so no spec can name them.
    for (const table of ['dashboards', 'widgets', 'pgmigrations']) {
      expectRejected(
        { dataset: 'orders', dimensions: [{ table, column: 'id' }], measures: [] },
        'unknown_table',
      );
    }
  });

  it('rejects system catalogs', () => {
    for (const table of ['pg_class', 'pg_shadow', 'pg_authid', 'information_schema.tables']) {
      expectRejected(
        { dataset: 'orders', dimensions: [{ table, column: 'relname' }], measures: [] },
        'unknown_table',
      );
    }
  });

  it('rejects a table that is in the catalog but not part of the requested dataset', () => {
    // Build a catalog whose dataset no longer joins dim_store, while the table
    // itself remains present. Being in the catalog must not be sufficient.
    const narrowed = structuredClone(FIXTURE_CATALOG);
    narrowed.datasets[0]!.joins = narrowed.datasets[0]!.joins.filter(
      (join) => join.table !== 'dim_store',
    );

    try {
      compile(
        {
          dataset: 'orders',
          dimensions: [{ table: 'dim_store', column: 'channel' }],
          measures: [],
        },
        narrowed,
      );
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryCompileError);
      expect((error as QueryCompileError).code).toBe('table_not_joinable');
    }
  });

  it('does not resolve inherited Object properties as table or column names', () => {
    // Catalog lookups use Map, not plain objects. Were they plain objects,
    // "constructor" and "toString" would resolve through the prototype chain
    // and produce a truthy "column" that never came from the database.
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expectRejected(
        { dataset: 'orders', dimensions: [{ table: name, column: 'x' }], measures: [] },
        'unknown_table',
      );
      expectRejected(
        { dataset: 'orders', dimensions: [{ table: 'fact_orders', column: name }], measures: [] },
        'unknown_column',
      );
    }
  });

  it('rejects a non-string table or column reference', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expectRejected({
        dataset: 'orders',
        dimensions: [{ table: value, column: 'category' }],
        measures: [],
      });
      expectRejected({
        dataset: 'orders',
        dimensions: [{ table: 'fact_orders', column: value }],
        measures: [],
      });
    }
  });

  it('rejects an unknown dataset', () => {
    expectRejected(
      { dataset: `orders'; DROP TABLE x; --`, dimensions: [], measures: [BASE_MEASURE] },
      'unknown_dataset',
    );
  });
});

describe('SQL keywords come from closed unions, never from the request', () => {
  it('rejects an aggregate function that is not one of the six', () => {
    for (const fn of [`SUM(x) FROM y; --`, 'EVIL', 'sum', '', null, 1]) {
      expectRejected(
        {
          dataset: 'orders',
          dimensions: [],
          measures: [{ table: 'fact_orders', column: 'revenue', fn }],
        },
        'invalid_aggregate',
      );
    }
  });

  it('rejects an unknown filter operator', () => {
    for (const operator of [`eq; DROP TABLE x`, 'EXISTS', '=', null, 7]) {
      expectRejected(
        {
          dataset: 'orders',
          dimensions: [],
          measures: [BASE_MEASURE],
          filters: [
            { table: 'fact_orders', column: 'order_status', operator, values: ['completed'] },
          ],
        },
        'invalid_operator',
      );
    }
  });

  it('rejects a date grain outside the enum', () => {
    for (const grain of [`month', (SELECT version())) --`, 'century', 'DAY', 1]) {
      expectRejected(
        {
          dataset: 'orders',
          dimensions: [{ table: 'dim_date', column: 'full_date', grain }],
          measures: [],
        },
        'invalid_grain',
      );
    }
  });

  it('rejects a sort direction outside asc/desc', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        sort: [{ alias: 'revenue_sum', direction: `ASC; DROP TABLE x; --` }],
      },
      'invalid_sort_direction',
    );
  });

  it('rejects a sort alias that is not an output column of this query', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        sort: [{ alias: `revenue_sum" DESC, (SELECT 1) --`, direction: 'asc' }],
      },
      'unknown_sort_alias',
    );
  });
});

describe('aliases are constrained to a narrow grammar', () => {
  it('rejects an alias containing a quote', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [{ ...BASE_MEASURE, alias: `total", (SELECT 1) AS "x` }],
      },
      'invalid_alias',
    );
  });

  it('rejects aliases with spaces, punctuation, or a leading digit', () => {
    for (const alias of ['total revenue', 'total-revenue', '1total', 'tot;al', 'tot--al', '']) {
      expectRejected(
        { dataset: 'orders', dimensions: [], measures: [{ ...BASE_MEASURE, alias }] },
        'invalid_alias',
      );
    }
  });

  it('rejects an alias long enough to be silently truncated by Postgres', () => {
    expectRejected(
      { dataset: 'orders', dimensions: [], measures: [{ ...BASE_MEASURE, alias: 'a'.repeat(64) }] },
      'invalid_alias',
    );
  });

  it('accepts a plain identifier alias', () => {
    const { columns } = compile({
      dataset: 'orders',
      dimensions: [],
      measures: [{ ...BASE_MEASURE, alias: 'total_revenue_2024' }],
    });
    expect(columns).toEqual(['total_revenue_2024']);
  });
});

describe('limit and offset are numeric, not textual', () => {
  it('rejects a string limit even when it looks like a number', () => {
    expectRejected(
      { dataset: 'orders', dimensions: [], measures: [BASE_MEASURE], limit: '100' },
      'invalid_limit',
    );
  });

  it('rejects a limit carrying appended SQL', () => {
    expectRejected(
      { dataset: 'orders', dimensions: [], measures: [BASE_MEASURE], limit: '1; DROP TABLE x' },
      'invalid_limit',
    );
    expectRejected(
      { dataset: 'orders', dimensions: [], measures: [BASE_MEASURE], offset: '0; DROP TABLE x' },
      'invalid_offset',
    );
  });

  it('rejects NaN and Infinity', () => {
    expectRejected(
      { dataset: 'orders', dimensions: [], measures: [BASE_MEASURE], limit: Number.NaN },
      'invalid_limit',
    );
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        limit: Number.POSITIVE_INFINITY,
      },
      'invalid_limit',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* B. Value positions never become SQL text                                   */
/* -------------------------------------------------------------------------- */

describe('filter operands are transported as parameters', () => {
  it('accepts a SQL statement as a string operand and binds it verbatim', () => {
    const payload = `'; DROP TABLE analytics.fact_orders; --`;

    const { text, values } = compile({
      dataset: 'orders',
      dimensions: [],
      measures: [BASE_MEASURE],
      filters: [
        { table: 'dim_product', column: 'product_name', operator: 'eq', values: [payload] },
      ],
    });

    // The payload is a legitimate string to search for. It is bound, untouched...
    expect(values).toContain(payload);
    // ...and appears nowhere in the SQL the database will parse.
    expect(text).not.toContain('DROP');
    expect(text).toContain('"dim_product"."product_name" = $1');
  });

  it('binds every operand of an IN list, however many there are', () => {
    const { text, values } = compile({
      dataset: 'orders',
      dimensions: [],
      measures: [BASE_MEASURE],
      filters: [
        {
          table: 'fact_orders',
          column: 'order_status',
          operator: 'in',
          values: [...PAYLOADS],
        },
      ],
    });

    expect(values[0]).toEqual([...PAYLOADS]);
    expect(text).toContain('= ANY($1)');
    for (const payload of PAYLOADS) {
      expect(text).not.toContain(payload);
    }
  });

  it('escapes wildcards in a LIKE operand without ever inlining it', () => {
    const { text, values } = compile({
      dataset: 'orders',
      dimensions: [],
      measures: [BASE_MEASURE],
      filters: [
        {
          table: 'dim_product',
          column: 'product_name',
          operator: 'contains',
          values: [`100% ' OR 1=1 --`],
        },
      ],
    });

    expect(values[0]).toBe(`%100\\% ' OR 1=1 --%`);
    expect(text).not.toContain('OR 1=1');
  });

  it('rejects an operand containing a NUL byte, which would truncate in libpq', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        filters: [
          {
            table: 'dim_product',
            column: 'product_name',
            operator: 'eq',
            values: ['abc\0DROP TABLE x'],
          },
        ],
      },
      'invalid_value',
    );
  });

  it('caps the number of operands a single filter may carry', () => {
    expectRejected(
      {
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        filters: [
          {
            table: 'fact_orders',
            column: 'order_status',
            operator: 'in',
            values: Array.from({ length: 5_000 }, (_, i) => `s${i}`),
          },
        ],
      },
      'invalid_arity',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Output shape invariants                                                    */
/* -------------------------------------------------------------------------- */

describe('generated SQL is always a single statement', () => {
  it('contains no statement terminator or comment marker', () => {
    const { text } = compile({
      dataset: 'orders',
      dimensions: [
        { table: 'dim_product', column: 'category' },
        { table: 'dim_date', column: 'full_date', grain: 'month' },
      ],
      measures: [
        BASE_MEASURE,
        { table: 'fact_orders', column: 'customer_id', fn: 'COUNT_DISTINCT' },
      ],
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
        { table: 'dim_store', column: 'channel', operator: 'in', values: ['Online', 'Retail'] },
      ],
      sort: [{ alias: 'revenue_sum', direction: 'desc' }],
      limit: 100,
    });

    expect(text).not.toContain(';');
    expect(text).not.toContain('--');
    expect(text).not.toContain('/*');
  });
});

/* -------------------------------------------------------------------------- */
/* Exhaustive sweep                                                           */
/* -------------------------------------------------------------------------- */

describe('every payload in every position', () => {
  /**
   * Each entry builds a spec with `payload` placed in one user-controlled
   * position. The contract for all of them is identical: either the compiler
   * rejects the spec, or the payload does not appear in the generated SQL.
   */
  const positions: { name: string; build: (payload: string) => unknown }[] = [
    {
      name: 'dataset',
      build: (payload) => ({ dataset: payload, dimensions: [], measures: [BASE_MEASURE] }),
    },
    {
      name: 'dimension.table',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [{ table: payload, column: 'category' }],
        measures: [],
      }),
    },
    {
      name: 'dimension.column',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [{ table: 'dim_product', column: payload }],
        measures: [],
      }),
    },
    {
      name: 'dimension.alias',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [{ table: 'dim_product', column: 'category', alias: payload }],
        measures: [],
      }),
    },
    {
      name: 'dimension.grain',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [{ table: 'dim_date', column: 'full_date', grain: payload }],
        measures: [],
      }),
    },
    {
      name: 'measure.table',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [{ table: payload, column: 'revenue', fn: 'SUM' }],
      }),
    },
    {
      name: 'measure.column',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [{ table: 'fact_orders', column: payload, fn: 'SUM' }],
      }),
    },
    {
      name: 'measure.fn',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [{ table: 'fact_orders', column: 'revenue', fn: payload }],
      }),
    },
    {
      name: 'measure.alias',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [{ ...BASE_MEASURE, alias: payload }],
      }),
    },
    {
      name: 'filter.table',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        filters: [{ table: payload, column: 'category', operator: 'eq', values: ['x'] }],
      }),
    },
    {
      name: 'filter.column',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        filters: [{ table: 'dim_product', column: payload, operator: 'eq', values: ['x'] }],
      }),
    },
    {
      name: 'filter.operator',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        filters: [{ table: 'dim_product', column: 'category', operator: payload, values: ['x'] }],
      }),
    },
    {
      name: 'filter.value',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        filters: [{ table: 'dim_product', column: 'category', operator: 'eq', values: [payload] }],
      }),
    },
    {
      name: 'sort.alias',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        sort: [{ alias: payload, direction: 'asc' }],
      }),
    },
    {
      name: 'sort.direction',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        sort: [{ alias: 'revenue_sum', direction: payload }],
      }),
    },
    {
      name: 'limit',
      build: (payload) => ({
        dataset: 'orders',
        dimensions: [],
        measures: [BASE_MEASURE],
        limit: payload,
      }),
    },
  ];

  for (const position of positions) {
    for (const payload of PAYLOADS) {
      it(`${position.name} <- ${JSON.stringify(payload).slice(0, 48)}`, () => {
        let compiled;
        try {
          compiled = compile(position.build(payload));
        } catch (error) {
          // Rejection is a pass - but only a *deliberate* rejection. A
          // TypeError here would mean the compiler crashed rather than
          // validated, and a crash is not a security control.
          expect(error).toBeInstanceOf(QueryCompileError);
          return;
        }

        // If it compiled, the payload must live entirely in the bound values.
        expect(compiled.text).not.toContain(payload);
        expect(compiled.text).not.toContain('DROP');
        expect(compiled.text).not.toContain('pg_sleep');
        expect(compiled.text).not.toContain('pg_read_file');
        expect(compiled.text).not.toContain(';');
      });
    }
  }
});
