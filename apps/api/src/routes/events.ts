/**
 * Server-Sent Events: how a dashboard learns its data changed.
 *
 * Polling every widget on a timer means every widget pays for staleness it
 * cannot detect - poll too often and you hammer the API for unchanged data,
 * poll too rarely and the numbers are wrong. SSE inverts that: the server
 * already knows the moment a dataset is invalidated, so it says so, and the
 * client refetches exactly then.
 *
 * SSE rather than WebSockets because the traffic is strictly one-way. There is
 * nothing for the browser to send back, and SSE is plain HTTP - it reconnects
 * on its own, needs no protocol upgrade, and passes through the nginx in front
 * of this service without special handling beyond disabling buffering, which
 * apps/web/nginx.conf already does for /api.
 *
 * The events arrive here from Redis pub/sub, so a browser connected to one API
 * instance is notified about an invalidation triggered on any other.
 */

import { Router } from 'express';
import { invalidationEvents, type InvalidationEvent } from '../cache/generations.js';
import { logger } from '../logger.js';

export const eventsRouter: Router = Router();

/**
 * Comment frames keep the connection warm.
 *
 * An idle SSE stream looks like a hung request to an intermediary, and nginx's
 * default proxy_read_timeout would drop it after 60 seconds. A comment every
 * 20 seconds is invisible to EventSource and keeps the socket demonstrably
 * alive.
 */
const HEARTBEAT_MS = 20_000;

eventsRouter.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Belt and braces alongside the nginx config: any proxy honouring this
    // will stop buffering, which is what makes "live" actually live.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Tell the client the stream is open, and hand it the retry interval to use
  // if the connection drops.
  res.write('retry: 3000\n\n');
  send('connected', { at: new Date().toISOString() });

  const onInvalidate = (event: InvalidationEvent): void => {
    send('invalidate', event);
  };
  invalidationEvents.on('invalidate', onInvalidate);

  const heartbeat = setInterval(() => {
    // A line beginning with ':' is a comment. EventSource ignores it; every
    // hop in between sees traffic.
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  let closed = false;
  const cleanup = (): void => {
    // 'close' can fire more than once, and leaking a listener per connection
    // would eventually trip Node's max-listeners warning and then leak memory.
    if (closed) return;
    closed = true;

    clearInterval(heartbeat);
    invalidationEvents.off('invalidate', onInvalidate);
    logger.debug('SSE client disconnected');
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  logger.debug('SSE client connected');
});
