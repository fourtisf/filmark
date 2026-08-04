import {
  SECONDS_PER_MINUTE,
  describeError,
  floorToMinute,
  nowSeconds,
  silentLogger,
  sleep,
  type Logger,
  type SolUsdCandle,
} from '@exitliquidity/core';
import type { SolUsdRepository } from '@exitliquidity/clickhouse';
import type { PythClient, SolUsdSeries } from '@exitliquidity/pricing';

export interface PriceServiceOptions {
  readonly repository: SolUsdRepository;
  readonly pyth: PythClient;
  readonly series: SolUsdSeries;
  readonly logger?: Logger;
}

export interface EnsureRangeResult {
  readonly requestedMinutes: number;
  readonly alreadyStored: number;
  readonly fetched: number;
  readonly stillMissing: number;
}

/** A contiguous run of minutes with no stored candle. */
interface Gap {
  readonly fromSec: number;
  readonly toSec: number;
}

/**
 * Keeps the SOL/USD minute series populated and in memory.
 *
 * Stored in ClickHouse rather than fetched on demand so that pricing is
 * reproducible: a swap re-ingested months later gets the same USD figure it
 * got the first time, which is what makes a PnL reconciliation in P1 mean
 * anything.
 */
export class PriceService {
  readonly #repository: SolUsdRepository;
  readonly #pyth: PythClient;
  readonly #series: SolUsdSeries;
  readonly #logger: Logger;

  constructor(options: PriceServiceOptions) {
    this.#repository = options.repository;
    this.#pyth = options.pyth;
    this.#series = options.series;
    this.#logger = options.logger ?? silentLogger;
  }

  get series(): SolUsdSeries {
    return this.#series;
  }

  /**
   * Makes sure every minute in the range is stored, then loads it into memory.
   *
   * Only the gaps are fetched, so re-running a backfill over a period already
   * covered costs one ClickHouse query and no Pyth traffic.
   */
  async ensureRange(
    fromSec: number,
    toSec: number,
    signal?: AbortSignal,
  ): Promise<EnsureRangeResult> {
    const from = floorToMinute(fromSec);
    const to = floorToMinute(toSec);
    if (to < from) throw new RangeError('toSec must be >= fromSec');

    const requestedMinutes = (to - from) / SECONDS_PER_MINUTE + 1;
    const covered = await this.#repository.coveredMinutes(from, to);
    const gaps = findGaps(from, to, covered);

    let fetched = 0;
    for (const gap of gaps) {
      const candles = await this.#pyth.fetchCandles(gap.fromSec, gap.toSec, signal);
      if (candles.length === 0) {
        // Pyth genuinely has no bar for some minutes. Logging the gap keeps it
        // from looking like a bug when those swaps come back unpriced.
        this.#logger.warn(
          { fromSec: gap.fromSec, toSec: gap.toSec },
          'Pyth returned no SOL/USD candles for a gap',
        );
        continue;
      }
      await this.#repository.insertCandles(candles, 'pyth_benchmarks');
      fetched += candles.length;
    }

    const stored = await this.#repository.loadRange(from, to);
    this.#series.load(stored);

    const result: EnsureRangeResult = {
      requestedMinutes,
      alreadyStored: covered.size,
      fetched,
      stillMissing: Math.max(0, requestedMinutes - stored.length),
    };
    this.#logger.info(result, 'SOL/USD series ready');
    return result;
  }

  /** Loads the last `hours` of stored candles into memory without fetching. */
  async warm(hours: number): Promise<number> {
    const to = nowSeconds();
    const from = to - Math.round(hours * 3600);
    const stored = await this.#repository.loadRange(from, to);
    this.#series.load(stored);
    return stored.length;
  }

  /**
   * Appends the current price to the series on an interval, for the live
   * stream.
   *
   * Hermes gives the latest price directly; Benchmarks lags by a minute or so,
   * which would leave freshly streamed swaps unpriced. Runs until aborted and
   * never throws — pricing degrading to null is survivable, ingest stopping is
   * not.
   */
  async runLiveRefresh(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const latest = await this.#pyth.fetchLatest(signal);
        if (latest !== null) {
          const candle: SolUsdCandle = {
            minuteTs: floorToMinute(latest.publishTime),
            open: latest.price,
            high: latest.price,
            low: latest.price,
            close: latest.price,
          };
          this.#series.load([candle]);
          await this.#repository.insertCandles([candle], 'pyth_hermes');
        }
      } catch (error) {
        this.#logger.warn({ err: describeError(error) }, 'live SOL/USD refresh failed');
      }

      try {
        await sleep(intervalMs, signal);
      } catch {
        return;
      }
    }
  }
}

/** Collapses missing minutes into contiguous runs so each becomes one request. */
export function findGaps(fromSec: number, toSec: number, covered: ReadonlySet<number>): Gap[] {
  const gaps: Gap[] = [];
  let start: number | null = null;

  for (let minute = fromSec; minute <= toSec; minute += SECONDS_PER_MINUTE) {
    const present = covered.has(minute);
    if (!present && start === null) start = minute;
    if (present && start !== null) {
      gaps.push({ fromSec: start, toSec: minute - SECONDS_PER_MINUTE });
      start = null;
    }
  }
  if (start !== null) gaps.push({ fromSec: start, toSec });

  return gaps;
}
