import type { NormalisedSwap } from '@exitliquidity/core';
import type { PositionBuyLeg } from '@exitliquidity/positions';
import type {
  ExclusionReason,
  NettedWindow,
  WindowCounterparty,
  WindowExclusion,
} from './types.js';

/** Spec §2 Stage 3 step 4: τ ≈ 150 slots, roughly a minute of proximity decay. */
export const DEFAULT_TAU_SLOTS = 150;

/** Spec §2 Stage 3 step 1: expansion stops at ±10 minutes however little volume it found. */
export const DEFAULT_MAX_WINDOW_SEC = 600;

/** Spec §2 Stage 3 step 3: under 20% net-to-gross is a round-tripper, not a distributor. */
export const DEFAULT_ROUND_TRIP_THRESHOLD = 0.2;

export interface NettingOptions {
  readonly tauSlots?: number;
  readonly maxWindowSec?: number;
  readonly roundTripThreshold?: number;
  /**
   * Wallets that are never counterparties: CEX hot wallets, routers, aggregator
   * vaults, and — once clustering lands — the buyer's own funding cluster.
   *
   * Empty by default and deliberately not seeded with a guessed list. Spec §2
   * Stage 6 assigns cluster discovery to a phase that has not been built; a
   * hardcoded set of addresses nobody verified would be a fabricated exclusion,
   * which is the same problem as a fabricated figure.
   */
  readonly excludedWallets?: ReadonlySet<string>;
}

/**
 * The one buy leg a window is expanded around.
 *
 * `usdSize` is the volume target, not a filter: expansion runs until the pool
 * has sold as many dollars as this leg bought.
 */
export interface BuyLegWindowInput {
  readonly wallet: string;
  readonly poolId: string;
  readonly mint: string;
  readonly slot: bigint;
  readonly blockTime: number;
  readonly usdSize: number;
}

export function buyLegInput(leg: PositionBuyLeg, wallet: string): BuyLegWindowInput {
  return {
    wallet,
    poolId: leg.poolId,
    mint: leg.mint,
    slot: leg.slot,
    blockTime: leg.blockTime,
    usdSize: leg.costBasisUsd,
  };
}

/**
 * Nets one buy leg against the pool activity around it. Spec §2 Stage 3.
 *
 * The window is expanded by *volume*, not by a fixed duration: §2 is explicit
 * that a fixed window is wrong at both ends — too wide on a memecoin filling
 * every block, too narrow on a pool that trades twice an hour. Expansion takes
 * whichever neighbouring swap is closest to the buy, so the result is always a
 * contiguous slot range and can be displayed as one.
 *
 * LP add and remove never appear here, and not by accident: the parsers emit
 * swaps only, so a liquidity operation has no row to be filtered out of.
 */
export function netWindow(
  buy: BuyLegWindowInput,
  poolSwaps: readonly NormalisedSwap[],
  options: NettingOptions = {},
): NettedWindow {
  const tau = options.tauSlots ?? DEFAULT_TAU_SLOTS;
  const maxWindowSec = options.maxWindowSec ?? DEFAULT_MAX_WINDOW_SEC;
  const roundTrip = options.roundTripThreshold ?? DEFAULT_ROUND_TRIP_THRESHOLD;
  const listed = options.excludedWallets ?? EMPTY_SET;

  if (tau <= 0) throw new RangeError('tauSlots must be > 0');

  const candidates = poolSwaps
    .filter((swap) => swap.poolId === buy.poolId && swap.mint === buy.mint)
    .sort(bySlot);

  const inWindow = expand(buy, candidates, maxWindowSec);
  const window = summarise(buy, inWindow.swaps, inWindow.capped);

  const totals = new Map<string, WalletTally>();
  for (const swap of inWindow.swaps) {
    const tally = totals.get(swap.wallet) ?? newTally();
    totals.set(swap.wallet, tally);

    if (swap.side === 'buy') {
      tally.buyBase += swap.baseAmount;
      continue;
    }

    tally.sellBase += swap.baseAmount;
    tally.sellCount += 1;
    if (swap.usdValue !== null) {
      tally.sellUsd += swap.usdValue;
      const distance = Number(absDiff(swap.slot, buy.slot));
      tally.weight += swap.usdValue * Math.exp(-distance / tau);
    }
    if (
      tally.nearestSlot === null ||
      absDiff(swap.slot, buy.slot) < absDiff(tally.nearestSlot, buy.slot)
    ) {
      tally.nearestSlot = swap.slot;
    }
  }

  const kept: WindowCounterparty[] = [];
  const excluded: WindowExclusion[] = [];

  for (const [wallet, tally] of totals) {
    if (tally.sellCount === 0) continue;

    const reason = excludeFor(wallet, tally, buy.wallet, listed, roundTrip);
    if (reason !== null) {
      excluded.push({ wallet, reason, sellUsd: tally.sellUsd });
      continue;
    }

    kept.push({
      wallet,
      sellUsd: tally.sellUsd,
      weight: tally.weight,
      share: 0,
      nearestSlot: tally.nearestSlot ?? buy.slot,
      sellCount: tally.sellCount,
    });
  }

  const totalWeight = kept.reduce((sum, entry) => sum + entry.weight, 0);
  const counterparties = kept
    .map((entry) => ({ ...entry, share: totalWeight > 0 ? entry.weight / totalWeight : 0 }))
    .filter((entry) => entry.share > 0)
    .sort((a, b) => b.share - a.share);

  excluded.sort((a, b) => b.sellUsd - a.sellUsd);

  return { ...window, counterparties, excluded };
}

