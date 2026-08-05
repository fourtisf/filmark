import { describe, expect, it } from 'vitest';
import { WSOL_MINT, type NormalisedSwap, type Side } from '@exitliquidity/core';
import type { TokenMetadataResolver } from './metadata.js';
import { mergeIntervals, type ChainScanner, type PoolScan, type WalletScan } from './scan.js';
import { TraceService } from './trace.js';

const VICTIM = 'V1ct1mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT = 'M1ntAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL = 'Poo1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BASE_TS = 1_700_000_000;

let seq = 0;

interface SwapSpec {
  readonly wallet: string;
  readonly side: Side;
  /** Whole tokens at 6 decimals. */
  readonly base: number;
  readonly usd: number;
  /** Seconds after the base timestamp; slots run at 2.5 per second. */
  readonly offsetSec: number;
  readonly mint?: string;
  readonly poolId?: string;
}

function makeSwap(spec: SwapSpec): NormalisedSwap {
  seq += 1;
  return {
    signature: `sig${seq}`,
    slot: BigInt(100_000 + Math.round(spec.offsetSec * 2.5)),
    blockTime: BASE_TS + spec.offsetSec,
    venue: 'pumpswap',
    poolId: spec.poolId ?? POOL,
    mint: spec.mint ?? MINT,
    wallet: spec.wallet,
    side: spec.side,
    baseAmount: BigInt(Math.round(spec.base * 1e6)),
    baseDecimals: 6,
    quoteAmount: 1_000_000_000n,
    quoteFeeAmount: 0n,
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    usdValue: spec.usd,
    usdPriceSource: 'pyth_1m',
    ixIndex: 0,
    innerIxIndex: -1,
    ingestSource: 'backfill',
  };
}

function scannerFor(
  wallet: readonly NormalisedSwap[],
  pool: readonly NormalisedSwap[],
): ChainScanner {
  const stub = {
    scanWallet: async (address: string): Promise<WalletScan> => ({
      wallet: address,
      swaps: wallet,
      oldestTs: BASE_TS,
      newestTs: BASE_TS + 3600,
      truncated: false,
      cost: { signaturesRead: wallet.length, transactionsFetched: wallet.length },
    }),
    scanPool: async (poolId: string): Promise<PoolScan> => ({
      poolId,
      swaps: pool.filter((swap) => swap.poolId === poolId),
      incomplete: false,
      cost: { signaturesRead: pool.length, transactionsFetched: pool.length },
    }),
  };
  return stub as unknown as ChainScanner;
}

const NO_METADATA = {
  supported: false,
  resolve: async () => new Map(),
} as unknown as TokenMetadataResolver;

function service(wallet: readonly NormalisedSwap[], pool: readonly NormalisedSwap[]): TraceService {
  return new TraceService({
    scanner: scannerFor(wallet, pool),
    metadata: NO_METADATA,
    limits: { lookbackDays: 90, maxPositions: 12, maxLegsPerPosition: 6 },
  });
}

