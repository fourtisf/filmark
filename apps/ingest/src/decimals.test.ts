import { USDC_MINT, WSOL_MINT } from '@exitliquidity/core';
import type { MintRepository } from '@exitliquidity/clickhouse';
import type { SolanaRpcClient } from '@exitliquidity/solana';
import { describe, expect, it, vi } from 'vitest';
import { MintDecimalsResolver } from './decimals.js';

function fakeRepository(stored: Record<string, number> = {}): MintRepository & {
  upserts: { mint: string; decimals: number }[];
  reads: number;
} {
  const upserts: { mint: string; decimals: number }[] = [];
  let reads = 0;

  return {
    upserts,
    get reads() {
      return reads;
    },
    async getMany(mints) {
      reads += 1;
      return new Map(
        mints.filter((mint) => mint in stored).map((mint) => [mint, stored[mint] as number]),
      );
    },
    async upsertMany(mints) {
      upserts.push(...mints.map((m) => ({ mint: m.mint, decimals: m.decimals })));
    },
  } as unknown as MintRepository & { upserts: { mint: string; decimals: number }[]; reads: number };
}

function fakeRpc(known: Record<string, number>): SolanaRpcClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async getMintDecimals(mints: readonly string[]) {
      calls.push([...mints]);
      return mints.map((mint) => known[mint] ?? null);
    },
  } as unknown as SolanaRpcClient & { calls: string[][] };
}

describe('MintDecimalsResolver', () => {
  it('answers known quote assets without any lookup', async () => {
    const repository = fakeRepository();
    const resolver = new MintDecimalsResolver({ repository });

    expect(await resolver.resolve(WSOL_MINT)).toBe(9);
    expect(await resolver.resolve(USDC_MINT)).toBe(6);
    expect(repository.reads).toBe(0);
  });

  it('serves what the transaction already told us', async () => {
    const rpc = fakeRpc({});
    const resolver = new MintDecimalsResolver({ rpc });

    resolver.remember('mintA', 8);
    expect(await resolver.resolve('mintA')).toBe(8);
    expect(rpc.calls).toEqual([]);
  });

  it('falls back from cache to store to RPC, in that order', async () => {
    const repository = fakeRepository({ stored: 4 });
    const rpc = fakeRpc({ remote: 7 });
    const resolver = new MintDecimalsResolver({ repository, rpc });

    expect(await resolver.resolve('stored')).toBe(4);
    expect(rpc.calls).toEqual([]);

    expect(await resolver.resolve('remote')).toBe(7);
    expect(rpc.calls).toEqual([['remote']]);
  });

  it('writes an RPC result back to the store so the next run is free', async () => {
    const repository = fakeRepository();
    const resolver = new MintDecimalsResolver({ repository, rpc: fakeRpc({ remote: 7 }) });

    await resolver.resolve('remote');
    expect(repository.upserts).toEqual([{ mint: 'remote', decimals: 7 }]);
  });

  it('caches a hit so a repeat costs nothing', async () => {
    const rpc = fakeRpc({ remote: 7 });
    const resolver = new MintDecimalsResolver({ rpc });

    await resolver.resolve('remote');
    await resolver.resolve('remote');
    expect(rpc.calls).toHaveLength(1);
  });

  it('remembers a miss, so a backfill does not re-ask for every swap', async () => {
    const rpc = fakeRpc({});
    const resolver = new MintDecimalsResolver({ rpc });

    expect(await resolver.resolve('unknown')).toBeNull();
    expect(await resolver.resolve('unknown')).toBeNull();
    expect(rpc.calls).toHaveLength(1);
  });

  it('resolves a batch in one round trip', async () => {
    const rpc = fakeRpc({ a: 1, b: 2 });
    const resolver = new MintDecimalsResolver({ rpc });
    resolver.remember('cached', 3);

    const result = await resolver.resolveMany(['a', 'b', 'cached', WSOL_MINT, 'a']);

    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
    expect(result.get('cached')).toBe(3);
    expect(result.get(WSOL_MINT)).toBe(9);
    expect(rpc.calls).toEqual([['a', 'b']]);
  });

  it('returns null rather than guessing when there is nowhere left to look', async () => {
    expect(await new MintDecimalsResolver().resolve('mystery')).toBeNull();
  });

  it('evicts the oldest entry once the cache is full', async () => {
    const rpc = fakeRpc({ a: 1, b: 2, c: 3 });
    const resolver = new MintDecimalsResolver({ rpc, cacheSize: 2 });

    await resolver.resolve('a');
    await resolver.resolve('b');
    await resolver.resolve('c');

    // 'a' was evicted, so asking again costs another call.
    await resolver.resolve('a');
    expect(rpc.calls).toEqual([['a'], ['b'], ['c'], ['a']]);
  });

  it('clears a recorded miss when the value later arrives from a transaction', async () => {
    const rpc = fakeRpc({});
    const resolver = new MintDecimalsResolver({ rpc });

    expect(await resolver.resolve('late')).toBeNull();
    resolver.remember('late', 6);
    expect(await resolver.resolve('late')).toBe(6);
  });

  it('passes the abort signal through to RPC', async () => {
    const getMintDecimals = vi.fn(async () => [5]);
    const resolver = new MintDecimalsResolver({
      rpc: { getMintDecimals } as unknown as SolanaRpcClient,
    });
    const controller = new AbortController();

    await resolver.resolve('x', controller.signal);
    expect(getMintDecimals).toHaveBeenCalledWith(['x'], controller.signal);
  });
});
