/**
 * Demo data mutation.
 *
 * "Explicit invalidation when the underlying data changes" needs something
 * that actually changes the underlying data, otherwise the invalidation path
 * can only ever be triggered by hand and is impossible to demonstrate.
 *
 * This appends synthetic order lines to the fact table and invalidates the
 * dataset in the same request, which makes the whole loop visible: a widget
 * shows a cached total, orders arrive, the SSE stream fires, the widget
 * refetches, and the number moves.
 *
 * It is clearly scoped and clearly labelled. Real ingestion would be a
 * separate pipeline calling the same `invalidateDataset` seam - the point of
 * this endpoint is that the seam exists and is exercised, not that this is how
 * orders would really arrive.
 */

import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { invalidateDataset } from '../cache/generations.js';
import { ApiError } from '../http/errors.js';

export const demoRouter: Router = Router();

const simulateSchema = z.strictObject({
  /** Kept small: this is a demonstration, not a load generator. */
  count: z.number().int().min(1).max(1_000).optional().default(10),
});

/**
 * Append `count` random order lines, then invalidate the orders dataset.
 *
 * The rows are generated in SQL rather than in Node so the whole thing is one
 * statement and one round trip. Dimension keys are drawn from the dimension
 * tables themselves, so every foreign key resolves by construction rather than
 * by luck.
 */
demoRouter.post('/demo/orders', async (req, res) => {
  const { count } = simulateSchema.parse(req.body ?? {});

  const { rows } = await pool.query<{ inserted: string; revenue: string }>(
    `WITH picked AS (
       SELECT
         p.product_id,
         p.unit_cost,
         p.list_price,
         (SELECT customer_id FROM analytics.dim_customer ORDER BY random() LIMIT 1) AS customer_id,
         (SELECT store_id    FROM analytics.dim_store    ORDER BY random() LIMIT 1) AS store_id,
         -- Dated today where the calendar covers it, else the latest day the
         -- dimension knows about, so the foreign key always resolves.
         (SELECT date_key FROM analytics.dim_date
           WHERE full_date <= CURRENT_DATE ORDER BY full_date DESC LIMIT 1) AS date_key,
         (1 + floor(random() * 4))::smallint AS quantity
       FROM analytics.dim_product p
       ORDER BY random()
       LIMIT $1
     ), inserted AS (
       INSERT INTO analytics.fact_orders
         (ordered_at, date_key, customer_id, product_id, store_id,
          quantity, unit_price, discount_pct, revenue, cost, order_status)
       SELECT
         now(),
         picked.date_key,
         picked.customer_id,
         picked.product_id,
         picked.store_id,
         picked.quantity,
         picked.list_price,
         0,
         round(picked.list_price * picked.quantity, 2),
         round(picked.unit_cost  * picked.quantity, 2),
         'completed'
       FROM picked
       RETURNING revenue
     )
     SELECT count(*)::text AS inserted, COALESCE(sum(revenue), 0)::text AS revenue FROM inserted`,
    [count],
  );

  const inserted = Number(rows[0]?.inserted ?? 0);
  if (inserted === 0) {
    throw ApiError.serviceUnavailable(
      'no_rows_inserted',
      'No rows were inserted. Is the database seeded?',
    );
  }

  // The write is committed, so anything still cached is now wrong. Invalidate
  // before responding, so a client that refetches on this response cannot race
  // the invalidation and read a stale entry.
  const generation = await invalidateDataset('orders', `${inserted} new order line(s)`);

  req.log?.info({ inserted, generation }, 'Demo orders inserted and cache invalidated');

  res.status(201).json({
    inserted,
    revenueAdded: Number(rows[0]?.revenue ?? 0),
    dataset: 'orders',
    generation,
  });
});
