/**
 * DataSphere seed script.
 *
 * Generates a realistic e-commerce star schema and bulk loads it into
 * PostgreSQL: four dimension tables plus a fact table of (by default) two
 * million order lines.
 *
 * Design notes that matter:
 *
 * - Everything is driven by a seeded PRNG, so the same SEED_RANDOM_SEED
 *   produces byte-identical data on every machine. Benchmarks measured
 *   against different data are not comparable, and "2 million random rows"
 *   is not a reproducible fixture.
 *
 * - Distributions are deliberately skewed. Customers and products follow a
 *   power law, orders follow monthly and weekday seasonality on top of a
 *   year-over-year growth trend. Uniform data makes every filter equally
 *   selective, which flatters indexes in ways that do not survive contact
 *   with reality.
 *
 * - Loading goes through COPY FROM STDIN, streamed, with the fact table's
 *   foreign keys dropped for the duration and re-added afterwards. Re-adding
 *   validates the whole table with a single join against the (small, cached)
 *   dimensions, which is far cheaper than two million individual index
 *   probes during the load.
 *
 * - The script is idempotent: if the fact table already holds the target
 *   number of rows it exits without doing anything, so `docker compose up`
 *   on an existing volume is fast. Pass --force to rebuild.
 *
 * Usage:
 *   npm run seed                  # from the repo root
 *   npm run seed -- --force       # rebuild even if already seeded
 */

import process from 'node:process';
import { Client } from 'pg';
import { copyEscape as esc, copyInto, copyRow } from './lib/copy.js';
import {
  buildCdf,
  createRng,
  gaussian,
  pick,
  powerLawIndex,
  randFloat,
  randInt,
  sampleCdf,
  shuffle,
  weightedPick,
  type Rng,
} from './lib/rng.js';
import {
  ANNUAL_GROWTH_RATE,
  BRANDS,
  CUSTOMER_SEGMENTS,
  DAY_NAMES,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  GEOGRAPHY,
  LAST_NAMES,
  MONTH_NAMES,
  MONTH_SEASONALITY,
  ORDER_STATUSES,
  PRODUCT_MODIFIERS,
  PRODUCT_TAXONOMY,
  STORE_CHANNELS,
  WEEKDAY_SEASONALITY,
  type SubcategorySpec,
} from './lib/pools.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;

/** Rows accumulated into a single stream write. Tuned by hand; see copy.ts. */
const CHUNK_ROWS = 4_096;

interface SeedConfig {
  databaseUrl: string;
  factRows: number;
  customers: number;
  products: number;
  stores: number;
  dateStart: string;
  dateEnd: string;
  progressEvery: number;
  randomSeed: number;
  force: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return Math.floor(parsed);
}

function envDate(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${name} must be YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

function loadConfig(argv: string[]): SeedConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const config: SeedConfig = {
    databaseUrl,
    factRows: envInt('SEED_FACT_ROWS', 2_000_000),
    customers: envInt('SEED_CUSTOMERS', 50_000),
    products: envInt('SEED_PRODUCTS', 5_000),
    stores: envInt('SEED_STORES', 200),
    dateStart: envDate('SEED_DATE_START', '2021-01-01'),
    dateEnd: envDate('SEED_DATE_END', '2025-12-31'),
    progressEvery: envInt('SEED_BATCH_SIZE', 50_000),
    randomSeed: envInt('SEED_RANDOM_SEED', 20_240_617),
    force: argv.includes('--force') || process.env.SEED_FORCE === 'true',
  };

  if (Date.parse(`${config.dateEnd}T00:00:00Z`) < Date.parse(`${config.dateStart}T00:00:00Z`)) {
    throw new Error('SEED_DATE_END must be on or after SEED_DATE_START');
  }
  // dim_store.store_id is a smallint, so the store count has a hard ceiling.
  if (config.stores > 32_767) {
    throw new Error('SEED_STORES cannot exceed 32767 (dim_store.store_id is a smallint)');
  }
  return config;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const round2 = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
const round4 = (value: number): string => (Math.round(value * 10_000) / 10_000).toFixed(4);

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** ISO 8601 week number for a UTC date. */
function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7; // Sunday counts as 7, not 0.
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber); // Move to the Thursday.
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  return Math.ceil(((target.getTime() - yearStart) / MS_PER_DAY + 1) / 7);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

