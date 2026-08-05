import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import bs58 from 'bs58';
import {
  AbortedError,
  ConfigError,
  UpstreamError,
  describeError,
  silentLogger,
  type Logger,
} from '@exitliquidity/core';
import { BusyError, type ResultCache, type Semaphore } from './cache.js';
import type { ApiMetrics } from './metrics.js';
import type { TraceReport } from './report.js';
import type { TraceService } from './trace.js';

export interface HttpServerOptions {
  readonly traces: TraceService;
  readonly cache: ResultCache<TraceReport>;
  readonly semaphore: Semaphore;
  readonly metrics: ApiMetrics;
  /** Allowed browser origins. `['*']` allows any. Empty sends no CORS header. */
  readonly corsOrigins: readonly string[];
  readonly traceTimeoutMs: number;
  readonly logger?: Logger;
  readonly isReady?: () => boolean;
}

/**
 * A Solana address, checked properly.
 *
 * The length-and-alphabet regex the console uses is a first filter, not a
 * validator: plenty of 44-character base58 strings decode to the wrong number
 * of bytes. Checking here means an address that cannot exist is refused in
 * microseconds instead of after a fruitless crawl.
 */
export function parseAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return null;
  try {
    return bs58.decode(trimmed).length === 32 ? trimmed : null;
  } catch {
    return null;
  }
}

export function createHttpServer(options: HttpServerOptions): Server {
  const logger = options.logger ?? silentLogger;

  const server = createServer((request, response) => {
    // A throw inside a request listener is not caught by server.on('error') —
    // it reaches the top as an uncaught exception and ends the process.
    handle(request, response).catch((error: unknown) => {
      logger.error({ url: request.url, err: describeError(error) }, 'request failed');
      send(response, 500, { error: 'internal', message: 'the trace could not be completed' });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    applyCors(response, request.headers.origin, options.corsOrigins);

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      count(options, path, 405);
      send(response, 405, { error: 'method_not_allowed' });
      return;
    }

    switch (path) {
      case '/healthz':
        count(options, path, 200);
        send(response, 200, { status: 'ok' });
        return;

      case '/readyz': {
        const ready = options.isReady?.() ?? true;
        count(options, path, ready ? 200 : 503);
        send(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
        return;
      }

      case '/metrics':
        options.metrics.cacheEntries.set(options.cache.size);
        options.metrics.inFlight.set(options.semaphore.active);
        count(options, path, 200);
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(options.metrics.registry.render());
        return;

      default:
        break;
    }

    const trace = /^\/v1\/trace\/([^/]+)$/.exec(path);
    if (trace !== null) {
      await handleTrace(decodeURIComponent(trace[1] as string), response);
      return;
    }

    count(options, path, 404);
    send(response, 404, { error: 'not_found' });
  }

  async function handleTrace(raw: string, response: ServerResponse): Promise<void> {
    const wallet = parseAddress(raw);
    if (wallet === null) {
      count(options, '/v1/trace', 400);
      send(response, 400, {
        error: 'bad_address',
        message: 'that is not a Solana address',
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.traceTimeoutMs);

    try {
      const { value, cached } = await options.cache.resolve(wallet, () =>
        options.semaphore.run(() => options.traces.trace(wallet, controller.signal)),
      );

      options.metrics.traces.inc({ outcome: cached ? 'cached' : value.status });
      if (!cached) {
        options.metrics.traceSeconds.set(value.elapsedMs / 1000);
        options.metrics.rpcSignatures.inc({}, value.coverage.signaturesRead);
        options.metrics.rpcTransactions.inc({}, value.coverage.transactionsFetched);
      }

      count(options, '/v1/trace', 200);
      // A trace is expensive to produce and stable once produced; letting a
      // browser or CDN hold it for the cache's own TTL costs nothing.
      send(response, 200, value, { 'cache-control': 'public, max-age=60' });
    } catch (error) {
      const { status, body, retryAfter } = classify(error);
      options.metrics.traces.inc({ outcome: body.error });
      count(options, '/v1/trace', status);
      logger.warn({ wallet, status, err: describeError(error) }, 'trace failed');
      send(response, status, body, retryAfter === null ? {} : { 'retry-after': retryAfter });
    } finally {
      clearTimeout(timer);
    }
  }

  server.on('error', (error) => {
    logger.error({ err: describeError(error) }, 'http server error');
  });

  return server;
}

interface Classified {
  readonly status: number;
  readonly body: { error: string; message: string };
  readonly retryAfter: string | null;
}

/**
 * Turns a failure into something a browser can act on.
 *
 * The messages are user-facing and say what happened without naming the
 * provider or the endpoint: an RPC URL carries the API key in its query string,
 * and an error body is the classic place for one to escape.
 */
function classify(error: unknown): Classified {
  if (error instanceof BusyError) {
    return {
      status: 503,
      body: { error: 'busy', message: 'too many traces running; try again in a moment' },
      retryAfter: '10',
    };
  }
  if (error instanceof AbortedError || (error instanceof Error && error.name === 'AbortError')) {
    return {
      status: 504,
      body: { error: 'timeout', message: 'this wallet took longer to read than the trace allows' },
      retryAfter: null,
    };
  }
  if (error instanceof ConfigError) {
    return {
      status: 503,
      body: { error: 'not_configured', message: 'the trace engine is not configured' },
      retryAfter: null,
    };
  }
  if (error instanceof UpstreamError) {
    return {
      status: 502,
      body: { error: 'upstream', message: 'the Solana RPC endpoint did not answer' },
      retryAfter: '15',
    };
  }
  return {
    status: 500,
    body: { error: 'internal', message: 'the trace could not be completed' },
    retryAfter: null,
  };
}

/**
 * CORS, allowlisted rather than open.
 *
 * The service holds an RPC key and spends it per request, so `*` is a decision
 * to let any page on the internet spend it. It stays available for a deployment
 * that fronts this with its own rate limiting, but it is never the default.
 */
function applyCors(
  response: ServerResponse,
  origin: string | undefined,
  allowed: readonly string[],
): void {
  if (allowed.length === 0) return;

  if (allowed.includes('*')) {
    response.setHeader('access-control-allow-origin', '*');
  } else if (origin !== undefined && allowed.includes(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    // Without this a shared cache can hand one origin's response to another.
    response.setHeader('vary', 'Origin');
  } else {
    return;
  }

  response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  response.setHeader('access-control-max-age', '86400');
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function count(options: HttpServerOptions, route: string, status: number): void {
  options.metrics.requests.inc({ route, status: String(status) });
}
