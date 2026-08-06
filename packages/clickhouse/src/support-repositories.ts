import {
  StorageError,
  toClickHouseDateTime,
  type Checkpoint,
  type MintInfo,
  type SolUsdCandle,
} from '@exitliquidity/core';
import type { ClickHouseClient } from './client.js';

/** Resume points for the stream and for each backfill target. */
export class CheckpointRepository {
  constructor(private readonly client: ClickHouseClient) {}

  async get(name: string): Promise<Checkpoint | null> {
    const result = await this.client.query({
      // FINAL: checkpoints are written constantly and read once at startup, so
      // reading a superseded row would rewind ingest.
      query: `
        SELECT name, slot, toUnixTimestamp(updated_at) AS updated_at
        FROM ingest_checkpoints FINAL
        WHERE name = {name:String}
      `,
      query_params: { name },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ name: string; slot: string; updated_at: number }>();
    if (row === undefined) return null;
    return { name: row.name, slot: BigInt(row.slot), updatedAt: new Date(row.updated_at * 1000) };
  }

  async set(name: string, slot: bigint): Promise<void> {
    try {
      await this.client.insert({
        table: 'ingest_checkpoints',
        values: [{ name, slot: slot.toString() }],
        format: 'JSONEachRow',
      });
    } catch (error) {
      throw new StorageError(`failed to write checkpoint ${name}`, {
        cause: error,
        context: { name, slot: slot.toString() },
      });
    }
  }
}

/** What a backfill covered for one wallet. */
export interface WalletCoverage {
  readonly wallet: string;
  /** Unix seconds. The window the backfill was asked for and reached. */
  readonly fromTs: number;
  readonly toTs: number;
  readonly swaps: number;
  /** False when the crawl ran with no usable price series behind it. */
  readonly pricesReady: boolean;
  readonly updatedAt: number;
}

/**
 * Which wallets the index can answer for, and over what window.
 *
 * `swaps` alone cannot answer that: a wallet with no rows is either one that
 * never traded on a parsed venue or one nobody has backfilled, and serving the
 * first answer for the second case is a fabricated finding. A reader consults
 * this first and goes to the chain when the window it wants is not covered.
 */
export class WalletCoverageRepository {
  constructor(private readonly client: ClickHouseClient) {}

  async get(wallet: string): Promise<WalletCoverage | null> {
    const result = await this.client.query({
      // FINAL: a re-backfill supersedes the previous row, and reading the older
      // one would claim a narrower window than the index actually holds.
      query: `
        SELECT
          wallet,
          toUnixTimestamp(from_ts)    AS from_ts,
          toUnixTimestamp(to_ts)      AS to_ts,
          swaps,
          prices_ready,
          toUnixTimestamp(updated_at) AS updated_at
        FROM wallet_coverage FINAL
        WHERE wallet = {wallet:String}
      `,
      query_params: { wallet },
      format: 'JSONEachRow',
    });

    const [row] = await result.json<{
      wallet: string;
      from_ts: number;
      to_ts: number;
      swaps: string | number;
      prices_ready: number;
      updated_at: number;
    }>();
    if (row === undefined) return null;

    return {
      wallet: row.wallet,
      fromTs: row.from_ts,
      toTs: row.to_ts,
      swaps: Number(row.swaps),
      pricesReady: row.prices_ready === 1,
      updatedAt: row.updated_at,
    };
  }

  async record(coverage: Omit<WalletCoverage, 'updatedAt'>): Promise<void> {
    try {
      await this.client.insert({
        table: 'wallet_coverage',
        values: [
          {
            wallet: coverage.wallet,
            from_ts: toClickHouseDateTime(coverage.fromTs),
            to_ts: toClickHouseDateTime(coverage.toTs),
            swaps: coverage.swaps,
            prices_ready: coverage.pricesReady ? 1 : 0,
          },
        ],
        format: 'JSONEachRow',
      });
    } catch (error) {
      throw new StorageError(`failed to record coverage for ${coverage.wallet}`, {
        cause: error,
        context: { wallet: coverage.wallet },
      });
    }
  }
}

/** The SOL/USD minute series backing quote-leg pricing. */
export class SolUsdRepository {
  constructor(private readonly client: ClickHouseClient) {}

  async insertCandles(candles: readonly SolUsdCandle[], source: string): Promise<void> {
    if (candles.length === 0) return;
    try {
      await this.client.insert({
        table: 'sol_usd_1m',
        values: candles.map((candle) => ({
          minute_ts: toClickHouseDateTime(candle.minuteTs),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          source,
        })),
        format: 'JSONEachRow',
      });
    } catch (error) {
      throw new StorageError(`failed to insert ${candles.length} SOL/USD candles`, {
        cause: error,
      });
    }
  }

  async loadRange(fromSec: number, toSec: number): Promise<SolUsdCandle[]> {
    const result = await this.client.query({
      query: `
        SELECT
          toUnixTimestamp(minute_ts) AS minute_ts,
          argMax(open, updated_at)   AS open,
          argMax(high, updated_at)   AS high,
          argMax(low, updated_at)    AS low,
          argMax(close, updated_at)  AS close
        FROM sol_usd_1m
        WHERE minute_ts BETWEEN {from:DateTime} AND {to:DateTime}
        GROUP BY minute_ts
        ORDER BY minute_ts
      `,
      query_params: { from: toClickHouseDateTime(fromSec), to: toClickHouseDateTime(toSec) },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{
      minute_ts: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }>();
    return rows.map((row) => ({
      minuteTs: row.minute_ts,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }));
  }

  /** Minute buckets already stored in a range, so a backfill only fetches gaps. */
  async coveredMinutes(fromSec: number, toSec: number): Promise<Set<number>> {
    const candles = await this.loadRange(fromSec, toSec);
    return new Set(candles.map((candle) => candle.minuteTs));
  }

  async latestMinute(): Promise<number | null> {
    const result = await this.client.query({
      query: 'SELECT toUnixTimestamp(max(minute_ts)) AS latest, count() AS rows FROM sol_usd_1m',
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ latest: number; rows: string }>();
    if (row === undefined || Number(row.rows) === 0) return null;
    return row.latest;
  }
}

/** Cached mint decimals, so a backfill does not re-ask RPC for known values. */
export class MintRepository {
  constructor(private readonly client: ClickHouseClient) {}

  async getMany(mints: readonly string[]): Promise<Map<string, number>> {
    if (mints.length === 0) return new Map();
    const result = await this.client.query({
      query: `
        SELECT mint, argMax(decimals, updated_at) AS decimals
        FROM mints
        WHERE mint IN {mints:Array(String)}
        GROUP BY mint
      `,
      query_params: { mints: [...mints] },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ mint: string; decimals: number }>();
    return new Map(rows.map((row) => [row.mint, row.decimals]));
  }

  async upsertMany(mints: readonly MintInfo[]): Promise<void> {
    if (mints.length === 0) return;
    try {
      await this.client.insert({ table: 'mints', values: [...mints], format: 'JSONEachRow' });
    } catch (error) {
      throw new StorageError(`failed to cache ${mints.length} mints`, { cause: error });
    }
  }
}
