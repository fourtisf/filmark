import { describe, expect, it } from 'vitest';
import type { Position, PositionBuyLeg } from '@exitliquidity/positions';
import { allocatePosition, legKey, mergeResults, rollUpByCounterparty } from './allocate.js';
import type { NettedWindow, WindowCounterparty } from './types.js';

const VICTIM = 'V1ct1mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT = 'M1ntAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL = 'Poo1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function leg(signature: string, slot: bigint, costBasisUsd: number): PositionBuyLeg {
  return {
    signature,
    slot,
    blockTime: 1_700_000_000 + Number(slot),
    venue: 'pumpswap',
    poolId: POOL,
    mint: MINT,
    qtyConsumed: 1_000_000n,
    costBasisUsd,
    feeKnown: true,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  const legs = overrides.legs ?? [leg('buy1', 100n, 1000)];
  return {
    wallet: VICTIM,
    mint: MINT,
    baseDecimals: 6,
    status: 'closed',
    basisQuality: 'complete',
    openTs: 1_700_000_000,
    closeTs: 1_700_000_600,
    costBasisUsd: legs.reduce((sum, entry) => sum + entry.costBasisUsd, 0),
    proceedsUsd: 400,
    realisedPnlUsd: -600,
    buyCount: legs.length,
    sellCount: 1,
    peakQty: 1_000_000n,
    remainingQty: 0n,
    unbackedQty: 0n,
    legs,
    ...overrides,
  };
}

function window(
  counterparties: readonly Pick<WindowCounterparty, 'wallet' | 'share'>[],
): NettedWindow {
  return {
    poolId: POOL,
    mint: MINT,
    buySlot: 100n,
    buyTs: 1_700_000_100,
    startSlot: 90n,
    endSlot: 110n,
    startTs: 1_700_000_090,
    endTs: 1_700_000_110,
    targetUsd: 1000,
    sellVolumeUsd: 1000,
    capped: false,
    counterparties: counterparties.map((entry) => ({
      wallet: entry.wallet,
      sellUsd: 100,
      weight: entry.share,
      share: entry.share,
      nearestSlot: 100n,
      sellCount: 1,
    })),
    excluded: [],
  };
}

describe('allocatePosition', () => {
  it('splits the realised loss by window share, not by buy size', () => {
    const only = leg('buy1', 100n, 1000);
    const result = allocatePosition(position({ legs: [only] }), [
      {
        leg: only,
        window: window([
          { wallet: 'a', share: 0.7 },
          { wallet: 'b', share: 0.3 },
        ]),
      },
    ]);

    expect(result.attributedUsd).toBeCloseTo(600, 6);
    expect(result.unattributedUsd).toBe(0);
    const byWallet = Object.fromEntries(result.rows.map((r) => [r.counterparty, r.attributedUsd]));
    expect(byWallet['a']).toBeCloseTo(420, 6);
    expect(byWallet['b']).toBeCloseTo(180, 6);
  });

  it('scales each leg by its share of the cost basis', () => {
    const big = leg('buy1', 100n, 900);
    const small = leg('buy2', 200n, 100);
    const result = allocatePosition(position({ legs: [big, small] }), [
      { leg: big, window: window([{ wallet: 'a', share: 1 }]) },
      { leg: small, window: window([{ wallet: 'b', share: 1 }]) },
    ]);

    const byWallet = Object.fromEntries(result.rows.map((r) => [r.counterparty, r.attributedUsd]));
    // 90% of the basis carries 90% of the $600 loss.
    expect(byWallet['a']).toBeCloseTo(540, 6);
    expect(byWallet['b']).toBeCloseTo(60, 6);
    expect(result.attributedUsd).toBeCloseTo(600, 6);
  });

  it('reports a leg with no counterparties as unattributed rather than spreading it', () => {
    const found = leg('buy1', 100n, 500);
    const empty = leg('buy2', 200n, 500);
    const result = allocatePosition(position({ legs: [found, empty] }), [
      { leg: found, window: window([{ wallet: 'a', share: 1 }]) },
      { leg: empty, window: window([]) },
    ]);

    expect(result.attributedUsd).toBeCloseTo(300, 6);
    expect(result.unattributedUsd).toBeCloseTo(300, 6);
    // Not 600 to wallet a: nothing measured that half of the loss, and inventing
    // a number for it is the failure mode §7.4 exists to prevent.
    expect(result.rows).toHaveLength(1);
  });

  it('carries the window onto every row', () => {
    const only = leg('buy1', 100n, 1000);
    const result = allocatePosition(position({ legs: [only] }), [
      { leg: only, window: window([{ wallet: 'a', share: 1 }]) },
    ]);

    expect(result.rows[0]).toMatchObject({
      poolId: POOL,
      windowStartSlot: 90n,
      windowEndSlot: 110n,
      windowTs: 1_700_000_100,
      buyLegSignature: 'buy1',
    });
  });

  it('attributes nothing from an open position', () => {
    const only = leg('buy1', 100n, 1000);
    const result = allocatePosition(position({ legs: [only], status: 'open', closeTs: null }), [
      { leg: only, window: window([{ wallet: 'a', share: 1 }]) },
    ]);
    expect(result.rows).toHaveLength(0);
  });

  it('attributes nothing from an unknown-basis position', () => {
    const only = leg('buy1', 100n, 1000);
    const result = allocatePosition(
      position({ legs: [only], basisQuality: 'unknown_basis', unbackedQty: 5n }),
      [{ leg: only, window: window([{ wallet: 'a', share: 1 }]) }],
    );
    expect(result.rows).toHaveLength(0);
  });

  it('attributes nothing from a winning position', () => {
    const only = leg('buy1', 100n, 1000);
    const result = allocatePosition(
      position({ legs: [only], proceedsUsd: 1500, realisedPnlUsd: 500 }),
      [{ leg: only, window: window([{ wallet: 'a', share: 1 }]) }],
    );
    expect(result.rows).toHaveLength(0);
  });

  it('pairs windows by pool as well as signature', () => {
    // One transaction, two pools. Keying on the signature alone would hand the
    // second leg the first pool's counterparties.
    const first = leg('same-sig', 100n, 500);
    const second = { ...leg('same-sig', 100n, 500), poolId: 'other-pool' };
    expect(legKey(first)).not.toBe(legKey(second));

    const result = allocatePosition(position({ legs: [first, second] }), [
      { leg: first, window: window([{ wallet: 'a', share: 1 }]) },
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.unattributedUsd).toBeCloseTo(300, 6);
  });
});

describe('rollUpByCounterparty', () => {
  it('ranks counterparties by dollars and keeps their rows', () => {
    const a = leg('buy1', 100n, 1000);
    const first = allocatePosition(position({ legs: [a] }), [
      {
        leg: a,
        window: window([
          { wallet: 'x', share: 0.5 },
          { wallet: 'y', share: 0.5 },
        ]),
      },
    ]);
    const b = leg('buy2', 300n, 1000);
    const second = allocatePosition(position({ legs: [b], mint: 'other-mint' }), [
      { leg: b, window: window([{ wallet: 'y', share: 1 }]) },
    ]);

    const totals = rollUpByCounterparty(mergeResults([first, second]).rows);

    expect(totals.map((t) => t.counterparty)).toEqual(['y', 'x']);
    expect(totals[0]!.attributedUsd).toBeCloseTo(900, 6);
    expect(totals[0]!.rows).toHaveLength(2);
    expect(totals[0]!.mints.sort()).toEqual(['other-mint', MINT].sort());
  });

  it('returns nothing for no rows', () => {
    expect(rollUpByCounterparty([])).toEqual([]);
  });
});
