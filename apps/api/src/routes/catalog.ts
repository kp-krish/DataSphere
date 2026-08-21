/**
 * Catalog endpoints.
 *
 * The catalog is what the query builder UI is built from: it lists the
 * datasets a user can pick, the columns on each, and - through each column's
 * `kind` - which aggregates and filter operators the UI should offer. Getting
 * that from the server rather than hardcoding it in the client is what keeps
 * the two from disagreeing about what is queryable.
 */

import { Router } from 'express';
import { operatorsForKind, type ColumnKind } from '@datasphere/core';
import { getCatalog, peekCatalog, refreshCatalog } from '../catalog/service.js';
import { env } from '../config/env.js';

export const catalogRouter: Router = Router();

/**
 * The operator list per column kind, sent once alongside the catalog.
 *
 * Without this the client would have to reimplement the compiler's rules to
 * know that `contains` applies to text but not to an integer - and any drift
 * between the two would show up as a filter the UI offers and the server
 * rejects.
 */
function operatorMatrix(): Record<ColumnKind, readonly string[]> {
  const kinds: ColumnKind[] = ['string', 'integer', 'number', 'boolean', 'date', 'timestamp'];
  return Object.fromEntries(kinds.map((kind) => [kind, operatorsForKind(kind)])) as Record<
    ColumnKind,
    readonly string[]
  >;
}

catalogRouter.get('/catalog', async (_req, res) => {
  const catalog = await getCatalog();
  const cached = peekCatalog();

  res.json({
    ...catalog,
    meta: {
      ageSeconds: cached?.ageSeconds ?? 0,
      operators: operatorMatrix(),
      aggregates: ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX'],
      grains: ['day', 'week', 'month', 'quarter', 'year'],
      limits: {
        // Sent so the UI can show the ceiling instead of letting a user set a
        // limit that will be silently clamped.
        maxRows: env.QUERY_MAX_ROWS,
        defaultLimit: env.QUERY_DEFAULT_LIMIT,
        maxDimensions: 12,
        maxMeasures: 12,
        maxFilters: 32,
      },
    },
  });
});

/**
 * Force a re-read after a migration.
 *
 * POST rather than GET because it has a side effect, even though it returns
 * the same body.
 */
catalogRouter.post('/catalog/refresh', async (req, res) => {
  const catalog = await refreshCatalog();
  req.log?.info({ tables: catalog.tables.length }, 'Catalog refreshed on request');
  res.json(catalog);
});
