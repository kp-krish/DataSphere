/**
 * Query endpoints.
 *
 * POST rather than GET for execution, despite it being a read. A query spec is
 * a nested object that does not fit sensibly in a query string, and URL length
 * limits would cap how complex a dashboard widget could get. The cost is that
 * intermediaries will not cache the response - which is fine, because caching
 * these is Redis's job and it can key on the normalised spec rather than on
 * the exact bytes of a URL.
 */

import { Router } from 'express';
import { executeQuerySchema, querySpecSchema } from '../schemas/query.js';
import { compileOnly, executeQuery } from '../query/service.js';

export const queryRouter: Router = Router();

/**
 * Execute a query spec.
 *
 * The response carries the rows plus a `meta` block reporting how long it
 * took, whether the cache was used, and the row limit actually applied. That
 * block is not debug output - the UI surfaces it, which is what makes the
 * caching work visible rather than a claim in a README.
 */
queryRouter.post('/query', async (req, res) => {
  const body = executeQuerySchema.parse(req.body);

  const result = await executeQuery(body.spec, {
    noCache: body.noCache,
    includeSql: body.includeSql,
  });

  req.log?.debug(
    {
      dataset: body.spec.dataset,
      rowCount: result.meta.rowCount,
      executionMs: result.meta.executionMs,
      cache: result.meta.cache,
    },
    'Query executed',
  );

  res.json(result);
});

/**
 * Compile a spec to SQL without running it.
 *
 * This is what lets the query builder show the generated SQL as the user
 * assembles a query, and validate the spec on every edit, without putting a
 * two-million-row aggregate through Postgres on each keystroke.
 *
 * The bound values are returned alongside the text, separately - the point is
 * to show that the values are not in the SQL.
 */
queryRouter.post('/query/compile', async (req, res) => {
  const spec = querySpecSchema.parse(req.body);
  const { compiled, cacheKey } = await compileOnly(spec);

  res.json({
    sql: compiled.text,
    values: compiled.values,
    columns: compiled.columns,
    appliedLimit: compiled.appliedLimit,
    cacheKey,
  });
});
