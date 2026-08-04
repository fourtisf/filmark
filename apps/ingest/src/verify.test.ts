import type { SwapCountBreakdown, SwapRepository } from '@exitliquidity/clickhouse';
import { describe, expect, it } from 'vitest';
import { formatVerifyReport, verifySwapCount, type DexscreenerPair } from './verify.js';

const MINT = 'So11111111111111111111111111111111111111112';

function counts(overrides: Partial<SwapCountBreakdown> = {}): SwapCountBreakdown {
  return {
    swaps: 100,
    transactions: 100,
    buys: 60,
    sells: 40,
    byVenue: { pumpfun: 100 },
    unpriced: 0,
    firstBlockTime: 1_735_689_600,
    lastBlockTime: 1_735_776_000,
    ...overrides,
  };
}

function repository(
  breakdown: SwapCountBreakdown,
  skips: { venue: string; reason: string; count: number }[] = [],
): SwapRepository {
  return {
    async countByMint() {
      return breakdown;
    },
    async skipSummary() {
      return skips;
    },
  } as unknown as SwapRepository;
}

function dexscreener(pairs: DexscreenerPair[]): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ pairs }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function pair(overrides: Partial<DexscreenerPair> = {}): DexscreenerPair {
  return {
    chainId: 'solana',
    dexId: 'pumpfun',
    pairAddress: 'pair1',
    baseToken: { address: MINT },
    quoteToken: { address: 'wsol' },
    txns: { h24: { buys: 60, sells: 40 }, h1: { buys: 5, sells: 5 } },
    volume: { h24: 12345 },
    ...overrides,
  };
}

describe('verifySwapCount', () => {
  it('passes when the counts agree', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts()),
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.dexscreener.transactions).toBe(100);
    expect(report.deltaRatio).toBe(0);
    expect(report.withinTolerance).toBe(true);
  });

  it('fails outside the 2% default tolerance', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ transactions: 90 })),
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.deltaRatio).toBeCloseTo(-0.1);
    expect(report.withinTolerance).toBe(false);
  });

  it('passes just inside the tolerance', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ transactions: 98 })),
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.withinTolerance).toBe(true);
  });

  it('compares transactions, not swap instructions', async () => {
    // A router filling one order across three calls is one Dexscreener txn.
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ swaps: 300, transactions: 100 })),
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.withinTolerance).toBe(true);
    expect(report.notes.join(' ')).toContain('300 swap instructions across 100 transactions');
  });

  it('only counts pump.fun and PumpSwap pairs', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts()),
      fetchImpl: dexscreener([
        pair(),
        pair({ dexId: 'raydium', pairAddress: 'pair2', txns: { h24: { buys: 900, sells: 900 } } }),
        pair({ chainId: 'base', pairAddress: 'pair3', txns: { h24: { buys: 5, sells: 5 } } }),
      ]),
    });

    expect(report.dexscreener.matchedPairs).toHaveLength(1);
    expect(report.dexscreener.transactions).toBe(100);
  });

  it('sums across several pump venue pairs for the same token', async () => {
    // A migrated token trades on both the bonding curve and the AMM.
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(
        counts({ transactions: 150, byVenue: { pumpfun: 100, pumpswap: 50 } }),
      ),
      fetchImpl: dexscreener([
        pair({ txns: { h24: { buys: 60, sells: 40 } } }),
        pair({ dexId: 'pumpswap', pairAddress: 'pair2', txns: { h24: { buys: 30, sells: 20 } } }),
      ]),
    });

    expect(report.dexscreener.transactions).toBe(150);
    expect(report.withinTolerance).toBe(true);
  });

  it('reports no verdict when Dexscreener knows nothing about the token', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts()),
      fetchImpl: dexscreener([]),
    });

    expect(report.deltaRatio).toBeNull();
    expect(report.withinTolerance).toBe(false);
    expect(report.notes.join(' ')).toContain('nothing to compare');
  });

  it('uses the window the caller asked for', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ transactions: 10 })),
      windowHours: 1,
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.windowHours).toBe(1);
    expect(report.dexscreener.transactions).toBe(10);
    expect(report.toSec - report.fromSec).toBe(3600);
  });

  it('flags unpriced rows without letting them affect the count comparison', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ unpriced: 12 })),
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.withinTolerance).toBe(true);
    expect(report.notes.join(' ')).toContain('12 of 100 swaps have no USD price');
  });

  it('surfaces parse skips as a lead when the counts disagree', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ transactions: 80 }), [
        { venue: 'pumpfun', reason: 'event_missing', count: 20 },
      ]),
      fetchImpl: dexscreener([pair()]),
    });

    expect(report.withinTolerance).toBe(false);
    expect(report.skips).toEqual([{ venue: 'pumpfun', reason: 'event_missing', count: 20 }]);
    expect(formatVerifyReport(report)).toContain('event_missing');
  });

  it('retries a Dexscreener failure before giving up', async () => {
    let attempts = 0;
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts()),
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return new Response('rate limited', { status: 429 });
        return new Response(JSON.stringify({ pairs: [pair()] }), { status: 200 });
      },
    });

    expect(attempts).toBe(3);
    expect(report.withinTolerance).toBe(true);
  });
});

describe('formatVerifyReport', () => {
  it('renders a PASS with both counts visible', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts({ swaps: 105 })),
      fetchImpl: dexscreener([pair()]),
    });

    const output = formatVerifyReport(report);
    expect(output).toContain('ours (transactions) 100');
    expect(output).toContain('ours (swap ixs)     105');
    expect(output).toContain('dexscreener         100');
    expect(output).toContain('result              PASS');
  });

  it('renders n/a rather than a fake delta when there is no baseline', async () => {
    const report = await verifySwapCount({
      mint: MINT,
      repository: repository(counts()),
      fetchImpl: dexscreener([]),
    });

    expect(formatVerifyReport(report)).toContain('delta               n/a');
  });
});
