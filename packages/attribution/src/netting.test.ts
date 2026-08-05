import { describe, expect, it } from 'vitest';
import { WSOL_MINT, type NormalisedSwap, type Side } from '@exitliquidity/core';
import { netWindow, type BuyLegWindowInput } from './netting.js';

const POOL = 'Poo1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT = 'M1ntAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VICTIM = 'V1ct1mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const BUY_SLOT = 10_000n;
const BUY_TS = 1_700_000_000;

let seq = 0;

interface PoolSwapSpec {
  readonly wallet: string;
  readonly side: Side;
  readonly slot: number;
  /** Whole tokens at 6 decimals. */
  readonly base: number;
  readonly usd?: number | null;
}

function poolSwap(spec: PoolSwapSpec): NormalisedSwap {
  seq += 1;
  const usd = spec.usd === undefined ? spec.base : spec.usd;
  return {
    signature: `pool${seq}`,
    slot: BigInt(spec.slot),
    // 400ms per slot, the same relationship the ±10 minute cap is measured in.
    blockTime: BUY_TS + Math.round((spec.slot - Number(BUY_SLOT)) * 0.4),
    venue: 'pumpswap',
    poolId: POOL,
    mint: MINT,
    wallet: spec.wallet,
    side: spec.side,
    baseAmount: BigInt(Math.round(spec.base * 1e6)),
    baseDecimals: 6,
    quoteAmount: 1_000_000_000n,
    quoteFeeAmount: null,
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    usdValue: usd,
    usdPriceSource: usd === null ? 'none' : 'pyth_1m',
    ixIndex: 0,
    innerIxIndex: -1,
    ingestSource: 'backfill',
  };
}

function buyLeg(usdSize: number): BuyLegWindowInput {
  return {
    wallet: VICTIM,
    poolId: POOL,
    mint: MINT,
    slot: BUY_SLOT,
    blockTime: BUY_TS,
    usdSize,
  };
}

