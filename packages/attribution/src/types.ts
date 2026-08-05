import type { Venue } from '@exitliquidity/core';

/**
 * Why a wallet that was selling into a window is not counted as a counterparty.
 *
 * Spec §2 Stage 3 step 3 calls this list "what separates a real product from
 * noise", and §8 warns which way the failure goes: under-filter and every trace
 * blames the same three bots. Each exclusion is returned alongside the window
 * rather than dropped, so a trace can show its own filtering.
 */
export type ExclusionReason =
  /** The wallet whose loss is being attributed. It cannot be its own counterparty. */
  | 'self'
  /**
   * `|net position change|` inside the window is under `roundTripThreshold` of
   * gross volume — an arb bot or market maker round-tripping, not a distributor.
   */
  | 'round_trip'
  /** On the caller's exclusion list: CEX hot wallets, routers, aggregator vaults. */
  | 'listed'
  /** Every sell the wallet made in the window was unpriced, so it has no weight. */
  | 'unpriced';

export interface WindowExclusion {
  readonly wallet: string;
  readonly reason: ExclusionReason;
  /** Gross USD the wallet sold in the window, before exclusion. */
  readonly sellUsd: number;
}

/** A wallet that was reducing supply into the window, with its computed share. */
export interface WindowCounterparty {
  readonly wallet: string;
  /** USD this wallet sold inside the window. */
  readonly sellUsd: number;
  /** Proximity-weighted volume. Only meaningful relative to the other entries. */
  readonly weight: number;
  /** `weight / Σweight`. Sums to 1 across a window's counterparties. */
  readonly share: number;
  /** Slot of this wallet's nearest sell to the buy leg. */
  readonly nearestSlot: bigint;
  readonly sellCount: number;
}

/**
 * The window a buy leg was netted against. Spec §7.2 requires every attribution
 * to ship with one: pool, slot range and timestamp, so it is checkable rather
 * than asserted.
 */
export interface NettedWindow {
  readonly poolId: string;
  readonly mint: string;
  /** The buy leg this window was expanded around. */
  readonly buySlot: bigint;
  readonly buyTs: number;
  readonly startSlot: bigint;
  readonly endSlot: bigint;
  readonly startTs: number;
  readonly endTs: number;
  /** USD of sell volume the window was expanded to reach. */
  readonly targetUsd: number;
  /** USD of sell volume actually found. Below target means the cap was hit first. */
  readonly sellVolumeUsd: number;
  /** True when expansion stopped at the time cap rather than at the target. */
  readonly capped: boolean;
  readonly counterparties: readonly WindowCounterparty[];
  readonly excluded: readonly WindowExclusion[];
}

/**
 * One row of spec §5's `attributions` table: a dollar figure that is only ever
 * meaningful next to the window it came from.
 */
export interface AttributionRow {
  readonly victim: string;
  readonly counterparty: string;
  readonly mint: string;
  readonly venue: Venue;
  readonly poolId: string;
  readonly windowStartSlot: bigint;
  readonly windowEndSlot: bigint;
  /** Unix seconds of the buy leg the window was built around. */
  readonly windowTs: number;
  readonly attributedUsd: number;
  /** This counterparty's share of the window, in [0, 1]. */
  readonly share: number;
  readonly buyLegSignature: string;
}

/** Every counterparty of one wallet, ranked by dollars. Feeds the trace ledger. */
export interface CounterpartyTotal {
  readonly counterparty: string;
  readonly attributedUsd: number;
  readonly mints: readonly string[];
  readonly rows: readonly AttributionRow[];
}

export interface AttributionResult {
  readonly rows: readonly AttributionRow[];
  /** Sum of `attributedUsd` across every row. */
  readonly attributedUsd: number;
  /**
   * Loss whose buy legs produced no eligible counterparty — no pool activity in
   * range, or everything in the window was filtered out.
   *
   * Reported rather than redistributed. Spreading it over the counterparties
   * that did survive would inflate them by an amount nothing measured.
   */
  readonly unattributedUsd: number;
}