interface WalletTally {
  buyBase: bigint;
  sellBase: bigint;
  sellUsd: number;
  weight: number;
  sellCount: number;
  nearestSlot: bigint | null;
}

function newTally(): WalletTally {
  return { buyBase: 0n, sellBase: 0n, sellUsd: 0, weight: 0, sellCount: 0, nearestSlot: null };
}

function excludeFor(
  wallet: string,
  tally: WalletTally,
  buyer: string,
  listed: ReadonlySet<string>,
  roundTripThreshold: number,
): ExclusionReason | null {
  if (wallet === buyer) return 'self';
  if (listed.has(wallet)) return 'listed';
  if (isRoundTripper(tally, roundTripThreshold)) return 'round_trip';
  if (tally.weight <= 0) return 'unpriced';
  return null;
}

/**
 * Net-to-gross, measured in base tokens rather than dollars.
 *
 * "Net position change" is a quantity; computing it from USD would make the
 * ratio move with the price inside the window, so a wallet that bought and sold
 * the same number of tokens while the price ran would read as a distributor.
 * Within one mint the decimals are fixed, so the raw amounts compare directly.
 */
function isRoundTripper(tally: WalletTally, threshold: number): boolean {
  const gross = tally.buyBase + tally.sellBase;
  if (gross === 0n) return false;
  const net =
    tally.sellBase > tally.buyBase
      ? tally.sellBase - tally.buyBase
      : tally.buyBase - tally.sellBase;
  const thresholdPpm = BigInt(Math.round(threshold * 1e6));
  return net * 1_000_000n < gross * thresholdPpm;
}

interface Expansion {
  readonly swaps: NormalisedSwap[];
  readonly volumeUsd: number;
  readonly capped: boolean;
}

/**
 * Grows a contiguous range outward from the buy until it holds `usdSize` of
 * sell volume, or until the time cap stops it.
 *
 * Nearest-first, so the range never has a hole in it and the pair of slots
 * returned really does describe everything that was counted.
 */
function expand(
  buy: BuyLegWindowInput,
  sorted: readonly NormalisedSwap[],
  maxWindowSec: number,
): Expansion {
  const swaps: NormalisedSwap[] = [];
  let volumeUsd = 0;

  if (sorted.length === 0 || buy.usdSize <= 0) {
    return { swaps, volumeUsd, capped: false };
  }

  let right = lowerBound(sorted, buy.slot);
  let left = right - 1;
  let leftStopped = false;
  let rightStopped = false;

  const withinCap = (swap: NormalisedSwap): boolean =>
    Math.abs(swap.blockTime - buy.blockTime) <= maxWindowSec;

  while (volumeUsd < buy.usdSize) {
    const leftSwap = left >= 0 && !leftStopped ? sorted[left] : undefined;
    const rightSwap = right < sorted.length && !rightStopped ? sorted[right] : undefined;

    if (leftSwap !== undefined && !withinCap(leftSwap)) {
      leftStopped = true;
      continue;
    }
    if (rightSwap !== undefined && !withinCap(rightSwap)) {
      rightStopped = true;
      continue;
    }
    if (leftSwap === undefined && rightSwap === undefined) break;

    // Take whichever neighbour is closer to the buy. Ties go right, so a swap
    // in the same slot as the buy is picked up before one a slot behind it.
    const takeLeft =
      rightSwap === undefined ||
      (leftSwap !== undefined &&
        absDiff(leftSwap.slot, buy.slot) < absDiff(rightSwap.slot, buy.slot));

    const chosen = takeLeft ? (leftSwap as NormalisedSwap) : rightSwap;
    if (takeLeft) left -= 1;
    else right += 1;

    swaps.push(chosen);
    if (chosen.side === 'sell' && chosen.usdValue !== null) volumeUsd += chosen.usdValue;
  }

  // `capped` means expansion ran out of room, not that it ran out of swaps: a
  // window that reached its target is neither, and a window that exhausted a
  // quiet pool is a different fact from one that hit ±10 minutes.
  const capped = volumeUsd < buy.usdSize && (leftStopped || rightStopped);
  return { swaps, volumeUsd, capped };
}

function summarise(
  buy: BuyLegWindowInput,
  swaps: readonly NormalisedSwap[],
  capped: boolean,
): Omit<NettedWindow, 'counterparties' | 'excluded'> {
  let startSlot = buy.slot;
  let endSlot = buy.slot;
  let startTs = buy.blockTime;
  let endTs = buy.blockTime;
  let sellVolumeUsd = 0;

  for (const swap of swaps) {
    if (swap.slot < startSlot) startSlot = swap.slot;
    if (swap.slot > endSlot) endSlot = swap.slot;
    if (swap.blockTime < startTs) startTs = swap.blockTime;
    if (swap.blockTime > endTs) endTs = swap.blockTime;
    if (swap.side === 'sell' && swap.usdValue !== null) sellVolumeUsd += swap.usdValue;
  }

  return {
    poolId: buy.poolId,
    mint: buy.mint,
    buySlot: buy.slot,
    buyTs: buy.blockTime,
    startSlot,
    endSlot,
    startTs,
    endTs,
    targetUsd: buy.usdSize,
    sellVolumeUsd,
    capped,
  };
}

/** Index of the first swap at or after `slot`. */
function lowerBound(sorted: readonly NormalisedSwap[], slot: bigint): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] as NormalisedSwap).slot < slot) low = mid + 1;
    else high = mid;
  }
  return low;
}

function bySlot(a: NormalisedSwap, b: NormalisedSwap): number {
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  if (a.ixIndex !== b.ixIndex) return a.ixIndex - b.ixIndex;
  return a.innerIxIndex - b.innerIxIndex;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
