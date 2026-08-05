import { rawToNumber, type NormalisedSwap, type Venue } from '@exitliquidity/core';
import type { BasisQuality, Position, PositionBuyLeg } from './types.js';

/** Spec §2 Stage 2: closed once cumulative quantity falls under 0.5% of peak. */
export const DEFAULT_DUST_FRACTION = 0.005;

const PPM = 1_000_000n;

export interface AccountingOptions {
  /**
   * Share of peak quantity below which a position counts as closed.
   *
   * A memecoin sell rarely lands on zero: rounding, a transfer fee, or a dust
   * balance left behind keeps a few base units in the account forever. Without
   * a threshold every position stays open and nothing is ever attributable.
   */
  readonly dustFraction?: number;
}

/**
 * FIFO lot accounting over one wallet's swaps. Spec §2 Stage 2.
 *
 * Quantities stay `bigint` throughout — they are raw base units, and a
 * six-decimal supply routinely exceeds what a double holds exactly. Only the
 * dollar side is floating point, and only because it already was.
 *
 * Swaps may arrive in any order; they are sorted here rather than trusted,
 * because FIFO applied to an out-of-order stream silently consumes the wrong
 * lots and produces a realised PnL that looks plausible and is wrong.
 */
export function accountPositions(
  wallet: string,
  swaps: readonly NormalisedSwap[],
  options: AccountingOptions = {},
): Position[] {
  const dustPpm = toDustPpm(options.dustFraction ?? DEFAULT_DUST_FRACTION);

  const byMint = new Map<string, NormalisedSwap[]>();
  for (const swap of swaps) {
    if (swap.wallet !== wallet) continue;
    const bucket = byMint.get(swap.mint);
    if (bucket === undefined) byMint.set(swap.mint, [swap]);
    else bucket.push(swap);
  }

  const positions: Position[] = [];
  for (const [mint, mintSwaps] of byMint) {
    mintSwaps.sort(byExecutionOrder);
    positions.push(...accountOneMint(wallet, mint, mintSwaps, dustPpm));
  }

  // Newest close first: a trace leads with what just happened, not with what a
  // wallet did in January.
  positions.sort((a, b) => (b.closeTs ?? b.openTs) - (a.closeTs ?? a.openTs));
  return positions;
}

/**
 * Execution order within a wallet: slot, then position inside the transaction.
 *
 * Slot is the chain's own sequence and the only authoritative one. Block time
 * is a derived estimate with one-second granularity over blocks that arrive
 * two and a half times a second, and it is not guaranteed to be monotonic —
 * so ordering by it first can place a sell ahead of the buy that funded it.
 * FIFO then finds no lot to consume, books the sale as stock that arrived from
 * nowhere, and the position is discarded as `unknown_basis`. The trade is
 * real, the loss is real, and the trace reports neither.
 *
 * Block time is deliberately not a tiebreaker either: within one slot the
 * instruction indices are exact, and a timestamp cannot improve on them.
 */
export function byExecutionOrder(a: NormalisedSwap, b: NormalisedSwap): number {
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  if (a.ixIndex !== b.ixIndex) return a.ixIndex - b.ixIndex;
  return a.innerIxIndex - b.innerIxIndex;
}

interface Lot {
  /** Base units still in the lot. */
  qty: bigint;
  /** USD basis still in the lot, falling as it is consumed. */
  costUsd: number;
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTime: number;
  readonly venue: Venue;
  readonly poolId: string;
  readonly priced: boolean;
  readonly feeKnown: boolean;
}

interface Builder {
  openTs: number;
  costBasisUsd: number;
  proceedsUsd: number;
  buyCount: number;
  sellCount: number;
  peakQty: bigint;
  unbackedQty: bigint;
  unpriced: boolean;
  lots: Lot[];
  /** Consumed basis per buy leg, keyed by the leg's identity in the transaction. */
  legs: Map<string, { leg: Lot; qty: bigint; usd: number }>;
}

function accountOneMint(
  wallet: string,
  mint: string,
  swaps: readonly NormalisedSwap[],
  dustPpm: bigint,
): Position[] {
  const positions: Position[] = [];
  let builder: Builder | null = null;
  let decimals = 0;

  for (const swap of swaps) {
    decimals = swap.baseDecimals;
    if (swap.baseAmount <= 0n) continue;

    if (swap.side === 'buy') {
      builder ??= newBuilder(swap.blockTime);
      applyBuy(builder, swap);
      continue;
    }

    // A sell with nothing open still has to be recorded: it is the signal that
    // the tokens arrived from somewhere we cannot see, which is exactly what
    // `unknown_basis` exists to say.
    builder ??= newBuilder(swap.blockTime);
    applySell(builder, swap);

    if (heldQty(builder) * PPM <= builder.peakQty * dustPpm) {
      positions.push(finish(wallet, mint, decimals, builder, swap.blockTime));
      builder = null;
    }
  }

  if (builder !== null) positions.push(finish(wallet, mint, decimals, builder, null));
  return positions;
}

function newBuilder(openTs: number): Builder {
  return {
    openTs,
    costBasisUsd: 0,
    proceedsUsd: 0,
    buyCount: 0,
    sellCount: 0,
    peakQty: 0n,
    unbackedQty: 0n,
    unpriced: false,
    lots: [],
    legs: new Map(),
  };
}

