import { describe, expect, it } from 'vitest';
import type { SolUsdCandle } from '@exitliquidity/core';
import type { PythClient } from '@exitliquidity/pricing';
import { SolUsdCache } from './prices.js';

const MINUTE = 60;
const BASE = 1_700_000_000 - (1_700_000_000 % MINUTE);

function candle(minuteTs: number, close: number): SolUsdCandle {
  return { minuteTs, open: close, high: close, low: close, close };
}

interface Call {
  readonly from: number;
  readonly to: number;
}

/** A Pyth client whose answers are scripted, recording what was asked for. */
function client(answers: (SolUsdCandle[] | Error)[]): { pyth: PythClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const stub = {
    fetchCandles: async (from: number, to: number): Promise<SolUsdCandle[]> => {
      calls.push({ from, to });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
  };
  return { pyth: stub as unknown as PythClient, calls };
}

function cacheFor(answers: (SolUsdCandle[] | Error)[]): {
  cache: SolUsdCache;
  calls: Call[];
} {
  const { pyth, calls } = client(answers);
  return { cache: new SolUsdCache({ client: pyth, maxStalenessSec: 300 }), calls };
}

describe('SolUsdCache', () => {
  it('fetches a range once and serves the rest from memory', async () => {
    const { cache, calls } = cacheFor([[candle(BASE, 100), candle(BASE + MINUTE, 101)]]);

    await cache.ensure(BASE, BASE + MINUTE);
    await cache.ensure(BASE, BASE + MINUTE);

    expect(calls).toHaveLength(1);
    expect(cache.size).toBe(2);
  });

  it('does not latch a range that came back with no bars', async () => {
    /*
     * The bug this exists for. Marking an empty answer as covered was a one-way
     * door: `#gaps` then reported nothing missing for that stretch for the rest
     * of the process's life, so the first `no_data` from Benchmarks left every
     * later trace in that window priced by nothing. Unpriced legs make a
     * position `unpriced`, attribution drops those, and the trace states
     * "nothing closed in the red" — a pricing outage reported as a finding
     * about the wallet, on every wallet, until somebody restarted the service.
     */
    const { cache, calls } = cacheFor([[], [candle(BASE, 100)]]);

    await cache.ensure(BASE, BASE + MINUTE);
    expect(cache.size).toBe(0);

    await cache.ensure(BASE, BASE + MINUTE);
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(1);
  });

  it('does not latch a range whose fetch failed', async () => {
    const { cache, calls } = cacheFor([new Error('429'), [candle(BASE, 100)]]);

    await cache.ensure(BASE, BASE + MINUTE);
    await cache.ensure(BASE, BASE + MINUTE);

    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(1);
  });

  it('reports the minutes it holds, so a trace can say what priced it', async () => {
    const { cache } = cacheFor([[candle(BASE, 100), candle(BASE + MINUTE * 5, 101)]]);

    expect(cache.seriesRange).toBeNull();
    await cache.ensure(BASE, BASE + MINUTE * 5);

    expect(cache.seriesRange).toEqual({
      fromTs: BASE,
      toTs: BASE + MINUTE * 5,
      minutes: 2,
    });
  });

  it('asks only for the ends it is missing', async () => {
    const { cache, calls } = cacheFor([
      [candle(BASE + MINUTE * 10, 100)],
      [candle(BASE, 99)],
      [candle(BASE + MINUTE * 20, 101)],
    ]);

    await cache.ensure(BASE + MINUTE * 10, BASE + MINUTE * 10);
    await cache.ensure(BASE, BASE + MINUTE * 20);

    // One call for the range, then one per end that fell outside it.
    expect(calls).toHaveLength(3);
    expect(calls[1]?.from).toBe(BASE);
    expect(calls[2]?.to).toBe(BASE + MINUTE * 20);
  });

  it('survives a rejection without poisoning the queue behind it', async () => {
    const { cache } = cacheFor([new Error('down'), [candle(BASE, 100)]]);

    // Both start before either resolves, so the second chains onto a rejection.
    await Promise.all([cache.ensure(BASE, BASE), cache.ensure(BASE, BASE)]);
    expect(cache.size).toBe(1);
  });
});
