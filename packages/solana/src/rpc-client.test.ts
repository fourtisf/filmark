import { UpstreamError, describeError, silentLogger } from '@exitliquidity/core';
import { describe, expect, it } from 'vitest';
import { SolanaRpcClient } from './rpc-client.js';

/**
 * The `fetchImpl` seam exists so the retry, error-classification and
 * observability behaviour can be exercised without a network. It had no tests,
 * which is how a swallowed cause and a mis-classified error code survived long
 * enough to cost six debugging rounds against a live endpoint.
 */
function clientWith(
  handler: (call: number) => Response | Promise<Response> | never,
  options: { maxAttempts?: number } = {},
): { client: SolanaRpcClient; calls: () => number } {
  let calls = 0;
  const client = new SolanaRpcClient({
    url: 'https://rpc.invalid',
    maxRequestsPerSecond: 1000,
    maxAttempts: options.maxAttempts ?? 3,
    logger: silentLogger,
    fetchImpl: async (): Promise<Response> => {
      calls += 1;
      return handler(calls);
    },
  });
  return { client, calls: () => calls };
}

const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const rpcFault = (code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('SolanaRpcClient endpoint pool', () => {
  /** Records which host each request went to. */
  function poolClient(
    url: string,
    respond: (host: string, call: number) => Response,
    options: { maxAttempts?: number } = {},
  ): { client: SolanaRpcClient; hosts: () => string[] } {
    const hosts: string[] = [];
    let call = 0;
    const client = new SolanaRpcClient({
      url,
      maxRequestsPerSecond: 1000,
      maxAttempts: options.maxAttempts ?? 4,
      logger: silentLogger,
      fetchImpl: async (input): Promise<Response> => {
        call += 1;
        // Narrowed rather than stringified: a `Request` renders as
        // "[object Object]", which would record a nonsense host and pass.
        const target =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const host = new URL(target).host;
        hosts.push(host);
        return respond(host, call);
      },
    });
    return { client, hosts: () => hosts };
  }

  it('takes several endpoints from one comma-separated setting', () => {
    const { client } = poolClient('https://a.invalid/?k=1, https://b.invalid/?k=2', () => ok(1));
    expect(client.endpointCount).toBe(2);
    // Two hosts, and not one character of either key.
    expect(client.endpoint).toBe('https://a.invalid/, https://b.invalid/');
    expect(client.endpoint).not.toContain('k=');
  });

  it('ignores blanks and duplicates rather than pretending they are capacity', () => {
    const { client } = poolClient('https://a.invalid/, ,https://a.invalid/', () => ok(1));
    expect(client.endpointCount).toBe(1);
  });

  it('spreads work across the pool instead of queueing on one key', async () => {
    const { client, hosts } = poolClient('https://a.invalid/,https://b.invalid/', () => ok(1));

    for (let i = 0; i < 6; i += 1) await client.getSlot();

    // A limit belongs to a key, so two keys are two allowances. Both must be
    // used, or the second one is decoration.
    expect(new Set(hosts()).size).toBe(2);
  });

  it('moves off an endpoint that refuses, and keeps answering', async () => {
    /*
     * The failure this exists for. One provider's monthly credit ran out
     * mid-session and every trace died with it, because there was nowhere else
     * to ask. A refusal should cost the traffic to that key and nothing more.
     */
    const { client, hosts } = poolClient('https://dead.invalid/,https://live.invalid/', (host) =>
      host === 'dead.invalid' ? new Response('no credits', { status: 429 }) : ok(42),
    );

    for (let i = 0; i < 5; i += 1) await expect(client.getSlot()).resolves.toBe(42);

    // Every call is answered, and each one is answered by the live key exactly
    // once. The dead key is still tried occasionally — a cooldown that never
    // expired would be a pool that shrinks permanently on one bad minute — but
    // it carries a minority of the traffic and none of the answers.
    const dead = hosts().filter((host) => host === 'dead.invalid').length;
    const live = hosts().filter((host) => host === 'live.invalid').length;
    expect(live).toBe(5);
    expect(dead).toBeLessThan(live);
  });

  it('sets a rejected credential aside for longer than a busy moment', async () => {
    const { client, hosts } = poolClient(
      'https://revoked.invalid/,https://live.invalid/',
      (host) => (host === 'revoked.invalid' ? new Response('nope', { status: 401 }) : ok(7)),
    );

    await expect(client.getSlot()).resolves.toBe(7);
    for (let i = 0; i < 10; i += 1) await client.getSlot();

    expect(hosts().filter((host) => host === 'revoked.invalid')).toHaveLength(1);
  });

  it('refuses to be constructed with no endpoint at all', () => {
    expect(() => new SolanaRpcClient({ url: ' , ', logger: silentLogger })).toThrow(RangeError);
  });
});

describe('SolanaRpcClient endpoint', () => {
  it('reports where it is pointed without leaking the API key', () => {
    // Every provider puts the key in the query string. This value is logged on
    // every backfill, so anything past `?` must not survive.
    const client = new SolanaRpcClient({
      url: 'https://mainnet.helius-rpc.com/?api-key=00000000-1111-2222-3333-444444444444',
      logger: silentLogger,
    });

    expect(client.endpoint).toBe('https://mainnet.helius-rpc.com/');
    expect(client.endpoint).not.toContain('api-key');
  });
});

describe('SolanaRpcClient batch sizing', () => {
  /**
   * The failure this exists to prevent, observed against Helius: twenty
   * `getTransaction` calls in one batch against a ten-per-second allowance.
   * The limiter charged the batch its full cost, so the average rate was
   * correct and every attempt still came back `429 Too Many Requests` — the
   * burst lands in a single millisecond, and no amount of waiting afterwards
   * makes it narrower. It read as a dead API key.
   *
   * Clamping to the whole allowance was not enough. That still puts an entire
   * second's budget on the wire at one instant, and the same endpoint refused
   * every attempt at exactly that setting while answering a single call
   * instantly — the key was fine, the burst was not.
   */
  it('keeps one batch to half the per-second allowance', () => {
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond: 10,
      batchSize: 20,
      logger: silentLogger,
    });

    expect(client.transactionBatchSize).toBe(5);
  });

  it('leaves a batch that already fits alone', () => {
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond: 50,
      batchSize: 20,
      logger: silentLogger,
    });

    expect(client.transactionBatchSize).toBe(20);
  });

  it('keeps at least one call per request on a sub-1 rps limit', () => {
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond: 0.5,
      batchSize: 20,
      logger: silentLogger,
    });

    // Batching off, not a batch of zero — which would fetch nothing forever.
    expect(client.transactionBatchSize).toBe(1);
  });
});

