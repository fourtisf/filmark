import type { Venue } from '@exitliquidity/core';

/**
 * How much of a position's cost basis we can actually stand behind.
 *
 * Spec §2 Stage 2 names one of these — `unknown_basis`, for tokens that arrived
 * by transfer rather than by swap — and is explicit that such positions are
 * excluded from attribution entirely. The other two are the same failure in a
 * different disguise: a basis that exists but is not knowable from what was
 * ingested. Treating any of them as complete fabricates profit, which §7.4
 * forbids, so they are named separately and filtered the same way.
 */
export type BasisQuality =
  /** Every unit sold was bought in a swap we parsed, and every leg was priced. */
  | 'complete'
  /**
   * More was sold than was ever bought. The difference arrived by transfer, or
   * was bought on a venue with no parser yet — indistinguishable from here, and
   * excluded either way.
   */
  | 'unknown_basis'
  /** A contributing leg had no USD price, so the basis is incomplete. */
  | 'unpriced';

export type PositionStatus = 'open' | 'closed';

/**
 * One buy that funded the quantity a position closed with.
 *
 * `costBasisUsd` is the share of that buy actually consumed by the sells, not
 * what the buy cost in full: a lot half sold contributes half its basis. Stage 3
 * expands a window around `slot` in `poolId`, so both are load-bearing rather
 * than decoration.
 */
export interface PositionBuyLeg {
  readonly signature: string;
  readonly slot: bigint;
  /** Unix seconds. */
  readonly blockTime: number;
  readonly venue: Venue;
  readonly poolId: string;
  readonly mint: string;
  /** Base units of this lot consumed by sells. */
  readonly qtyConsumed: bigint;
  /** USD of cost basis this leg contributed to the close. */
  readonly costBasisUsd: number;
  /** False when the venue did not report its fee, so the basis is understated. */
  readonly feeKnown: boolean;
}

/**
 * One open-to-close cycle for a `(wallet, mint)` pair.
 *
 * A wallet that buys, sells out, then buys again has two positions, not one
 * running total. Attribution is per losing position, and merging two cycles
 * would net a win against a loss and attribute the remainder to whoever
 * happened to be in the second window.
 */
export interface Position {
  readonly wallet: string;
  readonly mint: string;
  readonly baseDecimals: number;
  readonly status: PositionStatus;
  readonly basisQuality: BasisQuality;
  /** Unix seconds of the first buy. */
  readonly openTs: number;
  /** Unix seconds of the sell that crossed the dust threshold; null while open. */
  readonly closeTs: number | null;
  /** USD basis consumed by sells. Excludes anything still held. */
  readonly costBasisUsd: number;
  readonly proceedsUsd: number;
  /** `proceedsUsd - costBasisUsd`. Negative is a loss. */
  readonly realisedPnlUsd: number;
  readonly buyCount: number;
  readonly sellCount: number;
  /** Largest quantity ever held, in raw base units. The dust threshold is a share of it. */
  readonly peakQty: bigint;
  /** Raw base units still held. Zero-ish on a closed position, by definition. */
  readonly remainingQty: bigint;
  /** Base units sold with no lot behind them. Non-zero implies `unknown_basis`. */
  readonly unbackedQty: bigint;
  /** The buys behind the closed quantity, oldest first. */
  readonly legs: readonly PositionBuyLeg[];
}

/**
 * True when a position may be attributed from.
 *
 * Spec §2 Stage 2 excludes `unknown_basis`, and §7.3 excludes anything still
 * open — an unrealised loss has not paid anybody yet. A position that did not
 * lose money has nothing to attribute in the first place.
 */
export function isAttributable(position: Position): boolean {
  return (
    position.status === 'closed' &&
    position.basisQuality === 'complete' &&
    position.realisedPnlUsd < 0
  );
}
