import { SOL_DECIMALS, USDC_MINT, WSOL_MINT, type SolUsdCandle } from '@exitliquidity/core';
import { describe, expect, it } from 'vitest';
import { NullOracle, SolUsdOracle } from './oracle.js';
import { PythClient } from './pyth.js';
import { SolUsdSeries } from './sol-usd-series.js';

const MINUTE = 60;
const BASE = 1_735_689_600; // 2025-01-01T00:00:00Z, a minute boundary

function candles(...entries: [offsetMinutes: number, close: number][]): SolUsdCandle[] {
  return entries.map(([offset, close]) => ({
    minuteTs: BASE + offset * MINUTE,
    open: close,
    high: close,
    low: close,
    close,
  }));
}

describe('SolUsdSeries', () => {
  it('returns the exact minute when one exists', () => {
    const series = new SolUsdSeries(300);
    series.load(candles([0, 200], [1, 210], [2, 220]));

    expect(series.lookup(BASE + MINUTE + 30)?.usd).toBe(210);
  });

  it('picks the nearest minute in either direction across a gap', () => {
    // Pyth drops bars. The next bar is a better estimate of the price at that
    // instant than one several minutes older.
    const series = new SolUsdSeries(600);
    series.load(candles([0, 200], [5, 250]));

    expect(series.lookup(BASE + 1 * MINUTE)?.usd).toBe(200);
    expect(series.lookup(BASE + 4 * MINUTE)?.usd).toBe(250);
    // A dead heat resolves to the earlier bar, which is already observed.
    expect(series.lookup(BASE + 2.5 * MINUTE)?.usd).toBe(200);
  });

  it('refuses to price beyond the staleness bound', () => {
    const series = new SolUsdSeries(120);
    series.load(candles([0, 200]));

    expect(series.lookup(BASE + 100)).not.toBeNull();
    expect(series.lookup(BASE + 121)).toBeNull();
    expect(series.lookup(BASE - 121)).toBeNull();
  });

  it('reports age from the start of the minute the bar covers', () => {
    const series = new SolUsdSeries(300);
    series.load(candles([0, 200]));

    expect(series.lookup(BASE + 45)?.ageSec).toBe(45);
  });

  it('is empty until loaded and reports its range afterwards', () => {
    const series = new SolUsdSeries(300);
    expect(series.size).toBe(0);
    expect(series.range).toBeNull();
    expect(series.lookup(BASE)).toBeNull();

    series.load(candles([0, 200], [3, 230]));
    expect(series.range).toEqual({ first: BASE, last: BASE + 3 * MINUTE });
  });

  it('merges later loads over earlier ones without losing sort order', () => {
    const series = new SolUsdSeries(300);
    series.load(candles([2, 220], [0, 200]));
    series.load(candles([1, 210], [0, 205]));

    expect(series.size).toBe(3);
    expect(series.lookup(BASE)?.usd).toBe(205);
    expect(series.lookup(BASE + MINUTE)?.usd).toBe(210);
  });

  it('drops non-positive closes rather than pricing a swap at zero', () => {
    const series = new SolUsdSeries(300);
    series.load([
      { minuteTs: BASE, open: 0, high: 0, low: 0, close: 0 },
      { minuteTs: BASE + MINUTE, open: 1, high: 1, low: 1, close: Number.NaN },
    ]);

    expect(series.size).toBe(0);
  });
});

