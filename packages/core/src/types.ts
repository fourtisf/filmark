/**
 * The shapes that cross package boundaries.
 *
 * `NormalisedSwap` is the row described in spec §5. Everything upstream of the
 * writer exists to produce it, and everything downstream reads nothing else.
 */

/** A venue we can parse. Stored as a `LowCardinality(String)` column. */
export type Venue = 'pumpfun' | 'pumpswap';

export const VENUES: readonly Venue[] = ['pumpfun', 'pumpswap'] as const;

/**
 * Direction from the trader's point of view, relative to `mint`.
 * `buy` = wallet acquired `mint` and paid `quoteMint`.
 */
export type Side = 'buy' | 'sell';

/** Where a row's `usdValue` came from. Recorded so bad prices stay traceable. */
export type UsdPriceSource =
  /** No price within tolerance; `usdValue` is null. */
  | 'none'
  /** Interpolated/nearest point from the Pyth SOL/USD 1-minute series. */
  | 'pyth_1m'
  /** Quote asset is a dollar stablecoin, priced at its peg. */
  | 'stable_peg';

/** How a swap reached us. Useful when reconciling stream against backfill. */
export type IngestSource = 'stream' | 'backfill';

/**
 * A swap as the venue parser sees it: identities and raw on-chain amounts,
 * no pricing, decimals possibly still unknown.
 */
export interface ParsedSwap {
  readonly signature: string;
  readonly slot: bigint;
  /** Unix seconds. Null when the transaction source could not supply one. */
  readonly blockTime: number | null;
  readonly venue: Venue;
  /** Bonding curve address for pumpfun, pool address for pumpswap. */
  readonly poolId: string;
  /** The non-quote side of the pair — the asset the trade is *about*. */
  readonly mint: string;
  /** The trader. Taken from the event payload, not from the fee payer. */
  readonly wallet: string;
  readonly side: Side;
  /** Raw base units of `mint`, before decimals are applied. */
  readonly baseAmount: bigint;
  readonly baseDecimals: number | null;
  /**
   * Quote tokens that moved against the pool, in raw units, excluding fees.
   *
   * Always the pool leg, on every venue. Stage 3 nets pool volume, so the
   * column has to mean the same thing everywhere; the trader's own cash flow
   * is `quoteAmount + quoteFeeAmount` on a buy and `quoteAmount -
   * quoteFeeAmount` on a sell.
   */
  readonly quoteAmount: bigint;
  /**
   * Quote-denominated fees around this swap, or null when the venue's event
   * does not expose them. Null means unknown, never zero.
   */
  readonly quoteFeeAmount: bigint | null;
  readonly quoteMint: string;
  readonly quoteDecimals: number | null;
  /** Index of the top-level instruction this swap was executed under. */
  readonly ixIndex: number;
  /** Index within that instruction's inner list, or -1 if it *is* the top-level one. */
  readonly innerIxIndex: number;
}

/**
 * A `ParsedSwap` with every unknown resolved: decimals filled in, block time
 * stamped, quote leg priced. This is exactly one row of the `swaps` table.
 */
export interface NormalisedSwap {
  readonly signature: string;
  readonly slot: bigint;
  /** Unix seconds, UTC. */
  readonly blockTime: number;
  readonly venue: Venue;
  readonly poolId: string;
  readonly mint: string;
  readonly wallet: string;
  readonly side: Side;
  readonly baseAmount: bigint;
  readonly baseDecimals: number;
  /** Pool-leg quote amount, raw units, fees excluded. See `ParsedSwap`. */
  readonly quoteAmount: bigint;
  /** Quote-denominated fees, or null when the venue does not report them. */
  readonly quoteFeeAmount: bigint | null;
  readonly quoteMint: string;
  readonly quoteDecimals: number;
  /** USD value of `quoteAmount`. Null when the quote leg could not be priced. */
  readonly usdValue: number | null;
  readonly usdPriceSource: UsdPriceSource;
  readonly ixIndex: number;
  readonly innerIxIndex: number;
  readonly ingestSource: IngestSource;
}

/** One minute of SOL/USD, from Pyth. Close is what we price against. */
export interface SolUsdCandle {
  /** Unix seconds, truncated to the minute. */
  readonly minuteTs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** A resolved price for a quote leg. */
export interface QuotePrice {
  readonly usd: number;
  readonly source: UsdPriceSource;
}

/** Where a stream or backfill run has got to. */
export interface Checkpoint {
  readonly name: string;
  readonly slot: bigint;
  readonly updatedAt: Date;
}

/** Cached mint metadata, so decimals lookups do not hit RPC twice. */
export interface MintInfo {
  readonly mint: string;
  readonly decimals: number;
}
