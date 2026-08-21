import { describe, expect, it } from 'vitest';
import type { FieldDef } from 'pg';
import { coerceNumericString, coerceRows } from './coerce.js';

describe('coerceNumericString', () => {
  it('converts aggregate totals a dashboard actually produces', () => {
    expect(coerceNumericString('637081797.57')).toBe(637081797.57);
    expect(coerceNumericString('702816')).toBe(702816);
    expect(coerceNumericString('0.00')).toBe(0);
    expect(coerceNumericString('-1234.5')).toBe(-1234.5);
  });

  it('converts an AVG with more decimals than a double can hold', () => {
    // AVG(smallint) comes back with sixteen decimal places. Keeping this as a
    // string would leave every average rendering as text in a chart, while
    // preserving nothing: a client parsing it gets this same double.
    expect(coerceNumericString('2.5988281427855940')).toBe(2.598828142785594);
  });

  it('leaves integers beyond the safe range as strings', () => {
    // A bigint id past 2^53 would come back as a different number.
    expect(coerceNumericString('9007199254740993')).toBe('9007199254740993');
    expect(coerceNumericString('123456789012345678901234567890')).toBe(
      '123456789012345678901234567890',
    );
  });

  it('keeps the largest safe integer', () => {
    expect(coerceNumericString('9007199254740991')).toBe(9_007_199_254_740_991);
  });

  it('leaves values Postgres reports as non-numeric alone', () => {
    expect(coerceNumericString('NaN')).toBe('NaN');
    expect(coerceNumericString('Infinity')).toBe('Infinity');
  });
});

describe('coerceRows', () => {
  // Only the two properties coerceRows reads; the rest of FieldDef is noise
  // for this test.
  const field = (name: string, dataTypeID: number) =>
    ({ name, dataTypeID }) as unknown as FieldDef;

  it('converts only the columns Postgres typed as numeric or bigint', () => {
    const rows = [{ category: 'Technology', revenue: '1234.56', sku: '0012345', orders: '42' }];

    coerceRows(rows, [
      field('category', 25), // text
      field('revenue', 1700), // numeric
      field('sku', 25), // text that looks numeric
      field('orders', 20), // int8
    ]);

    expect(rows[0]).toEqual({
      category: 'Technology',
      revenue: 1234.56,
      // Leading zero preserved: it is a text column, so it is never touched.
      sku: '0012345',
      orders: 42,
    });
  });

  it('does nothing when no column needs it', () => {
    const rows = [{ name: 'x' }];
    expect(coerceRows(rows, [field('name', 25)])).toEqual([{ name: 'x' }]);
  });

  it('leaves nulls alone', () => {
    const rows = [{ revenue: null }];
    coerceRows(rows, [field('revenue', 1700)]);
    expect(rows[0]!.revenue).toBeNull();
  });
});
