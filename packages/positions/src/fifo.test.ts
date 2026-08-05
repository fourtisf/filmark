import { describe, expect, it } from 'vitest';
import { WSOL_MINT, type NormalisedSwap, type Side } from '@exitliquidity/core';
import { accountPositions, traderCashUsd } from './fifo.js';
import { isAttributable } from './types.js';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT = 'M1ntAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL = 'Poo1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let seq = 0;

interface SwapOverrides {
  readonly side: Side;
  /** Whole tokens, converted to raw units at 6 decimals. */
  readonly base: number;
  /** USD of the pool leg. Null leaves the swap unpriced. */
  readonly usd: number | null;
  readonly ts?: number;
  readonly mint?: string;
  readonly feeUsdShare?: number | null;
}

function swap(overrides: SwapOverrides): NormalisedSwap {
  seq += 1;
  const usd = overrides.usd;
  // A round SOL price keeps the fee arithmetic in the tests exact.
  const solPerUsd = 1 / 100;
  const quoteAmount = usd === null ? 1_000_000_000n : BigInt(Math.round(usd * solPerUsd * 1e9));
  const feeShare = overrides.feeUsdShare;
  return {
    signature: `sig${seq}`,
    slot: BigInt(1000 + seq),
    blockTime: overrides.ts ?? 1_700_000_000 + seq * 60,
    venue: 'pumpswap',
    poolId: POOL,
    mint: overrides.mint ?? MINT,
    wallet: WALLET,
    side: overrides.side,
    baseAmount: BigInt(Math.round(overrides.base * 1e6)),
    baseDecimals: 6,
    quoteAmount,
    quoteFeeAmount:
      feeShare === undefined || feeShare === null
        ? null
        : BigInt(Math.round(Number(quoteAmount) * feeShare)),
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    usdValue: usd,
    usdPriceSource: usd === null ? 'none' : 'pyth_1m',
    ixIndex: 0,
    innerIxIndex: -1,
    ingestSource: 'backfill',
  };
}