/* -------------------------------------------------------------------------- */
/* Dimension generation                                                       */
/* -------------------------------------------------------------------------- */

interface DateDimension {
  /** Integer YYYYMMDD keys, in chronological order. */
  keys: Int32Array;
  /** UTC midnight epoch millis, parallel to `keys`. */
  epochs: Float64Array;
  /** Normalised cumulative demand weight, for sampling order dates. */
  cdf: Float64Array;
  rows: string[];
}

function generateDateDimension(config: SeedConfig): DateDimension {
  const start = Date.parse(`${config.dateStart}T00:00:00Z`);
  const end = Date.parse(`${config.dateEnd}T00:00:00Z`);
  const dayCount = Math.floor((end - start) / MS_PER_DAY) + 1;

  const keys = new Int32Array(dayCount);
  const epochs = new Float64Array(dayCount);
  const weights: number[] = new Array(dayCount);
  const rows: string[] = new Array(dayCount);

  const startYear = new Date(start).getUTCFullYear();

  for (let i = 0; i < dayCount; i++) {
    const epoch = start + i * MS_PER_DAY;
    const date = new Date(epoch);

    const year = date.getUTCFullYear();
    const monthIndex = date.getUTCMonth();
    const dayOfMonth = date.getUTCDate();
    const isoDayOfWeek = date.getUTCDay() || 7; // 1 = Monday .. 7 = Sunday
    const dateKey = year * 10_000 + (monthIndex + 1) * 100 + dayOfMonth;

    keys[i] = dateKey;
    epochs[i] = epoch;

    // Seasonality x weekday shape x compounding annual growth. This is what
    // gives the fact table a trend a line chart can actually show.
    const growth = Math.pow(1 + ANNUAL_GROWTH_RATE, year - startYear);
    weights[i] =
      (MONTH_SEASONALITY[monthIndex] as number) *
      (WEEKDAY_SEASONALITY[isoDayOfWeek - 1] as number) *
      growth;

    rows[i] = copyRow([
      String(dateKey),
      `${year}-${pad(monthIndex + 1, 2)}-${pad(dayOfMonth, 2)}`,
      String(dayOfMonth),
      String(isoDayOfWeek),
      esc(DAY_NAMES[isoDayOfWeek - 1] as string),
      String(isoWeek(date)),
      String(monthIndex + 1),
      esc(MONTH_NAMES[monthIndex] as string),
      String(Math.floor(monthIndex / 3) + 1),
      String(year),
      isoDayOfWeek >= 6 ? 't' : 'f',
    ]);
  }

  return { keys, epochs, cdf: buildCdf(weights), rows };
}

function generateCustomerRows(rng: Rng, config: SeedConfig): string[] {
  const rows: string[] = new Array(config.customers);
  const signupStart = Date.parse('2019-01-01T00:00:00Z');
  const signupEnd = Date.parse(`${config.dateEnd}T00:00:00Z`);
  const signupSpanDays = Math.floor((signupEnd - signupStart) / MS_PER_DAY);

  for (let i = 0; i < config.customers; i++) {
    const customerId = i + 1;
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const geo = pick(rng, GEOGRAPHY);
    const signup = new Date(signupStart + randInt(rng, 0, signupSpanDays) * MS_PER_DAY);

    rows[i] = copyRow([
      String(customerId),
      esc(`${firstName} ${lastName}`),
      // The id keeps the address unique even when two customers share a name.
      esc(`${slugify(firstName)}.${slugify(lastName)}${customerId}@${pick(rng, EMAIL_DOMAINS)}`),
      esc(weightedPick(rng, CUSTOMER_SEGMENTS)),
      esc(geo.country),
      esc(geo.region),
      esc(pick(rng, geo.cities)),
      signup.toISOString().slice(0, 10),
    ]);
  }
  return rows;
}

