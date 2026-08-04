import {
  StorageError,
  toClickHouseDateTime,
  type NormalisedSwap,
  type Venue,
} from '@exitliquidity/core';
import type { ClickHouseClient } from './client.js';

/**
 * The wire form of a `swaps` row.
 *
 * UInt64 columns are sent as strings. JSON numbers are IEEE754 doubles, and a
 * token amount with more than 15 significant digits — routine for a 6-decimal
 * memecoin — would silently round on the way in.
 */
export interface SwapRow {
  mint: string;
  slot: string;
  block_time: string;
  signature: string;
  ix_index: number;
  inner_ix_index: number;
  venue: string;
  pool_id: string;
  wallet: string;
  side: string;
  base_amount: string;
  base_decimals: number;
  quote_amount: string;
  quote_fee_amount: string | null;
  quote_mint: string;
  quote_decimals: number;
  usd_value: number | null;
  usd_price_source: string;
  ingest_source: string;
}

export function toSwapRow(swap: NormalisedSwap): SwapRow {
  return {
    mint: swap.mint,
    slot: swap.slot.toString(),
    block_time: toClickHouseDateTime(swap.blockTime),
    signature: swap.signature,
    ix_index: swap.ixIndex,
    inner_ix_index: swap.innerIxIndex,
    venue: swap.venue,
    pool_id: swap.poolId,
    wallet: swap.wallet,
    side: swap.side,
    base_amount: swap.baseAmount.toString(),
    base_decimals: swap.baseDecimals,
    quote_amount: swap.quoteAmount.toString(),
    quote_fee_amount: swap.quoteFeeAmount === null ? null : swap.quoteFeeAmount.toString(),
    quote_mint: swap.quoteMint,
    quote_decimals: swap.quoteDecimals,
    usd_value: swap.usdValue,
    usd_price_source: swap.usdPriceSource,
    ingest_source: swap.ingestSource,
  };
}

export interface SwapCountFilter {
  readonly mint: string;
  /** Inclusive lower bound, unix seconds. */
  readonly fromSec?: number;
  /** Inclusive upper bound, unix seconds. */
  readonly toSec?: number;
  readonly venue?: Venue;
}

export interface SwapCountBreakdown {
  /** Distinct swap instructions. This is the number to compare against a venue. */
  readonly swaps: number;
  /** Distinct transactions. Dexscreener counts transactions, not instructions. */
  readonly transactions: number;
  readonly buys: number;
  readonly sells: number;
  readonly byVenue: Readonly<Record<string, number>>;
  /** Rows with no USD price, which bound how much of the volume figure is real. */
  readonly unpriced: number;
  readonly firstBlockTime: number | null;
  readonly lastBlockTime: number | null;
}

export interface SkipRow {
  slot: string;
  signature: string;
  venue: string;
  reason: string;
  ix_index: number;
  inner_ix_index: number;
  detail: string;
}

/** Reads and writes for the `swaps` table. */
export class SwapRepository {
  constructor(private readonly client: ClickHouseClient) {}

  async insert(swaps: readonly NormalisedSwap[]): Promise<void> {
    if (swaps.length === 0) return;
    try {
      await this.client.insert({
        table: 'swaps',
        values: swaps.map(toSwapRow),
        format: 'JSONEachRow',
      });
    } catch (error) {
      throw new StorageError(`failed to insert ${swaps.length} swaps`, {
        cause: error,
        context: { rows: swaps.length },
      });
    }
  }

  async insertSkips(skips: readonly SkipRow[]): Promise<void> {
    if (skips.length === 0) return;
    try {
      await this.client.insert({ table: 'ingest_skips', values: skips, format: 'JSONEachRow' });
    } catch (error) {
      throw new StorageError(`failed to record ${skips.length} parse skips`, { cause: error });
    }
  }

  /**
   * Counts swaps for one mint.
   *
   * Counts distinct sort-key tuples rather than rows, and never uses FINAL.
   * `ReplacingMergeTree` only collapses duplicates when parts merge, so a plain
   * `count()` overstates by however much has not merged yet — which would make
   * the P0 acceptance test pass or fail on background merge timing.
   */
  async countByMint(filter: SwapCountFilter): Promise<SwapCountBreakdown> {
    const conditions = ['mint = {mint:String}'];
    const params: Record<string, unknown> = { mint: filter.mint };

    if (filter.fromSec !== undefined) {
      conditions.push('block_time >= {from:DateTime}');
      params['from'] = toClickHouseDateTime(filter.fromSec);
    }
    if (filter.toSec !== undefined) {
      conditions.push('block_time <= {to:DateTime}');
      params['to'] = toClickHouseDateTime(filter.toSec);
    }
    if (filter.venue !== undefined) {
      conditions.push('venue = {venue:String}');
      params['venue'] = filter.venue;
    }

    const where = conditions.join(' AND ');

    const result = await this.client.query({
      query: `
        SELECT
          uniqExact((signature, ix_index, inner_ix_index))                    AS swaps,
          uniqExact(signature)                                                AS transactions,
          uniqExactIf((signature, ix_index, inner_ix_index), side = 'buy')    AS buys,
          uniqExactIf((signature, ix_index, inner_ix_index), side = 'sell')   AS sells,
          uniqExactIf((signature, ix_index, inner_ix_index), usd_value IS NULL) AS unpriced,
          toUnixTimestamp(min(block_time))                                    AS first_block_time,
          toUnixTimestamp(max(block_time))                                    AS last_block_time
        FROM swaps
        WHERE ${where}
      `,
      query_params: params,
      format: 'JSONEachRow',
    });

    const [totals] = await result.json<{
      swaps: string;
      transactions: string;
      buys: string;
      sells: string;
      unpriced: string;
      first_block_time: number;
      last_block_time: number;
    }>();

    const venueResult = await this.client.query({
      query: `
        SELECT venue, uniqExact((signature, ix_index, inner_ix_index)) AS swaps
        FROM swaps
        WHERE ${where}
        GROUP BY venue
        ORDER BY venue
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    const venueRows = await venueResult.json<{ venue: string; swaps: string }>();

    const swaps = Number(totals?.swaps ?? 0);

    return {
      swaps,
      transactions: Number(totals?.transactions ?? 0),
      buys: Number(totals?.buys ?? 0),
      sells: Number(totals?.sells ?? 0),
      unpriced: Number(totals?.unpriced ?? 0),
      byVenue: Object.fromEntries(venueRows.map((row) => [row.venue, Number(row.swaps)])),
      // ClickHouse returns the epoch for min/max over an empty set; reporting
      // that as a real timestamp would be a lie about the data's range.
      firstBlockTime: swaps === 0 ? null : (totals?.first_block_time ?? null),
      lastBlockTime: swaps === 0 ? null : (totals?.last_block_time ?? null),
    };
  }

  /** Skip reasons in a window, so a count shortfall has somewhere to start. */
  async skipSummary(
    fromSec: number,
    toSec: number,
  ): Promise<{ venue: string; reason: string; count: number }[]> {
    const result = await this.client.query({
      query: `
        SELECT venue, reason, count() AS count
        FROM ingest_skips
        WHERE observed_at BETWEEN {from:DateTime} AND {to:DateTime}
        GROUP BY venue, reason
        ORDER BY count DESC
      `,
      query_params: { from: toClickHouseDateTime(fromSec), to: toClickHouseDateTime(toSec) },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ venue: string; reason: string; count: string }>();
    return rows.map((row) => ({ venue: row.venue, reason: row.reason, count: Number(row.count) }));
  }
}
