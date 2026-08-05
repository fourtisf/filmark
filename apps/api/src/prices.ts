import { SECONDS_PER_MINUTE, describeError, silentLogger, type Logger } from '@exitliquidity/core';
import {
  type PythClient,
  SolUsdOracle,
  SolUsdSeries,
  type QuoteOracle,
} from '@exitliquidity/pricing';

export interface SolUsdCacheOptions {
  readonly client: PythClient;
  readonly maxStalenessSec: number;
  readonly logger?: Logger;
}

/**
 * One SOL/USD minute series, shared by every trace the process serves.
 *
 * Traces overlap heavily in time — a memecoin cycle is the same fortnight for
 * everybody who lost money in it — so fetching 90 days of bars per request
 * would re-download the same minutes over and over. This keeps what it has
 * fetched and asks Pyth only for the ends it is missing.
 *
 * Fetches are serialised through `#queue`. Two traces starting together would
 * otherwise both see an empty cache, both request the same quarter of history,
 * and double the load for one series.
 */
export class SolUsdCache {
  readonly #series: SolUsdSeries;
  readonly #client: PythClient;
  readonly #logger: Logger;
  #coveredFrom: number | null = null;
  #coveredTo: number | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: SolUsdCacheOptions) {
    this.#series = new SolUsdSeries(options.maxStalenessSec);
    this.#client = options.client;
    this.#logger = options.logger ?? silentLogger;
  }

  get oracle(): QuoteOracle {
    return new SolUsdOracle(this.#series);
  }

  get size(): number {
    return this.#series.size;
  }

  /**
   * The minutes actually held, so a trace can report what priced it.
   *
   * A trace whose figures are all missing needs to be able to say whether the
   * price series was empty or merely the wrong stretch of history. Without this
   * the two are indistinguishable from the response, and a Pyth outage reads as
   * a wallet that never lost money.
   */
  get seriesRange(): { fromTs: number; toTs: number; minutes: number } | null {
    const range = this.#series.range;
    if (range === null) return null;
    return { fromTs: range.first, toTs: range.last, minutes: this.#series.size };
  }

  /**
   * Guarantees the series covers `[fromTs, toTs]`.
   *
   * A failure here is logged, not thrown: an unpriced swap is still a real swap
   * and still counts (§7.4), so a Pyth outage should cost a trace its dollar
   * figures, not its existence.
   */
  async ensure(fromTs: number, toTs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs < fromTs) return;

    const next = this.#queue.then(() => this.#fill(fromTs, toTs, signal));
    // The queue must survive a rejection, or one failed fetch poisons every
    // later call that chains onto it.
    this.#queue = next.catch(() => undefined);
    await next;
  }

  async #fill(fromTs: number, toTs: number, signal?: AbortSignal): Promise<void> {
    const gaps = this.#gaps(fromTs, toTs);
    if (gaps.length === 0) return;

    let loaded = 0;
    for (const gap of gaps) {
      try {
        const candles = await this.#client.fetchCandles(gap.from, gap.to, signal);
        this.#series.load(candles);
        loaded += candles.length;
      } catch (error) {
        this.#logger.warn(
          { from: gap.from, to: gap.to, err: describeError(error) },
          'SOL/USD candles unavailable; swaps in this range stay unpriced',
        );
        return;
      }
    }

    /*
     * A range that answered with no bars at all is unanswered, not covered.
     *
     * Recording it as covered was a one-way door: `#gaps` then reported nothing
     * missing for that stretch for the rest of the process's life, so the first
     * empty response from Benchmarks — a rate limit answered as `no_data`, a
     * resolution outside its retention — left every later trace in that window
     * priced by nothing. Unpriced legs make a position `unpriced`, which
     * `isAttributable` drops, which the report states as "nothing closed in the
     * red". A pricing outage came out as a finding about the wallet, on every
     * wallet, until somebody restarted the service.
     *
     * The cost of not latching is one retried fetch per trace over a range Pyth
     * genuinely has nothing for. That is the right side to be wrong on.
     */
    if (loaded === 0) {
      this.#logger.warn(
        { from: fromTs, to: toTs },
        'SOL/USD range returned no bars; leaving it uncovered so the next trace retries',
      );
      return;
    }

    this.#coveredFrom = this.#coveredFrom === null ? fromTs : Math.min(this.#coveredFrom, fromTs);
    this.#coveredTo = this.#coveredTo === null ? toTs : Math.max(this.#coveredTo, toTs);
  }

  /**
   * The parts of `[from, to]` not already held.
   *
   * Only the two ends are considered, so the covered region stays a single
   * interval. A request for a range disjoint from what is held widens it to
   * cover both plus the space between; that is one extra fetch now against a
   * fragmented set of ranges to reconcile on every later call.
   */
  #gaps(from: number, to: number): { from: number; to: number }[] {
    if (this.#coveredFrom === null || this.#coveredTo === null) return [{ from, to }];

    const gaps: { from: number; to: number }[] = [];
    if (from < this.#coveredFrom) {
      gaps.push({ from, to: this.#coveredFrom - SECONDS_PER_MINUTE });
    }
    if (to > this.#coveredTo) {
      gaps.push({ from: this.#coveredTo + SECONDS_PER_MINUTE, to });
    }
    return gaps;
  }
}