interface ProductDimension {
  rows: string[];
  /** Parallel arrays indexed by (product_id - 1); the fact loop is hot. */
  unitCost: Float64Array;
  listPrice: Float64Array;
}

function generateProductDimension(rng: Rng, config: SeedConfig): ProductDimension {
  // Flatten the taxonomy into a weighted pick list once, up front.
  const subcategoryChoices: (readonly [{ category: string; spec: SubcategorySpec }, number])[] = [];
  for (const category of PRODUCT_TAXONOMY) {
    for (const spec of category.subcategories) {
      subcategoryChoices.push([{ category: category.name, spec }, spec.weight]);
    }
  }

  const rows: string[] = new Array(config.products);
  const unitCost = new Float64Array(config.products);
  const listPrice = new Float64Array(config.products);
  const usedSkus = new Set<string>();

  for (let i = 0; i < config.products; i++) {
    const productId = i + 1;
    const { category, spec } = weightedPick(rng, subcategoryChoices);

    // Cost clusters around the subcategory mean rather than spreading evenly,
    // so "average unit cost by subcategory" is a meaningful chart.
    const cost = gaussian(
      rng,
      spec.meanCost,
      spec.costStdDev,
      spec.meanCost * 0.25,
      spec.meanCost * 3,
    );
    // Retail margins vary by item; the CHECK constraint requires price >= cost.
    const price = cost * randFloat(rng, 1.15, 2.6);

    unitCost[i] = Math.round(cost * 100) / 100;
    listPrice[i] = Math.round(price * 100) / 100;

    const brand = pick(rng, BRANDS);
    const prefix = `${category.slice(0, 3).toUpperCase()}-${spec.name.slice(0, 3).toUpperCase()}`;

    // SKUs carry a UNIQUE constraint. The id suffix makes collisions
    // impossible, but assert it rather than trusting the construction.
    const sku = `${prefix}-${pad(productId, 6)}`;
    if (usedSkus.has(sku)) throw new Error(`Duplicate SKU generated: ${sku}`);
    usedSkus.add(sku);

    rows[i] = copyRow([
      String(productId),
      esc(`${brand} ${spec.name.replace(/s$/, '')} ${pick(rng, PRODUCT_MODIFIERS)}`),
      esc(sku),
      esc(category),
      esc(spec.name),
      esc(brand),
      round2(unitCost[i] as number),
      round2(listPrice[i] as number),
    ]);
  }

  return { rows, unitCost, listPrice };
}

