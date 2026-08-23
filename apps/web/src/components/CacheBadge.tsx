/**
 * Cache status badge.
 *
 * This is the caching layer made visible. Every query response reports whether
 * it came from Redis and, on a hit, how long the original database execution
 * took - so the badge shows a measured saving rather than a claim.
 *
 * Status is never colour-alone: each state carries its own word.
 */

import type { QueryResultMeta } from '@datasphere/core';
import { formatMs } from '../lib/format.js';

/**
 * Deliberately avoids the word "live": the top bar already uses it for the SSE
 * connection state, and two meanings of one word in the same view is a way to
 * be misread.
 */
const LABELS: Record<QueryResultMeta['cache'], string> = {
  hit: 'cached',
  miss: 'queried',
  bypass: 'refreshed',
  disabled: 'uncached',
};

const TITLES: Record<QueryResultMeta['cache'], string> = {
  hit: 'Served from Redis. Postgres was not queried.',
  miss: 'Not cached, so this ran against Postgres and the result was stored.',
  bypass: 'Cache deliberately skipped for this request; the entry was refreshed.',
  disabled: 'Caching is off, or Redis is unreachable. Every request hits Postgres.',
};

export function CacheBadge({ meta }: { meta: QueryResultMeta }) {
  const { cache, executionMs, savedMs, cacheTtlRemaining } = meta;

  // Kept terse: this badge sits in a widget header beside the title, and on a
  // three-column card every extra word is taken straight out of the title.
  // The word "saved" and the TTL live in the tooltip instead.
  const detail = cache === 'hit' ? formatMs(savedMs ?? 0) : formatMs(executionMs);

  const explanation =
    cache === 'hit'
      ? `${TITLES[cache]} It saved ${formatMs(savedMs ?? 0)}.`
      : `${TITLES[cache]} Took ${formatMs(executionMs)}.`;

  const title =
    cache === 'hit' && cacheTtlRemaining !== undefined
      ? `${explanation} Expires in ${cacheTtlRemaining}s.`
      : explanation;

  return (
    <span className={`cache-badge cache-badge--${cache}`} title={title}>
      <span className="cache-badge__dot" aria-hidden="true" />
      {LABELS[cache]}
      <span className={cache === 'hit' ? 'cache-badge__saved' : 'muted'}>{detail}</span>
    </span>
  );
}