describe('SolanaRpcClient batching', () => {
  /** Captures the request bodies so the number of round trips can be counted. */
  function batchClient(
    respond: (requests: { id: number; params: unknown[] }[]) => Response,
    batchSize = 20,
    maxRequestsPerSecond = 1000,
  ): { client: SolanaRpcClient; bodies: () => unknown[][] } {
    const bodies: unknown[][] = [];
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond,
      batchSize,
      logger: silentLogger,
      fetchImpl: async (_url, init): Promise<Response> => {
        const parsed = JSON.parse((init?.body ?? '[]') as string) as {
          id: number;
          params: unknown[];
        }[];
        bodies.push(parsed);
        return respond(parsed);
      },
    });
    return { client, bodies: () => bodies };
  }

  const batchOk = (requests: { id: number; params: unknown[] }[], shuffle = false): Response => {
    const messages = requests.map((request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        slot: 1,
        blockTime: 1,
        transaction: {
          signatures: [request.params[0]],
          message: { accountKeys: [], instructions: [] },
        },
        meta: { err: null },
      },
    }));
    return new Response(JSON.stringify(shuffle ? [...messages].reverse() : messages), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  it('sends one request for a whole group', async () => {
    // The reason this exists: 200 transactions was 200 round trips against an
    // endpoint that rate-limits per RPC call.
    const { client, bodies } = batchClient((r) => batchOk(r), 20);
    const signatures = Array.from({ length: 40 }, (_, i) => `sig${i}`);

    const results = await client.getTransactions(signatures);

    expect(results).toHaveLength(40);
    expect(bodies()).toHaveLength(2); // 40 signatures, 20 per request
    expect(bodies()[0]).toHaveLength(20);
  });

  it('returns results in the order asked, not the order answered', async () => {
    // JSON-RPC does not promise ordering, and the runner pairs responses to
    // signatures positionally. Getting this wrong would attribute every swap in
    // a batch to the wrong transaction.
    const { client } = batchClient((r) => batchOk(r, true), 5);

    const results = await client.getTransactions(['a', 'b', 'c']);

    expect(results.map((r) => r?.transaction.signatures[0])).toEqual(['a', 'b', 'c']);
  });

  it('retries the group when one entry comes back with a server-side error', async () => {
    let call = 0;
    const { client } = batchClient((requests) => {
      call += 1;
      if (call === 1) {
        const first = requests[0] as { id: number };
        return new Response(
          JSON.stringify([{ jsonrpc: '2.0', id: first.id, error: { code: -32603, message: 'x' } }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return batchOk(requests);
    }, 5);

    await expect(client.getTransactions(['a'])).resolves.toHaveLength(1);
    expect(call).toBe(2);
  });

  it('slows itself when the endpoint says the configured rate is too high', async () => {
    /*
     * The live failure. Overlapping the batches made the client finally reach
     * the rate it was configured for, and the plan turned out to be below it —
     * so a setting that had never been exercised became a 503 on every trace.
     * Retrying at the refused pace just spends five attempts confirming it.
     */
    let call = 0;
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond: 200,
      batchSize: 2,
      maxAttempts: 4,
      logger: silentLogger,
      fetchImpl: async (_url, init): Promise<Response> => {
        call += 1;
        if (call <= 2) return new Response('slow down', { status: 429 });
        return batchOk(JSON.parse((init?.body ?? '[]') as string) as { id: number }[]);
      },
    });

    const started = Date.now();
    await expect(client.getTransactions(['a', 'b'])).resolves.toHaveLength(2);

    // Two rejections quadruple the interval, so the third attempt cannot have
    // been scheduled at the original pace.
    expect(Date.now() - started).toBeGreaterThan(20);
    expect(call).toBe(3);
  });

  it('advertises a window wide enough for its own overlap', async () => {
    // A caller that chunks to the batch width hands over one batch per call,
    // and the concurrency inside has nothing to run alongside. The window is
    // the width that keeps it busy, and it is the client's to know.
    const { client } = batchClient((r) => batchOk(r), 10);
    expect(client.transactionBatchSize).toBe(10);
    expect(client.transactionWindowSize).toBeGreaterThan(client.transactionBatchSize);
    expect(client.transactionWindowSize % client.transactionBatchSize).toBe(0);
  });

  it('goes serial once the endpoint starts refusing, not just slower', async () => {
    /*
     * Providers meter more than one thing. A plan that caps open connections
     * refuses a fourth however patiently the client spaced the first three, and
     * backing the rate off does nothing about it — a live endpoint was slowed
     * from ten calls a second to under one and refused every step down, which
     * no per-second limit does. Serial is the shape that worked before the
     * overlap existed, so a refused client returns to it.
     */
    let refuse = true;
    let peak = 0;
    let inFlight = 0;
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond: 500,
      batchSize: 2,
      maxAttempts: 6,
      logger: silentLogger,
      fetchImpl: async (_url, init): Promise<Response> => {
        if (refuse) {
          refuse = false;
          return new Response('slow down', { status: 429 });
        }
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return batchOk(JSON.parse((init?.body ?? '[]') as string) as { id: number }[]);
      },
    });

    expect(client.transactionWindowSize).toBe(6);
    await client.getTransactions(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    // One refusal narrows the window to a single batch. The call already in
    // progress keeps the runners it started with; the next one does not.
    expect(client.transactionWindowSize).toBe(2);

    peak = 0;
    await client.getTransactions(['i', 'j', 'k', 'l']);
    expect(peak).toBe(1);
  });

  it('overlaps batches instead of waiting out every round trip', async () => {
    /*
     * Run end to end, the achieved rate is whichever is slower: the configured
     * allowance, or one batch per round trip. A ten-wide batch on a
     * ten-per-second budget has a second to play with, and a call that takes
     * longer than that spends the difference idle — which is a wallet crawl
     * running at well under the rate it was configured for.
     */
    let inFlight = 0;
    let peak = 0;
    const client = new SolanaRpcClient({
      url: 'https://rpc.invalid',
      maxRequestsPerSecond: 1000,
      batchSize: 2,
      logger: silentLogger,
      fetchImpl: async (_url, init): Promise<Response> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        const parsed = JSON.parse((init?.body ?? '[]') as string) as {
          id: number;
          params: unknown[];
        }[];
        return batchOk(parsed);
      },
    });

    const signatures = Array.from({ length: 12 }, (_, i) => `sig${i}`);
    const results = await client.getTransactions(signatures);

    expect(peak).toBeGreaterThan(1); // they overlapped
    expect(peak).toBeLessThanOrEqual(3); // and stayed inside the cap
    // Overlap must not disturb the pairing: callers index by position.
    expect(results.map((r) => r?.transaction.signatures[0])).toEqual(signatures);
  });

  it('keeps the rate limiter in charge of the rate, not the concurrency', async () => {
    // Three in flight must not mean three slots at once. Six signatures in
    // batches of two, at four calls a second, is three batches charged half a
    // second each: slots at 0s, 0.5s and 1s however far they overlap.
    const { client } = batchClient((r) => batchOk(r), 2, 4);

    const started = Date.now();
    await client.getTransactions(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('falls back to one request per signature when batching is off', async () => {
    const { client, bodies } = batchClient(
      (r) =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: (r as unknown as { id: number }).id,
            result: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      1,
    );

    const results = await client.getTransactions(['a', 'b', 'c']);

    expect(results).toEqual([null, null, null]);
    expect(bodies()).toHaveLength(3);
  });
});

describe('SolanaRpcClient error reporting', () => {
  it('carries the HTTP body and Retry-After on a rate limit', async () => {
    // A bare "returned HTTP 429" tells an operator nothing about which limit was
    // hit or for how long. The provider says both, in the body and the header.
    const { client } = clientWith(
      () =>
        new Response('Too many requests for a specific RPC call', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
      { maxAttempts: 1 },
    );

    await expect(client.getSlot()).rejects.toMatchObject({
      code: 'UPSTREAM',
      context: {
        status: 429,
        retryAfter: '30',
        body: 'Too many requests for a specific RPC call',
      },
    });
  });

  it('retries a 429 rather than giving up on the first one', async () => {
    const { client, calls } = clientWith((call) =>
      call < 3 ? new Response('slow down', { status: 429 }) : ok(1234),
    );

    await expect(client.getSlot()).resolves.toBe(1234);
    expect(calls()).toBe(3);
  });

  it('treats -32603 as transient, because it is the server saying it failed', async () => {
    // JSON-RPC "Internal error" is the generic bucket providers empty overload
    // into. Classified permanent, it died on attempt zero — and
    // getSignaturesForAddress has no catch around it, so one ended a whole crawl.
    const { client, calls } = clientWith((call) =>
      call < 2 ? rpcFault(-32603, 'Internal error') : ok(99),
    );

    await expect(client.getSlot()).resolves.toBe(99);
    expect(calls()).toBe(2);
  });

  it('still refuses to retry a malformed request', async () => {
    const { client, calls } = clientWith(() => rpcFault(-32602, 'Invalid params'));

    await expect(client.getSlot()).rejects.toThrow(UpstreamError);
    expect(calls()).toBe(1);
  });

  it('keeps the transport failure reachable, in both cause and context', async () => {
    // This is the line that would have named the real problem on the first run.
    const transport = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    const { client } = clientWith(
      () => {
        throw transport;
      },
      { maxAttempts: 1 },
    );

    const error = await client.getSlot().catch((e: unknown) => e);

    expect(error).toMatchObject({
      message: 'RPC getSlot failed',
      context: { causeName: 'TypeError', causeMessage: 'fetch failed' },
    });
    expect(describeError(error)).toMatchObject({
      cause: { name: 'TypeError', message: 'fetch failed', code: 'ECONNRESET' },
    });
  });
});
