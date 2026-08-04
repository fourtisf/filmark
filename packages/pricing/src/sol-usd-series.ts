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
    const index = this.#nearestIndex(target);
    if (index === null) return null;

    const minute = this.#minutes[index] as number;
    // Compare against the minute's own start; a bar stamped 12:00 covers
    // 12:00:00-12:00:59, so a swap at 12:00:59 is not 59 seconds stale.
    const ageSec = Math.abs(unixSeconds - minute);
    if (ageSec > this.maxStalenessSec) return null;

    return { usd: this.#closes[index] as number, ageSec };
  }

  /** Index of the minute closest to `target`, by binary search. */
  #nearestIndex(target: number): number | null {
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

    const beforeGap = target - (minutes[before] as number);
    const afterGap = (minutes[after] as number) - target;
    return beforeGap <= afterGap ? before : after;
  }
}
