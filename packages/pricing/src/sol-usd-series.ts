import { floorToMinute, type SolUsdCandle } from '@exitliquidity/core';

export interface SeriesLookup {
  readonly usd: number;
  /** Seconds between the requested time and the minute that answered it. */
  readonly ageSec: number;
}

/**
 * A sorted, in-memory SOL/USD minute series with a bounded-staleness lookup.
 *
 * A swap is priced at the nearest minute in either direction, not the last one
 * before it: Pyth occasionally drops a bar, and on a quiet minute the next bar
 * is a better estimate of the price at that instant than one several minutes
 * stale. Beyond `maxStalenessSec` nothing is returned at all.
 */
export class SolUsdSeries {
  #minutes: number[] = [];
  #closes: number[] = [];

  constructor(private readonly maxStalenessSec: number) {
    if (maxStalenessSec <= 0) throw new RangeError('maxStalenessSec must be > 0');
  }

  get size(): number {
    return this.#minutes.length;
  }

  get range(): { first: number; last: number } | null {
    if (this.#minutes.length === 0) return null;
    return {
      first: this.#minutes[0] as number,
      last: this.#minutes[this.#minutes.length - 1] as number,
    };
  }

  /** Adds candles, replacing any minute already held. */
  load(candles: readonly SolUsdCandle[]): void {
    if (candles.length === 0) return;

    const merged = new Map<number, number>();
    for (let i = 0; i < this.#minutes.length; i += 1) {
      merged.set(this.#minutes[i] as number, this.#closes[i] as number);
    }
    for (const candle of candles) {
      if (Number.isFinite(candle.close) && candle.close > 0) {
        merged.set(candle.minuteTs, candle.close);
      }
    }

    const minutes = [...merged.keys()].sort((a, b) => a - b);
    this.#minutes = minutes;
    this.#closes = minutes.map((minute) => merged.get(minute) as number);
  }

  /** Price at `unixSeconds`, or null when no minute is close enough. */
  lookup(unixSeconds: number): SeriesLookup | null {
    if (this.#minutes.length === 0) return null;

    const target = floorToMinute(unixSeconds);
    const index = this.#nearestIndex(target, unixSeconds);
    if (index === null) return null;

    const minute = this.#minutes[index] as number;
    // Distance from the swap's own instant to the bar's minute start. A bar
    // stamped 12:00 is the price at 12:00, so a swap at 12:00:59 is 59 seconds
    // from it — the staleness bound is about how far the price has had to
    // travel, not about which minute bucket the swap fell into.
    const ageSec = Math.abs(unixSeconds - minute);
    if (ageSec > this.maxStalenessSec) return null;

    return { usd: this.#closes[index] as number, ageSec };
  }

  /**
   * Index of the minute closest to the swap, by binary search.
   *
   * `target` is the floored minute, which is what the index is keyed by;
   * `unixSeconds` is the swap's own instant, which is what "closest" has to be
   * measured from. Comparing gaps from the floored minute discards up to 59
   * seconds and biases every tie towards the earlier bar: a swap at 1:59 with
   * bars at 0:00 and 2:00 was given the bar two minutes behind it rather than
   * the one a second ahead. At the staleness edge it did worse than pick the
   * wrong bar — it returned null and left a priceable swap unpriced.
   */
  #nearestIndex(target: number, unixSeconds: number): number | null {
    const minutes = this.#minutes;
    let low = 0;
    let high = minutes.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = minutes[mid] as number;
      if (value === target) return mid;
      if (value < target) low = mid + 1;
      else high = mid - 1;
    }

    // `low` is the first minute after the target, `high` the last before it.
    const before = high >= 0 ? high : null;
    const after = low < minutes.length ? low : null;

    if (before === null) return after;
    if (after === null) return before;

    const beforeGap = Math.abs(unixSeconds - (minutes[before] as number));
    const afterGap = Math.abs(unixSeconds - (minutes[after] as number));
    return beforeGap <= afterGap ? before : after;
  }
}