function applyBuy(builder: Builder, swap: NormalisedSwap): void {
  const cost = traderCashUsd(swap);
  builder.buyCount += 1;
  builder.lots.push({
    qty: swap.baseAmount,
    costUsd: cost ?? 0,
    signature: swap.signature,
    slot: swap.slot,
    blockTime: swap.blockTime,
    venue: swap.venue,
    poolId: swap.poolId,
    priced: cost !== null,
    feeKnown: swap.quoteFeeAmount !== null,
  });

  const held = heldQty(builder);
  if (held > builder.peakQty) builder.peakQty = held;
}

function applySell(builder: Builder, swap: NormalisedSwap): void {
  builder.sellCount += 1;

  const proceeds = traderCashUsd(swap);
  if (proceeds === null) builder.unpriced = true;
  else builder.proceedsUsd += proceeds;

  let remaining = swap.baseAmount;
  while (remaining > 0n && builder.lots.length > 0) {
    const lot = builder.lots[0] as Lot;
    const take = lot.qty < remaining ? lot.qty : remaining;

    // Cost and quantity are drawn down together, so a lot eaten in three bites
    // returns exactly the basis it was opened with: C·t₂/(Q−t₁) applied to the
    // already-reduced cost is the same as C·t₂/Q. Taking the whole lot clears
    // the remainder outright, so float drift cannot leave a cent behind.
    const basis = take === lot.qty ? lot.costUsd : (lot.costUsd * Number(take)) / Number(lot.qty);

    lot.qty -= take;
    lot.costUsd = lot.qty === 0n ? 0 : lot.costUsd - basis;
    remaining -= take;

    if (!lot.priced) builder.unpriced = true;
    builder.costBasisUsd += basis;
    recordLeg(builder, lot, take, basis);

    if (lot.qty === 0n) builder.lots.shift();
  }

  // Sold more than every lot held. Spec §2 Stage 2 is emphatic that this is not
  // zero-cost stock: treating it as such invents profit on a scale that makes
  // every downstream figure meaningless.
  if (remaining > 0n) builder.unbackedQty += remaining;
}

function recordLeg(builder: Builder, lot: Lot, qty: bigint, usd: number): void {
  const key = `${lot.signature}:${lot.slot.toString()}:${lot.poolId}`;
  const existing = builder.legs.get(key);
  if (existing === undefined) builder.legs.set(key, { leg: lot, qty, usd });
  else {
    existing.qty += qty;
    existing.usd += usd;
  }
}

function finish(
  wallet: string,
  mint: string,
  baseDecimals: number,
  builder: Builder,
  closeTs: number | null,
): Position {
  const legs: PositionBuyLeg[] = [...builder.legs.values()]
    .map((entry) => ({
      signature: entry.leg.signature,
      slot: entry.leg.slot,
      blockTime: entry.leg.blockTime,
      venue: entry.leg.venue,
      poolId: entry.leg.poolId,
      mint,
      qtyConsumed: entry.qty,
      costBasisUsd: entry.usd,
      feeKnown: entry.leg.feeKnown,
    }))
    .sort((a, b) => (a.slot === b.slot ? 0 : a.slot < b.slot ? -1 : 1));

  const basisQuality: BasisQuality =
    builder.unbackedQty > 0n ? 'unknown_basis' : builder.unpriced ? 'unpriced' : 'complete';

  return {
    wallet,
    mint,
    baseDecimals,
    status: closeTs === null ? 'open' : 'closed',
    basisQuality,
    openTs: builder.openTs,
    closeTs,
    costBasisUsd: builder.costBasisUsd,
    proceedsUsd: builder.proceedsUsd,
    realisedPnlUsd: builder.proceedsUsd - builder.costBasisUsd,
    buyCount: builder.buyCount,
    sellCount: builder.sellCount,
    peakQty: builder.peakQty,
    remainingQty: heldQty(builder),
    unbackedQty: builder.unbackedQty,
    legs,
  };
}

function heldQty(builder: Builder): bigint {
  return builder.lots.reduce((total, lot) => total + lot.qty, 0n);
}

/**
 * What the trade cost or returned the trader, in USD.
 *
 * `usdValue` prices the pool leg — quote tokens in or out of the pool, fees
 * excluded. Cost basis needs the trader's own cash flow, which is the pool leg
 * plus the fee on a buy and minus it on a sell. Both legs are priced at the
 * same instant, so scaling the known USD figure by the raw ratio is exact
 * rather than an approximation.
 *
 * Returns null when the swap could not be priced at all. The pump.fun bonding
 * curve reports no fee (`quoteFeeAmount` null, see DECISIONS.md); there the
 * pool leg is used unadjusted and the leg is flagged `feeKnown: false`, so a
 * basis that is understated by roughly the fee is visible rather than assumed.
 */
export function traderCashUsd(swap: NormalisedSwap): number | null {
  if (swap.usdValue === null) return null;
  if (swap.quoteFeeAmount === null || swap.quoteFeeAmount === 0n) return swap.usdValue;

  const poolUnits = rawToNumber(swap.quoteAmount, swap.quoteDecimals);
  if (!(poolUnits > 0)) return swap.usdValue;

  const feeUnits = rawToNumber(swap.quoteFeeAmount, swap.quoteDecimals);
  const traderUnits = swap.side === 'buy' ? poolUnits + feeUnits : poolUnits - feeUnits;
  if (!(traderUnits > 0)) return 0;

  return (swap.usdValue * traderUnits) / poolUnits;
}

function toDustPpm(fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new RangeError(`dustFraction must be in [0, 1): ${fraction}`);
  }
  return BigInt(Math.round(fraction * 1e6));
}
