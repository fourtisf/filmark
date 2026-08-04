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