describe('TraceService', () => {
  it('names the wallets that were selling into a losing buy', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 1000, usd: 1000, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 1000, usd: 250, offsetSec: 600 });

    // Two wallets reducing supply into the buy window, one twice the size.
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'big', side: 'sell', base: 600, usd: 600, offsetSec: 2 }),
      makeSwap({ wallet: 'small', side: 'sell', base: 300, usd: 300, offsetSec: 3 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);

    expect(report.status).toBe('ok');
    expect(report.totals.positionsClosed).toBe(1);
    expect(report.totals.realisedLossUsd).toBeCloseTo(750, 4);
    expect(report.counterparties.map((c) => c.wallet)).toEqual(['big', 'small']);

    // The whole loss is attributed, and split roughly by size.
    expect(report.totals.attributedUsd).toBeCloseTo(750, 4);
    expect(report.totals.unattributedUsd).toBeCloseTo(0, 6);
    expect(report.counterparties[0]!.attributedUsd).toBeGreaterThan(
      report.counterparties[1]!.attributedUsd,
    );
  });

  it('carries a checkable window on every counterparty', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    const window = report.counterparties[0]!.windows[0]!;

    expect(window.poolId).toBe(POOL);
    expect(window.mint).toBe(MINT);
    expect(window.venue).toBe('pumpswap');
    expect(window.ts).toBe(BASE_TS);
    expect(Number(window.startSlot)).toBeLessThanOrEqual(Number(window.endSlot));
    expect(window.buyLegSignature).toBe(buy.signature);
    expect(window.share).toBeGreaterThan(0);
  });

  it('reports no_swaps for a wallet with nothing on a parsed venue', async () => {
    const report = await service([], []).trace(VICTIM);
    expect(report.status).toBe('no_swaps');
    expect(report.counterparties).toHaveLength(0);
    expect(report.totals.attributedUsd).toBe(0);
  });

  it('reports no_losses when every closed position made money', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 100, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 400, offsetSec: 60 });

    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);
    expect(report.status).toBe('no_losses');
    expect(report.totals.positionsClosed).toBe(1);
  });

  it('reports the loss as unattributed when the window is empty', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });

    // Nobody else in the pool. Nothing may be attributed, and the $400 has to
    // still be visible rather than silently dropped.
    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);

    expect(report.status).toBe('no_attribution');
    expect(report.totals.attributedUsd).toBe(0);
    expect(report.totals.unattributedUsd).toBeCloseTo(400, 4);
    expect(report.notes.join(' ')).toContain('Nothing is attributed');
  });

  it('excludes a position whose tokens arrived off-swap', async () => {
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const report = await service([sell], [sell]).trace(VICTIM);

    expect(report.status).toBe('no_losses');
    expect(report.coverage.excluded['unknown_basis']).toBe(1);
  });

  it('always says that attribution measures overlap, not payment', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    expect(report.notes.join(' ')).toContain('overlap, not payment');
  });

  it('rolls losses up per token for the flow diagram', async () => {
    const other = 'M1ntBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const otherPool = 'Poo1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    const buyA = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 900, offsetSec: 0 });
    const sellA = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const buyB = makeSwap({
      wallet: VICTIM,
      side: 'buy',
      base: 100,
      usd: 300,
      offsetSec: 1000,
      mint: other,
      poolId: otherPool,
    });
    const sellB = makeSwap({
      wallet: VICTIM,
      side: 'sell',
      base: 100,
      usd: 100,
      offsetSec: 1300,
      mint: other,
      poolId: otherPool,
    });

    const pool = [
      buyA,
      sellA,
      buyB,
      sellB,
      makeSwap({ wallet: 'x', side: 'sell', base: 900, usd: 900, offsetSec: 1 }),
      makeSwap({
        wallet: 'x',
        side: 'sell',
        base: 300,
        usd: 300,
        offsetSec: 1001,
        mint: other,
        poolId: otherPool,
      }),
    ];

    const report = await service([buyA, sellA, buyB, sellB], pool).trace(VICTIM);

    expect(report.tokens.map((t) => t.mint)).toEqual([MINT, other]);
    expect(report.tokens[0]!.lossUsd).toBeCloseTo(800, 4);
    expect(report.tokens[1]!.lossUsd).toBeCloseTo(200, 4);
    expect(report.tokens[0]!.symbol).toBeNull();
  });

  it('discloses that a bonding-curve fee is missing from the basis', async () => {
    const buy = {
      ...makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 }),
      quoteFeeAmount: null,
    };
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    expect(report.coverage.legsWithUnknownFees).toBe(1);
    expect(report.notes.join(' ')).toContain('does not report its fee');
  });
});

describe('mergeIntervals', () => {
  it('collapses overlapping ranges', () => {
    expect(
      mergeIntervals([
        { fromTs: 100, toTs: 200 },
        { fromTs: 150, toTs: 250 },
        { fromTs: 400, toTs: 500 },
      ]),
    ).toEqual([
      { fromTs: 100, toTs: 250 },
      { fromTs: 400, toTs: 500 },
    ]);
  });

  it('keeps a range fully inside another from shrinking it', () => {
    expect(
      mergeIntervals([
        { fromTs: 100, toTs: 900 },
        { fromTs: 200, toTs: 300 },
      ]),
    ).toEqual([{ fromTs: 100, toTs: 900 }]);
  });

  it('handles an empty list', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});
