import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { UpstreamError } from '@exitliquidity/core';
import { ResultCache, Semaphore } from './cache.js';
import { createHttpServer, parseAddress } from './http.js';
import { createApiMetrics } from './metrics.js';
import type { TraceReport } from './report.js';
import type { TraceService } from './trace.js';

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function report(wallet: string): TraceReport {
  return {
    wallet,
    generatedAt: 1_700_000_000,
    status: 'ok',
    totals: {
      attributedUsd: 1000,
      unattributedUsd: 0,
      realisedLossUsd: 1000,
      realisedPnlUsd: -1000,
      positionsClosed: 1,
      positionsInTheRed: 1,
      counterparties: 1,
      largestCounterpartyUsd: 1000,
    },
    tokens: [],
    counterparties: [],
    coverage: {
      lookbackDays: 90,
      venues: ['pumpfun', 'pumpswap'],
      fromTs: null,
      toTs: null,
      signaturesRead: 10,
      transactionsFetched: 5,
      swapCensus: { 'pumpfun:buy': 2, 'pumpfun:sell': 2 },
      foreignSwaps: 0,
      parseSkips: {},
      historyTruncated: false,
      losingPositions: 1,
      positionsAttributed: 1,
      legsSkipped: 0,
      poolsIncomplete: 0,
      excluded: {},
      legsWithUnknownFees: 0,
      tokenSymbolsAvailable: false,
    },
    notes: [],
    elapsedMs: 12,
  };
}

interface Harness {
  readonly url: string;
  readonly server: Server;
  calls: number;
}

const running: Server[] = [];

async function start(
  trace: (wallet: string) => Promise<TraceReport>,
  corsOrigins: readonly string[] = [],
): Promise<Harness> {
  const harness: Harness = { url: '', server: null as unknown as Server, calls: 0 };

  const server = createHttpServer({
    traces: {
      trace: async (wallet: string) => {
        harness.calls += 1;
        return trace(wallet);
      },
    } as unknown as TraceService,
    cache: new ResultCache<TraceReport>({ ttlSec: 60, maxEntries: 10 }),
    semaphore: new Semaphore({ limit: 2 }),
    metrics: createApiMetrics(),
    corsOrigins,
    traceTimeoutMs: 5000,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push(server);

  const { port } = server.address() as AddressInfo;
  return Object.assign(harness, { url: `http://127.0.0.1:${port}`, server });
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    ),
  );
});

describe('parseAddress', () => {
  it('accepts a real 32-byte address', () => {
    expect(parseAddress(WALLET)).toBe(WALLET);
    expect(parseAddress(`  ${WALLET}  `)).toBe(WALLET);
  });

  it('rejects base58 that decodes to the wrong length', () => {
    // Alphabet and length both pass the console's regex; the byte count does
    // not. Refusing here costs microseconds instead of a fruitless crawl.
    expect(parseAddress('1111111111111111111111111111111111111111111')).toBeNull();
  });

  it('rejects anything outside the base58 alphabet', () => {
    expect(parseAddress('0OIl' + WALLET.slice(4))).toBeNull();
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('not-an-address')).toBeNull();
  });
});

describe('trace endpoint', () => {
  it('returns a report for a valid address', async () => {
    const harness = await start(async (wallet) => report(wallet));
    const response = await fetch(`${harness.url}/v1/trace/${WALLET}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as TraceReport;
    expect(body.wallet).toBe(WALLET);
    expect(body.status).toBe('ok');
  });

  it('serves the second request from cache', async () => {
    const harness = await start(async (wallet) => report(wallet));
    await fetch(`${harness.url}/v1/trace/${WALLET}`);
    await fetch(`${harness.url}/v1/trace/${WALLET}`);
    expect(harness.calls).toBe(1);
  });

  it('rejects a malformed address without doing any work', async () => {
    const harness = await start(async (wallet) => report(wallet));
    const response = await fetch(`${harness.url}/v1/trace/not-an-address`);

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'bad_address' });
    expect(harness.calls).toBe(0);
  });

  it('maps an RPC failure to 502 without leaking the endpoint', async () => {
    const harness = await start(() =>
      Promise.reject(
        new UpstreamError('RPC getTransaction returned HTTP 401', {
          context: { url: 'https://mainnet.helius-rpc.com/?api-key=secret' },
        }),
      ),
    );

    const response = await fetch(`${harness.url}/v1/trace/${WALLET}`);
    expect(response.status).toBe(502);

    const text = await response.text();
    expect(text).not.toContain('api-key');
    expect(text).not.toContain('helius');
    expect(response.headers.get('retry-after')).toBe('15');
  });

  it('answers the probes', async () => {
    const harness = await start(async (wallet) => report(wallet));
    expect((await fetch(`${harness.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${harness.url}/readyz`)).status).toBe(200);

    const metrics = await fetch(`${harness.url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('fillmark_api_requests_total');
  });

  it('404s an unknown path and 405s a write', async () => {
    const harness = await start(async (wallet) => report(wallet));
    expect((await fetch(`${harness.url}/nope`)).status).toBe(404);
    expect((await fetch(`${harness.url}/v1/trace/${WALLET}`, { method: 'POST' })).status).toBe(405);
  });

  it('sends no CORS header when no origin is allowed', async () => {
    const harness = await start(async (wallet) => report(wallet));
    const response = await fetch(`${harness.url}/v1/trace/${WALLET}`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes only an allowlisted origin', async () => {
    const harness = await start(async (wallet) => report(wallet), ['https://fillmark.xyz']);

    const allowed = await fetch(`${harness.url}/v1/trace/${WALLET}`, {
      headers: { origin: 'https://fillmark.xyz' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://fillmark.xyz');
    expect(allowed.headers.get('vary')).toBe('Origin');

    const denied = await fetch(`${harness.url}/healthz`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight', async () => {
    const harness = await start(async (wallet) => report(wallet), ['*']);
    const response = await fetch(`${harness.url}/v1/trace/${WALLET}`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