describe('SolUsdOracle', () => {
  const series = new SolUsdSeries(300);
  series.load(candles([0, 200]));
  const oracle = new SolUsdOracle(series);

  it('prices a SOL quote leg off the series', () => {
    const { price } = oracle.price(WSOL_MINT, 1_500_000_000n, SOL_DECIMALS, BASE);
    expect(price).toEqual({ usd: 300, source: 'pyth_1m' });
  });

  it('prices a stablecoin at its peg without consulting the series', () => {
    const { price } = oracle.price(USDC_MINT, 2_500_000n, 6, BASE + 10 * 60 * 60);
    expect(price).toEqual({ usd: 2.5, source: 'stable_peg' });
  });

  it('leaves an unknown quote asset unpriced rather than guessing', () => {
    const outcome = oracle.price('SomeRandomMint1111111111111111111111111111', 1n, 6, BASE);
    expect(outcome.price).toBeNull();
    expect(outcome.reason).toBe('unknown_quote_asset');
  });

  it('leaves a swap outside the series unpriced', () => {
    const outcome = oracle.price(WSOL_MINT, 1_000_000_000n, SOL_DECIMALS, BASE + 3600);
    expect(outcome.price).toBeNull();
    expect(outcome.reason).toBe('no_price_in_range');
  });

  it('keeps full precision on a large raw amount', () => {
    // 12345678.912345678 SOL exceeds what a double holds exactly, so the
    // conversion has to split integer and fractional parts.
    const { price } = oracle.price(WSOL_MINT, 12_345_678_912_345_678n, SOL_DECIMALS, BASE);
    expect(price?.usd).toBeCloseTo(12_345_678.912345678 * 200, 2);
  });

  it('NullOracle prices nothing', () => {
    expect(new NullOracle().price().price).toBeNull();
  });
});

describe('PythClient', () => {
  function clientWith(handler: (url: URL) => unknown): PythClient {
    return new PythClient({
      feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
      maxAttempts: 1,
      fetchImpl: async (input) =>
        new Response(JSON.stringify(handler(new URL(input))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
  }

  it('maps TradingView bars onto minute-aligned candles', async () => {
    const client = clientWith(() => ({
      s: 'ok',
      t: [BASE, BASE + MINUTE],
      o: [200, 210],
      h: [205, 215],
      l: [195, 205],
      c: [202, 212],
    }));

    expect(await client.fetchCandles(BASE, BASE + MINUTE)).toEqual([
      { minuteTs: BASE, open: 200, high: 205, low: 195, close: 202 },
      { minuteTs: BASE + MINUTE, open: 210, high: 215, low: 205, close: 212 },
    ]);
  });

  it('treats no_data as an empty range, not an error', async () => {
    const client = clientWith(() => ({ s: 'no_data' }));
    expect(await client.fetchCandles(BASE, BASE + MINUTE)).toEqual([]);
  });

  it('raises an error status rather than returning a partial series', async () => {
    const client = clientWith(() => ({ s: 'error', errmsg: 'upstream down' }));
    await expect(client.fetchCandles(BASE, BASE + MINUTE)).rejects.toThrow(/upstream down/);
  });

  it('drops bars with no usable close', async () => {
    const client = clientWith(() => ({
      s: 'ok',
      t: [BASE, BASE + MINUTE],
      o: [200, 210],
      h: [205, 215],
      l: [195, 205],
      c: [202, null],
    }));

    expect(await client.fetchCandles(BASE, BASE + MINUTE)).toHaveLength(1);
  });

  it('splits a long range across several requests and merges the results', async () => {
    const requested: [number, number][] = [];
    const client = clientWith((url) => {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      requested.push([from, to]);
      return { s: 'ok', t: [from], o: [1], h: [1], l: [1], c: [1] };
    });

    const candlesOut = await client.fetchCandles(BASE, BASE + 6000 * MINUTE);
    expect(requested.length).toBeGreaterThan(1);
    expect(candlesOut.map((c) => c.minuteTs)).toEqual(
      [...candlesOut.map((c) => c.minuteTs)].sort((a, b) => a - b),
    );
  });

  it('applies the Pyth exponent to the latest price mantissa', async () => {
    const client = clientWith(() => ({
      parsed: [
        {
          id: 'ef0d',
          price: { price: '21234567890', conf: '1000', expo: -8, publish_time: BASE },
        },
      ],
    }));

    expect(await client.fetchLatest()).toEqual({ price: 212.3456789, publishTime: BASE });
  });

  it('returns null when Hermes has no parsed price', async () => {
    expect(await clientWith(() => ({ parsed: [] })).fetchLatest()).toBeNull();
  });
});
