/**
 * Live updates over Server-Sent Events.
 *
 * The server already knows the moment a dataset is invalidated, so it says so
 * and the client refetches exactly then. The alternative - every widget on a
 * timer - pays for staleness it cannot detect: poll often and you hammer the
 * API for unchanged data, poll rarely and the numbers are quietly wrong.
 *
 * `EventSource` reconnects on its own using the `retry:` interval the server
 * sends, so there is no reconnection logic here beyond reporting the state.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface InvalidationEvent {
  dataset: string;
  generation: number;
  reason: string;
  at: string;
}

export type LiveStatus = 'connecting' | 'connected' | 'disconnected';

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export interface LiveUpdates {
  status: LiveStatus;
  /** The most recent invalidation, for showing what changed and when. */
  lastEvent: InvalidationEvent | null;
}

/**
 * Subscribe to invalidations and refetch affected queries.
 *
 * Mounted once, at the app root: one stream serves every widget on the page.
 * One EventSource per widget would open a connection per card and each would
 * separately invalidate the same shared query cache.
 */
export function useLiveUpdates(): LiveUpdates {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<InvalidationEvent | null>(null);

  // The query client is stable for the app's lifetime, but referencing it
  // through a ref keeps it out of the effect's dependency list, so a re-render
  // can never tear down and rebuild the stream.
  const clientRef = useRef(queryClient);
  clientRef.current = queryClient;

  useEffect(() => {
    const source = new EventSource(`${BASE}/api/events`);

    source.addEventListener('connected', () => setStatus('connected'));

    source.addEventListener('invalidate', (event) => {
      let payload: InvalidationEvent;
      try {
        payload = JSON.parse((event as MessageEvent<string>).data) as InvalidationEvent;
      } catch {
        return;
      }
      setLastEvent(payload);

      // Mark every query result stale rather than refetching by hand. React
      // Query then refetches only what is actually mounted, so a dashboard in
      // a background tab does not stampede the API on reconnect.
      void clientRef.current.invalidateQueries({ queryKey: ['query'] });
      void clientRef.current.invalidateQueries({ queryKey: ['widget-data'] });
      void clientRef.current.invalidateQueries({ queryKey: ['cache-stats'] });
    });

    source.onopen = () => setStatus('connected');

    source.onerror = () => {
      // EventSource retries on its own; reflect the gap rather than acting.
      setStatus(source.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting');
    };

    return () => source.close();
  }, []);

  return { status, lastEvent };
}
