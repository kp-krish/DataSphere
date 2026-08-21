/**
 * Request schemas for the query endpoints.
 *
 * There are two validation layers, and the split between them is deliberate:
 *
 *   zod, here      - *shape*. Is `dimensions` an array? Is `operator` one of
 *                    the fourteen known strings? Is `limit` a positive
 *                    integer? Rejects malformed JSON before it reaches any
 *                    application code, and produces field-level errors the
 *                    query builder UI can attach to the right control.
 *
 *   the compiler   - *meaning*. Does this table exist in the catalog? Can
 *                    this operator apply to this column's type? Is this alias
 *                    one of the query's own outputs? Only the catalog can
 *                    answer those, so only the compiler can check them.
 *
 * The layers overlap on enums, which is intentional. Neither is load-bearing
 * alone: the compiler's tests prove it rejects a bad operator even with no
 * schema in front of it, and this schema rejects one even if the compiler
 * changed. Defence in depth means both, not either.
 */

import { z } from 'zod';

/** Postgres truncates identifiers at 63 bytes; see sql/identifiers.ts. */
const ALIAS_MAX = 63;

/**
 * Mirrors the compiler's alias grammar. Duplicated rather than imported
 * because zod needs a regex and the compiler needs to throw a
 * QueryCompileError - but both must stay in step, which the shared test
 * corpus enforces.
 */
const aliasSchema = z
  .string()
  .min(1)
  .max(ALIAS_MAX)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Alias may contain only letters, digits and underscores, and may not start with a digit',
  );

const fieldRefShape = {
  table: z.string().min(1).max(ALIAS_MAX),
  column: z.string().min(1).max(ALIAS_MAX),
};

export const dimensionSchema = z.strictObject({
  ...fieldRefShape,
  alias: aliasSchema.optional(),
  grain: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
});

export const measureSchema = z.strictObject({
  ...fieldRefShape,
  fn: z.enum(['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX']),
  alias: aliasSchema.optional(),
});

/**
 * A filter operand. Deliberately permissive about *content* - a string
 * operand may hold anything, including SQL - because operands are bound as
 * parameters and never parsed as SQL. The compiler then checks the value's
 * JavaScript type against the column's semantic kind.
 */
const filterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const filterSchema = z.strictObject({
  ...fieldRefShape,
  operator: z.enum([
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'not_in',
    'between',
    'contains',
    'starts_with',
    'ends_with',
    'is_null',
    'is_not_null',
  ]),
  // Matches MAX_IN_OPERANDS in the compiler. A filter with more operands than
  // this is a denial of service rather than a filter.
  values: z.array(filterValueSchema).max(1_000).optional(),
});

export const sortSchema = z.strictObject({
  alias: z.string().min(1).max(ALIAS_MAX),
  direction: z.enum(['asc', 'desc']),
});

/**
 * `strictObject` throughout: an unrecognised key is an error, not something to
 * ignore. A client sending `{ filter: [...] }` instead of `{ filters: [...] }`
 * should be told, not silently handed an unfiltered two-million-row scan.
 */
export const querySpecSchema = z.strictObject({
  dataset: z.string().min(1).max(ALIAS_MAX),
  dimensions: z.array(dimensionSchema).max(12).default([]),
  measures: z.array(measureSchema).max(12).default([]),
  filters: z.array(filterSchema).max(32).optional(),
  sort: z.array(sortSchema).max(8).optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
});

export const executeQuerySchema = z.strictObject({
  spec: querySpecSchema,
  /**
   * Skip the cache for this request and go to Postgres. The response still
   * reports what happened, as cache: "bypass". Used by the UI's manual
   * refresh and by the benchmark harness.
   */
  noCache: z.boolean().optional().default(false),
  /** Include the generated SQL in the response meta. */
  includeSql: z.boolean().optional().default(false),
});

export type ExecuteQueryBody = z.infer<typeof executeQuerySchema>;