function generateStoreRows(rng: Rng, config: SeedConfig): string[] {
  const rows: string[] = new Array(config.stores);
  const openStart = Date.parse('2015-01-01T00:00:00Z');
  const openSpanDays = Math.floor((Date.parse('2023-12-31T00:00:00Z') - openStart) / MS_PER_DAY);

  for (let i = 0; i < config.stores; i++) {
    const storeId = i + 1;
    const geo = pick(rng, GEOGRAPHY);
    const city = pick(rng, geo.cities);
    const channel = weightedPick(rng, STORE_CHANNELS);
    const openedOn = new Date(openStart + randInt(rng, 0, openSpanDays) * MS_PER_DAY);

    rows[i] = copyRow([
      String(storeId),
      esc(`${city} ${channel} ${pad(storeId, 3)}`),
      esc(channel),
      esc(geo.country),
      esc(geo.region),
      esc(city),
      openedOn.toISOString().slice(0, 10),
    ]);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Fact generation                                                            */
/* -------------------------------------------------------------------------- */

interface FactContext {
  config: SeedConfig;
  rng: Rng;
  dates: DateDimension;
  products: ProductDimension;
  /** customer_id values ordered most- to least-active. */
  customersByPopularity: Int32Array;
  /** product_id values ordered most- to least-popular. */
  productsByPopularity: Int32Array;
  /** store_id values ordered busiest to quietest. */
  storesByPopularity: Int32Array;
  onProgress: (rowsWritten: number) => void;
}

/**
 * Yields COPY TEXT chunks for fact_orders.
 *
 * Written as a generator so rows are produced lazily under the stream's
 * backpressure - the whole 2M-row payload is never resident in memory.
 */
function* generateFactChunks(ctx: FactContext): Generator<string> {
  const {
    config,
    rng,
    dates,
    products,
    customersByPopularity,
    productsByPopularity,
    storesByPopularity,
  } = ctx;

  const customerCount = customersByPopularity.length;
  const productCount = productsByPopularity.length;
  const storeCount = storesByPopularity.length;

  const buffer: string[] = [];
  let written = 0;

  for (let i = 0; i < config.factRows; i++) {
    const orderId = i + 1;

    // --- when -------------------------------------------------------------
    const dayIndex = sampleCdf(rng, dates.cdf);
    const dateKey = dates.keys[dayIndex] as number;
    // Orders cluster in the working day, tapering into the evening.
    const hour = Math.round(gaussian(rng, 14, 4, 6, 23));
    const orderedAtMs =
      (dates.epochs[dayIndex] as number) +
      hour * 3_600_000 +
      randInt(rng, 0, 59) * 60_000 +
      randInt(rng, 0, 59) * 1_000;

    // --- who and what -----------------------------------------------------
    // A minority of customers place most orders; likewise for products.
    const customerId = customersByPopularity[powerLawIndex(rng, customerCount, 1.6)] as number;
    const productIndex = powerLawIndex(rng, productCount, 2.2);
    const productId = productsByPopularity[productIndex] as number;
    const storeId = storesByPopularity[powerLawIndex(rng, storeCount, 1.4)] as number;

    const baseCost = products.unitCost[productId - 1] as number;
    const basePrice = products.listPrice[productId - 1] as number;

    // --- money ------------------------------------------------------------
    // Expensive goods sell in ones and twos; consumables sell by the box.
    const maxQuantity = basePrice > 300 ? 3 : basePrice > 80 ? 6 : 12;
    const quantity = 1 + Math.floor(Math.pow(rng(), 2) * maxQuantity);

    // Street price drifts a little either side of list.
    const unitPrice = Math.round(basePrice * randFloat(rng, 0.92, 1.06) * 100) / 100;

    // Most lines are undiscounted; the rest carry a promotional discount.
    // A deep discount on a thin-margin item can book negative profit, which
    // is exactly what a real clearance line does.
    const discount = rng() < 0.28 ? randFloat(rng, 0.05, 0.35) : 0;

    const revenue = quantity * unitPrice * (1 - discount);
    const cost = quantity * baseCost;

    buffer.push(
      copyRow([
        String(orderId),
        new Date(orderedAtMs).toISOString(),
        String(dateKey),
        String(customerId),
        String(productId),
        String(storeId),
        String(quantity),
        round2(unitPrice),
        round4(discount),
        round2(revenue),
        round2(cost),
        esc(weightedPick(rng, ORDER_STATUSES)),
      ]),
    );

    if (buffer.length >= CHUNK_ROWS) {
      written += buffer.length;
      yield `${buffer.join('\n')}\n`;
      buffer.length = 0;
      ctx.onProgress(written);
    }
  }

  if (buffer.length > 0) {
    written += buffer.length;
    yield `${buffer.join('\n')}\n`;
    ctx.onProgress(written);
  }
}

/* -------------------------------------------------------------------------- */
/* Load orchestration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Foreign keys on fact_orders, dropped for the bulk load and restored after.
 *
 * Kept in one place so the definitions cannot drift from the migration.
 */
const FACT_FOREIGN_KEYS = [
  ['fact_orders_date_fk', 'date_key', 'dim_date', 'date_key'],
  ['fact_orders_customer_fk', 'customer_id', 'dim_customer', 'customer_id'],
  ['fact_orders_product_fk', 'product_id', 'dim_product', 'product_id'],
  ['fact_orders_store_fk', 'store_id', 'dim_store', 'store_id'],
] as const;

/**
 * Analytical indexes on the fact table, dropped for the bulk load and rebuilt
 * afterwards.
 *
 * Same reasoning as the foreign keys. Every COPY'd row would otherwise have to
 * be inserted into five B-trees one at a time, in whatever random order the
 * rows arrive; building each index once at the end sorts the whole column and
 * writes it sequentially, which is dramatically cheaper.
 *
 * The definitions are read from the database rather than written here, so the
 * seed restores exactly what the migration created and cannot drift from it.
 * The primary key is excluded - it enforces a constraint, not a query plan.
 */
interface SavedIndex {
  name: string;
  definition: string;
}

async function readFactIndexes(client: Client): Promise<SavedIndex[]> {
  const { rows } = await client.query<SavedIndex>(
    `SELECT indexname AS name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = 'analytics'
        AND tablename = 'fact_orders'
        AND indexname <> 'fact_orders_pkey'
      ORDER BY indexname`,
  );
  return rows;
}

async function dropFactIndexes(client: Client, indexes: SavedIndex[]): Promise<void> {
  for (const index of indexes) {
    await client.query(`DROP INDEX IF EXISTS analytics.${index.name}`);
  }
}

async function restoreFactIndexes(client: Client, indexes: SavedIndex[]): Promise<void> {
  for (const index of indexes) {
    await client.query(index.definition);
  }
}

async function dropFactForeignKeys(client: Client): Promise<void> {
  for (const [name] of FACT_FOREIGN_KEYS) {
    await client.query(`ALTER TABLE analytics.fact_orders DROP CONSTRAINT IF EXISTS ${name}`);
  }
}

async function restoreFactForeignKeys(client: Client): Promise<void> {
  for (const [name, factColumn, dimTable, dimColumn] of FACT_FOREIGN_KEYS) {
    await client.query(
      `ALTER TABLE analytics.fact_orders
         ADD CONSTRAINT ${name}
         FOREIGN KEY (${factColumn}) REFERENCES analytics.${dimTable} (${dimColumn})`,
    );
  }
}

function makeProgressReporter(total: number, every: number, startedAt: number) {
  let nextThreshold = every;
  return (rowsWritten: number): void => {
    if (rowsWritten < nextThreshold && rowsWritten < total) return;
    while (nextThreshold <= rowsWritten) nextThreshold += every;

    const elapsed = Date.now() - startedAt;
    const rate = Math.round(rowsWritten / (elapsed / 1000));
    const percent = ((rowsWritten / total) * 100).toFixed(1);
    console.log(
      `      ${formatCount(rowsWritten)} / ${formatCount(total)} rows ` +
        `(${percent}%)  ${formatCount(rate)} rows/s  ${formatDuration(elapsed)} elapsed`,
    );
  };
}

async function alreadySeeded(client: Client, target: number): Promise<number | null> {
  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM analytics.fact_orders',
  );
  const count = Number(rows[0]?.count ?? 0);
  return count >= target ? count : null;
}

async function seed(config: SeedConfig): Promise<void> {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();

  try {
    // Bulk loading is the one place a long-running statement is expected.
    await client.query('SET statement_timeout = 0');

    if (!config.force) {
      const existing = await alreadySeeded(client, config.factRows);
      if (existing !== null) {
        console.log(
          `fact_orders already holds ${formatCount(existing)} rows ` +
            `(target ${formatCount(config.factRows)}). Nothing to do.`,
        );
        console.log('Pass --force to rebuild the dataset from scratch.');
        return;
      }
    }

    const totalStart = Date.now();
    const rng = createRng(config.randomSeed);

    console.log('DataSphere seed');
    console.log('---------------');
    console.log(`  fact rows   : ${formatCount(config.factRows)}`);
    console.log(`  customers   : ${formatCount(config.customers)}`);
    console.log(`  products    : ${formatCount(config.products)}`);
    console.log(`  stores      : ${formatCount(config.stores)}`);
    console.log(`  date range  : ${config.dateStart} to ${config.dateEnd}`);
    console.log(`  random seed : ${config.randomSeed}`);
    console.log('');

    // ---- generate dimensions in memory ------------------------------------
    console.log('[1/6] Generating dimensions...');
    const genStart = Date.now();
    const dates = generateDateDimension(config);
    const customerRows = generateCustomerRows(rng, config);
    const products = generateProductDimension(rng, config);
    const storeRows = generateStoreRows(rng, config);
    console.log(
      `      ${formatCount(dates.rows.length)} days, ` +
        `${formatCount(customerRows.length)} customers, ` +
        `${formatCount(products.rows.length)} products, ` +
        `${formatCount(storeRows.length)} stores in ${formatDuration(Date.now() - genStart)}`,
    );

    // ---- truncate ---------------------------------------------------------
    console.log('[2/6] Truncating existing data...');
    await client.query(`
      TRUNCATE analytics.fact_orders,
               analytics.dim_date,
               analytics.dim_customer,
               analytics.dim_product,
               analytics.dim_store
      RESTART IDENTITY CASCADE
    `);

    // ---- load dimensions --------------------------------------------------
    console.log('[3/6] Loading dimensions...');
    const dimStart = Date.now();
    const joinChunks = (rows: string[]): string[] => {
      const chunks: string[] = [];
      for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
        chunks.push(`${rows.slice(i, i + CHUNK_ROWS).join('\n')}\n`);
      }
      return chunks;
    };

    await copyInto(
      client,
      `COPY analytics.dim_date (date_key, full_date, day_of_month, day_of_week, day_name,
        week_of_year, month_num, month_name, quarter_num, year_num, is_weekend) FROM STDIN`,
      joinChunks(dates.rows),
    );
    await copyInto(
      client,
      `COPY analytics.dim_customer (customer_id, customer_name, email, segment,
        country, region, city, signup_date) FROM STDIN`,
      joinChunks(customerRows),
    );
    await copyInto(
      client,
      `COPY analytics.dim_product (product_id, product_name, sku, category,
        subcategory, brand, unit_cost, list_price) FROM STDIN`,
      joinChunks(products.rows),
    );
    await copyInto(
      client,
      `COPY analytics.dim_store (store_id, store_name, channel, country,
        region, city, opened_on) FROM STDIN`,
      joinChunks(storeRows),
    );

    // ANALYZE before loading facts: re-adding the foreign keys afterwards
    // plans a join against these tables, and it should know how big they are.
    await client.query('ANALYZE analytics.dim_date, analytics.dim_customer');
    await client.query('ANALYZE analytics.dim_product, analytics.dim_store');
    console.log(`      done in ${formatDuration(Date.now() - dimStart)}`);

    // ---- load facts -------------------------------------------------------
    console.log('[4/6] Loading fact_orders (constraints and indexes dropped for the load)...');
    await dropFactForeignKeys(client);

    // Read them before dropping, so whatever the migration created is exactly
    // what comes back.
    const factIndexes = await readFactIndexes(client);
    if (factIndexes.length > 0) {
      console.log(`      dropping ${factIndexes.length} analytical index(es) for the load`);
      await dropFactIndexes(client, factIndexes);
    }

    const factStart = Date.now();

    // Popularity rank -> id. Shuffling breaks the correlation between id order
    // (which follows the category listing) and popularity, so one category
    // does not accidentally absorb all the volume.
    const shuffledCustomers = shuffle(
      rng,
      Array.from({ length: config.customers }, (_, i) => i + 1),
    );
    const shuffledProducts = shuffle(
      rng,
      Array.from({ length: config.products }, (_, i) => i + 1),
    );
    const shuffledStores = shuffle(
      rng,
      Array.from({ length: config.stores }, (_, i) => i + 1),
    );

    await copyInto(
      client,
      `COPY analytics.fact_orders (order_id, ordered_at, date_key, customer_id, product_id,
        store_id, quantity, unit_price, discount_pct, revenue, cost, order_status) FROM STDIN`,
      generateFactChunks({
        config,
        rng,
        dates,
        products,
        customersByPopularity: Int32Array.from(shuffledCustomers),
        productsByPopularity: Int32Array.from(shuffledProducts),
        storesByPopularity: Int32Array.from(shuffledStores),
        onProgress: makeProgressReporter(config.factRows, config.progressEvery, factStart),
      }),
    );

    const factMs = Date.now() - factStart;
    console.log(
      `      ${formatCount(config.factRows)} rows in ${formatDuration(factMs)} ` +
        `(${formatCount(Math.round(config.factRows / (factMs / 1000)))} rows/s)`,
    );

    // ---- restore constraints ----------------------------------------------
    console.log('[5/6] Rebuilding indexes, restoring foreign keys, resetting the sequence...');
    const fkStart = Date.now();

    // ANALYZE *before* re-adding the foreign keys, not after. Re-adding a FK
    // validates the existing rows with a join against the referenced table,
    // and the planner picks that join strategy from pg_class statistics. A
    // freshly TRUNCATE'd and COPY'd table still reports zero rows, so the
    // planner assumes the fact table is tiny and picks a nested loop -
    // eight million index probes. With real statistics it hash joins instead.
    // Measured on the 2M-row dataset: 1m58s before this line existed, 2.5s
    // after.
    await client.query('ANALYZE analytics.fact_orders');

    await restoreFactForeignKeys(client);

    // Built once over the finished table rather than maintained row by row.
    if (factIndexes.length > 0) {
      const indexStart = Date.now();
      await restoreFactIndexes(client, factIndexes);
      console.log(
        `      rebuilt ${factIndexes.length} index(es) in ${formatDuration(Date.now() - indexStart)}`,
      );
    }
    // order_id values were supplied explicitly, so the identity sequence is
    // still at 1. Without this, the first API-side insert collides.
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence('analytics.fact_orders', 'order_id'),
         GREATEST((SELECT max(order_id) FROM analytics.fact_orders), 1)
       )`,
    );
    console.log(`      done in ${formatDuration(Date.now() - fkStart)}`);

    // ---- statistics -------------------------------------------------------
    // VACUUM, not just ANALYZE: it populates the visibility map, without which
    // PostgreSQL cannot use index-only scans - and several of the dashboard
    // queries in the benchmark suite depend on exactly that.
    console.log('[6/6] VACUUM ANALYZE (builds the visibility map for index-only scans)...');
    const vacuumStart = Date.now();
    await client.query('VACUUM (ANALYZE) analytics.fact_orders');
    console.log(`      done in ${formatDuration(Date.now() - vacuumStart)}`);

    await report(client, totalStart);
  } finally {
    await client.end();
  }
}

async function report(client: Client, startedAt: number): Promise<void> {
  // Exact counts rather than pg_class.reltuples: this runs once at the end of
  // a seed and the whole point of the summary is to prove the row target was
  // actually met, which a planner estimate cannot do.
  const { rows } = await client.query<{
    table_name: string;
    row_count: string;
    total_size: string;
  }>(`
    SELECT c.relname AS table_name,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
           (xpath(
              '/row/cnt/text()',
              query_to_xml(
                format('SELECT count(*) AS cnt FROM %I.%I', n.nspname, c.relname),
                false, true, ''
              )
            ))[1]::text AS row_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC
  `);

  console.log('');
  console.log('Seed complete.');
  console.log('');
  console.log('  table            rows          on disk');
  console.log('  ---------------  ------------  ---------');
  for (const row of rows) {
    console.log(
      `  ${row.table_name.padEnd(15)}  ${formatCount(Number(row.row_count)).padEnd(12)}  ${row.total_size}`,
    );
  }
  console.log('');
  console.log(`Total elapsed: ${formatDuration(Date.now() - startedAt)}`);
}

/* -------------------------------------------------------------------------- */

seed(loadConfig(process.argv.slice(2))).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('\nSeed failed:');
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