describe('netWindow', () => {
  it('expands by volume until the buy size is matched', () => {
    // Four $100 sells fanning out from the buy. A $250 buy should reach into
    // three of them and stop, rather than taking a fixed slot range.
    const pool = [
      poolSwap({ wallet: 'a', side: 'sell', slot: 9_990, base: 100 }),
      poolSwap({ wallet: 'b', side: 'sell', slot: 10_010, base: 100 }),
      poolSwap({ wallet: 'c', side: 'sell', slot: 10_050, base: 100 }),
      poolSwap({ wallet: 'd', side: 'sell', slot: 10_400, base: 100 }),
    ];

    const window = netWindow(buyLeg(250), pool);

    expect(window.sellVolumeUsd).toBeCloseTo(300, 6);
    expect(window.capped).toBe(false);
    expect(window.counterparties.map((c) => c.wallet).sort()).toEqual(['a', 'b', 'c']);
  });

  it('weights nearer sells more heavily', () => {
    const pool = [
      poolSwap({ wallet: 'near', side: 'sell', slot: 10_001, base: 100 }),
      poolSwap({ wallet: 'far', side: 'sell', slot: 10_400, base: 100 }),
    ];

    const window = netWindow(buyLeg(200), pool);
    const near = window.counterparties.find((c) => c.wallet === 'near');
    const far = window.counterparties.find((c) => c.wallet === 'far');

    // Equal dollars, unequal proximity: τ = 150 slots puts ~400 slots at about
    // e^-2.66 of the weight, so the split is far from 50/50.
    expect(near!.share).toBeGreaterThan(far!.share);
    expect(near!.share + far!.share).toBeCloseTo(1, 10);
  });

  it('shares sum to one', () => {
    const pool = [
      poolSwap({ wallet: 'a', side: 'sell', slot: 9_980, base: 40 }),
      poolSwap({ wallet: 'b', side: 'sell', slot: 10_020, base: 60 }),
      poolSwap({ wallet: 'c', side: 'sell', slot: 10_100, base: 30 }),
    ];

    const window = netWindow(buyLeg(500), pool);
    const total = window.counterparties.reduce((sum, c) => sum + c.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('excludes the buyer from its own window', () => {
    const pool = [
      poolSwap({ wallet: VICTIM, side: 'sell', slot: 10_005, base: 100 }),
      poolSwap({ wallet: 'other', side: 'sell', slot: 10_006, base: 100 }),
    ];

    const window = netWindow(buyLeg(200), pool);
    expect(window.counterparties.map((c) => c.wallet)).toEqual(['other']);
    expect(window.excluded).toContainEqual(
      expect.objectContaining({ wallet: VICTIM, reason: 'self' }),
    );
  });

  it('excludes a round-tripping market maker', () => {
    // Buys 100 and sells 100 inside the window: gross 200, net 0. That is a bot
    // cycling inventory, not a wallet reducing supply into the victim.
    const pool = [
      poolSwap({ wallet: 'mm', side: 'sell', slot: 10_002, base: 100 }),
      poolSwap({ wallet: 'mm', side: 'buy', slot: 10_004, base: 100 }),
      poolSwap({ wallet: 'real', side: 'sell', slot: 10_006, base: 100 }),
    ];

    const window = netWindow(buyLeg(400), pool);
    expect(window.counterparties.map((c) => c.wallet)).toEqual(['real']);
    expect(window.excluded).toContainEqual(
      expect.objectContaining({ wallet: 'mm', reason: 'round_trip' }),
    );
  });

  it('keeps a wallet that sold far more than it bought', () => {
    const pool = [
      poolSwap({ wallet: 'distributor', side: 'sell', slot: 10_002, base: 100 }),
      poolSwap({ wallet: 'distributor', side: 'buy', slot: 10_004, base: 5 }),
    ];

    const window = netWindow(buyLeg(200), pool);
    expect(window.counterparties.map((c) => c.wallet)).toEqual(['distributor']);
  });

  it('excludes wallets the caller has listed', () => {
    const pool = [
      poolSwap({ wallet: 'cex-hot', side: 'sell', slot: 10_002, base: 100 }),
      poolSwap({ wallet: 'real', side: 'sell', slot: 10_003, base: 100 }),
    ];

    const window = netWindow(buyLeg(300), pool, { excludedWallets: new Set(['cex-hot']) });
    expect(window.counterparties.map((c) => c.wallet)).toEqual(['real']);
    expect(window.excluded).toContainEqual(
      expect.objectContaining({ wallet: 'cex-hot', reason: 'listed' }),
    );
  });

  it('excludes a wallet whose sells could not be priced', () => {
    const pool = [
      poolSwap({ wallet: 'unpriced', side: 'sell', slot: 10_002, base: 100, usd: null }),
      poolSwap({ wallet: 'real', side: 'sell', slot: 10_003, base: 100 }),
    ];

    const window = netWindow(buyLeg(300), pool);
    expect(window.counterparties.map((c) => c.wallet)).toEqual(['real']);
    expect(window.excluded).toContainEqual(
      expect.objectContaining({ wallet: 'unpriced', reason: 'unpriced' }),
    );
  });

  it('stops at the time cap and says so', () => {
    // One sell, 20 minutes past the buy. The window wanted $500 and is allowed
    // ±10 minutes, so it must come back empty and flagged rather than reaching.
    const pool = [poolSwap({ wallet: 'late', side: 'sell', slot: 13_000, base: 500 })];

    const window = netWindow(buyLeg(500), pool);
    expect(window.counterparties).toHaveLength(0);
    expect(window.capped).toBe(true);
    expect(window.sellVolumeUsd).toBe(0);
  });

  it('reports a quiet pool as uncapped and short', () => {
    const pool = [poolSwap({ wallet: 'a', side: 'sell', slot: 10_010, base: 30 })];

    const window = netWindow(buyLeg(500), pool);
    expect(window.sellVolumeUsd).toBeCloseTo(30, 6);
    // Everything in range was consumed; the pool simply had nothing more. That
    // is a different fact from hitting the ±10 minute cap.
    expect(window.capped).toBe(false);
  });

  it('reports a contiguous slot range covering everything it counted', () => {
    const pool = [
      poolSwap({ wallet: 'a', side: 'sell', slot: 9_950, base: 100 }),
      poolSwap({ wallet: 'b', side: 'sell', slot: 10_030, base: 100 }),
    ];

    const window = netWindow(buyLeg(200), pool);
    expect(window.startSlot).toBe(9_950n);
    expect(window.endSlot).toBe(10_030n);
    expect(window.startTs).toBeLessThanOrEqual(window.buyTs);
    expect(window.endTs).toBeGreaterThanOrEqual(window.buyTs);
  });

  it('ignores activity in a different pool', () => {
    const elsewhere = {
      ...poolSwap({ wallet: 'x', side: 'sell', slot: 10_001, base: 500 }),
      poolId: 'other-pool',
    };
    const window = netWindow(buyLeg(200), [elsewhere]);
    expect(window.counterparties).toHaveLength(0);
  });

  it('returns nothing for a zero-sized buy leg', () => {
    const pool = [poolSwap({ wallet: 'a', side: 'sell', slot: 10_001, base: 100 })];
    expect(netWindow(buyLeg(0), pool).counterparties).toHaveLength(0);
  });
});
