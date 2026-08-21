/**
 * Deterministic pseudo-random number generation for seeding.
 *
 * Math.random() would make every seed run produce a different dataset, which
 * would in turn make every benchmark run measure a slightly different table.
 * mulberry32 is a small, fast, well-distributed 32-bit PRNG: given the same
 * seed it emits the same sequence on every machine and every Node version, so
 * "2 million rows" means the *same* 2 million rows each time and benchmark
 * numbers are comparable across runs.
 */

export type Rng = () => number;

/** mulberry32. Returns a function producing floats in [0, 1). */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], inclusive on both ends. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Float in [min, max). */
export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniformly pick one element. Throws on an empty list so bugs surface loudly. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick() called with an empty array');
  }
  return items[Math.floor(rng() * items.length)] as T;
}

/**
 * Pick from `[value, weight]` pairs. Weights need not sum to 1.
 * Linear scan, which is fine for the short option lists used here; the hot
 * per-row paths use `powerLawIndex` or a prebuilt CDF instead.
 */
export function weightedPick<T>(rng: Rng, options: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, weight] of options) total += weight;

  let roll = rng() * total;
  for (const [value, weight] of options) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return options[options.length - 1]![0];
}

/** In-place Fisher-Yates shuffle. Returns the same array for convenience. */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

/**
 * Index in [0, size) drawn from a power-law distribution.
 *
 * Real order data is never uniform: a minority of customers place most of the
 * orders and a minority of products account for most of the volume. Seeding
 * uniformly would make every filter equally selective and would flatter the
 * indexes in a way that does not survive contact with real data.
 *
 * `exponent` controls the skew. 1.0 is uniform; 1.6 gives roughly a 60/20
 * split; 2.2 is a sharper long tail suited to product popularity.
 */
export function powerLawIndex(rng: Rng, size: number, exponent: number): number {
  const index = Math.floor(size * Math.pow(rng(), exponent));
  return index >= size ? size - 1 : index;
}

/**
 * Build a cumulative distribution from raw weights, for sampling that cannot
 * be expressed as a simple curve - day-of-year seasonality, for instance.
 * Pair with `sampleCdf`.
 */
export function buildCdf(weights: readonly number[]): Float64Array {
  const cdf = new Float64Array(weights.length);
  let running = 0;
  for (let i = 0; i < weights.length; i++) {
    running += weights[i] as number;
    cdf[i] = running;
  }
  // Normalise so sampling is a plain rng() lookup.
  const total = running;
  for (let i = 0; i < cdf.length; i++) {
    cdf[i] = (cdf[i] as number) / total;
  }
  return cdf;
}

/** Binary search a normalised CDF produced by `buildCdf`. */
export function sampleCdf(rng: Rng, cdf: Float64Array): number {
  const roll = rng();
  let low = 0;
  let high = cdf.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((cdf[mid] as number) < roll) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Approximately normal deviate via the Box-Muller transform, clamped to
 * [min, max]. Used for prices and quantities, which cluster around a typical
 * value rather than spreading evenly across a range.
 */
export function gaussian(rng: Rng, mean: number, stdDev: number, min: number, max: number): number {
  // rng() can return exactly 0, and log(0) is -Infinity.
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = mean + normal * stdDev;
  return Math.min(max, Math.max(min, value));
}