describe('accountPositions', () => {
  it('closes a round trip and realises the loss', () => {
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 1000, usd: 500 }),
      swap({ side: 'sell', base: 1000, usd: 200 }),
    ]);

    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(position.status).toBe('closed');
    expect(position.basisQuality).toBe('complete');
    expect(position.costBasisUsd).toBeCloseTo(500, 6);
    expect(position.proceedsUsd).toBeCloseTo(200, 6);
    expect(position.realisedPnlUsd).toBeCloseTo(-300, 6);
    expect(isAttributable(position)).toBe(true);
  });

  it('consumes lots oldest first', () => {
    // Two buys at very different prices. FIFO must spend the cheap one first,
    // which is the whole difference between this and average-cost accounting.
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 100, usd: 100 }),
      swap({ side: 'buy', base: 100, usd: 900 }),
      swap({ side: 'sell', base: 100, usd: 300 }),
    ]);

    const open = positions[0]!;
    expect(open.status).toBe('open');
    expect(open.costBasisUsd).toBeCloseTo(100, 6);
    expect(open.realisedPnlUsd).toBeCloseTo(200, 6);
  });

  it('pro-rates a lot consumed across several sells', () => {
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 900, usd: 900 }),
      swap({ side: 'sell', base: 300, usd: 100 }),
      swap({ side: 'sell', base: 300, usd: 100 }),
      swap({ side: 'sell', base: 300, usd: 100 }),
    ]);

    const position = positions[0]!;
    expect(position.status).toBe('closed');
    // Three equal bites out of one lot must return the lot's basis exactly, not
    // an accumulating remainder.
    expect(position.costBasisUsd).toBeCloseTo(900, 6);
    expect(position.realisedPnlUsd).toBeCloseTo(-600, 6);
    expect(position.legs).toHaveLength(1);
    expect(position.legs[0]!.costBasisUsd).toBeCloseTo(900, 6);
    expect(position.legs[0]!.qtyConsumed).toBe(900_000_000n);
  });

  it('treats a dust remainder as closed', () => {
    // 0.4% left behind is under the 0.5% threshold; without it the position
    // would stay open forever and never be attributable.
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 1000, usd: 500 }),
      swap({ side: 'sell', base: 996, usd: 200 }),
    ]);

    expect(positions[0]!.status).toBe('closed');
    expect(positions[0]!.remainingQty).toBe(4_000_000n);
  });

  it('keeps a position open when the remainder is above the threshold', () => {
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 1000, usd: 500 }),
      swap({ side: 'sell', base: 900, usd: 200 }),
    ]);

    expect(positions[0]!.status).toBe('open');
    expect(isAttributable(positions[0]!)).toBe(false);
  });

  it('splits a buy-sell-buy-sell sequence into two positions', () => {
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 100, usd: 100 }),
      swap({ side: 'sell', base: 100, usd: 40 }),
      swap({ side: 'buy', base: 100, usd: 100 }),
      swap({ side: 'sell', base: 100, usd: 250 }),
    ]);

    expect(positions).toHaveLength(2);
    // Sorted newest close first.
    expect(positions[0]!.realisedPnlUsd).toBeCloseTo(150, 6);
    expect(positions[1]!.realisedPnlUsd).toBeCloseTo(-60, 6);
    // Netting the two into one running total would report +90 and attribute a
    // loss that the second cycle's counterparties had nothing to do with.
  });

  it('flags a sell with no lot behind it as unknown_basis', () => {
    const positions = accountPositions(WALLET, [swap({ side: 'sell', base: 500, usd: 900 })]);

    const position = positions[0]!;
    expect(position.basisQuality).toBe('unknown_basis');
    expect(position.unbackedQty).toBe(500_000_000n);
    // The trap in §2 Stage 2: zero-cost stock reads as a $900 profit.
    expect(isAttributable(position)).toBe(false);
  });

  it('flags a position with an unpriced leg rather than pricing it at zero', () => {
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 100, usd: null }),
      swap({ side: 'sell', base: 100, usd: 50 }),
    ]);

    expect(positions[0]!.basisQuality).toBe('unpriced');
    expect(isAttributable(positions[0]!)).toBe(false);
  });

  it('keeps mints apart', () => {
    const other = 'M1ntBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 100, usd: 100 }),
      swap({ side: 'buy', base: 100, usd: 100, mint: other }),
      swap({ side: 'sell', base: 100, usd: 20, mint: other }),
      swap({ side: 'sell', base: 100, usd: 30 }),
    ]);

    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((p) => p.mint))).toEqual(new Set([MINT, other]));
  });

  it('ignores swaps belonging to another wallet', () => {
    const foreign = { ...swap({ side: 'buy', base: 100, usd: 100 }), wallet: 'someone-else' };
    expect(accountPositions(WALLET, [foreign])).toHaveLength(0);
  });

  it('sorts out-of-order swaps before applying FIFO', () => {
    const buyCheap = swap({ side: 'buy', base: 100, usd: 100, ts: 1_700_000_100 });
    const buyDear = swap({ side: 'buy', base: 100, usd: 900, ts: 1_700_000_200 });
    const sell = swap({ side: 'sell', base: 100, usd: 300, ts: 1_700_000_300 });

    const shuffled = accountPositions(WALLET, [sell, buyDear, buyCheap]);
    const ordered = accountPositions(WALLET, [buyCheap, buyDear, sell]);

    expect(shuffled[0]!.costBasisUsd).toBeCloseTo(ordered[0]!.costBasisUsd, 6);
    expect(shuffled[0]!.costBasisUsd).toBeCloseTo(100, 6);
  });

  it('records every buy leg behind a close, oldest first', () => {
    const positions = accountPositions(WALLET, [
      swap({ side: 'buy', base: 100, usd: 100 }),
      swap({ side: 'buy', base: 100, usd: 200 }),
      swap({ side: 'sell', base: 200, usd: 50 }),
    ]);

    const legs = positions[0]!.legs;
    expect(legs).toHaveLength(2);
    expect(legs[0]!.slot < legs[1]!.slot).toBe(true);
    expect(legs[0]!.costBasisUsd + legs[1]!.costBasisUsd).toBeCloseTo(300, 6);
  });
});

describe('traderCashUsd', () => {
  it('adds the fee on a buy and subtracts it on a sell', () => {
    const buy = swap({ side: 'buy', base: 100, usd: 100, feeUsdShare: 0.01 });
    const sell = swap({ side: 'sell', base: 100, usd: 100, feeUsdShare: 0.01 });

    expect(traderCashUsd(buy)!).toBeCloseTo(101, 4);
    expect(traderCashUsd(sell)!).toBeCloseTo(99, 4);
  });

  it('uses the pool leg unadjusted when the venue reports no fee', () => {
    // The pump.fun bonding curve case. DECISIONS.md calls the resulting ~1%
    // understatement a P1 blocker; it must not become a silent zero-fee claim.
    const buy = swap({ side: 'buy', base: 100, usd: 100, feeUsdShare: null });
    expect(traderCashUsd(buy)).toBe(100);
    expect(buy.quoteFeeAmount).toBeNull();
  });

  it('returns null for an unpriced swap', () => {
    expect(traderCashUsd(swap({ side: 'buy', base: 100, usd: null }))).toBeNull();
  });
});
