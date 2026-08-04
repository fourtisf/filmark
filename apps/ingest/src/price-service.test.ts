import { SECONDS_PER_MINUTE, type SolUsdCandle } from '@exitliquidity/core';
import type { SolUsdRepository } from '@exitliquidity/clickhouse';
import { PythClient, SolUsdSeries } from '@exitliquidity/pricing';
import { describe, expect, it } from 'vitest';
import { PriceService, findGaps } from './price-service.js';

const BASE = 1_735_689_600;
const M = SECONDS_PER_MINUTE;

describe('findGaps', () => {
  it('returns one gap for a fully empty range', () => {
    expect(findGaps(BASE, BASE + 2 * M, new Set())).toEqual([
      { fromSec: BASE, toSec: BASE + 2 * M },
    ]);
  });

  it('returns nothing when everything is covered', () => {
    const covered = new Set([BASE, BASE + M, BASE + 2 * M]);
    expect(findGaps(BASE, BASE + 2 * M, covered)).toEqual([]);
  });

  it('collapses adjacent missing minutes into one request', () => {
    // The point of the function: 500 missing minutes should be one Pyth call,
    // not 500.
    const covered = new Set([BASE, BASE + 4 * M]);
    expect(findGaps(BASE, BASE + 4 * M, covered)).toEqual([
      { fromSec: BASE + M, toSec: BASE + 3 * M },
    ]);
  });

  it('finds several separate gaps', () => {
    const covered = new Set([BASE + M, BASE + 3 * M]);
    expect(findGaps(BASE, BASE + 4 * M, covered)).toEqual([
      { fromSec: BASE, toSec: BASE },
      { fromSec: BASE + 2 * M, toSec: BASE + 2 * M },
      { fromSec: BASE + 4 * M, toSec: BASE + 4 * M },
    ]);
  });

  it('handles a gap that runs to the end of the range', () => {
    expect(findGaps(BASE, BASE + 2 * M, new Set([BASE]))).toEqual([
      { fromSec: BASE + M, toSec: BASE + 2 * M },
    ]);
  });
});

interface FakeRepository extends SolUsdRepository {
  inserted: SolUsdCandle[];
  sources: string[];
}

function fakeRepository(stored: SolUsdCandle[] = []): FakeRepository {
  const rows = [...stored];
  const inserted: SolUsdCandle[] = [];
  const sources: string[] = [];

  return {
    inserted,
    sources,
    async insertCandles(candles, source) {
      inserted.push(...candles);
      sources.push(source);
      rows.push(...candles);
    },
    async loadRange(fromSec, toSec) {
      return rows
        .filter((row) => row.minuteTs >= fromSec && row.minuteTs <= toSec)
        .sort((a, b) => a.minuteTs - b.minuteTs);
    },
    async coveredMinutes(fromSec, toSec) {
      return new Set(
        rows.filter((r) => r.minuteTs >= fromSec && r.minuteTs <= toSec).map((r) => r.minuteTs),
      );
    },
    async latestMinute() {
      return rows.length === 0 ? null : Math.max(...rows.map((r) => r.minuteTs));
    },
  } as unknown as FakeRepository;
}

function candle(minuteTs: number, close: number): SolUsdCandle {
  return { minuteTs, open: close, high: close, low: close, close };
}

function pythReturning(candles: SolUsdCandle[], onRequest?: (from: number, to: number) => void) {
  return new PythClient({
    feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    maxAttempts: 1,
    fetchImpl: async (input) => {
      const url = new URL(input);
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      onRequest?.(from, to);
      const inRange = candles.filter((c) => c.minuteTs >= from && c.minuteTs <= to);
      return new Response(
        JSON.stringify(
          inRange.length === 0
            ? { s: 'no_data' }
            : {
                s: 'ok',
                t: inRange.map((c) => c.minuteTs),
                o: inRange.map((c) => c.open),
                h: inRange.map((c) => c.high),
                l: inRange.map((c) => c.low),
                c: inRange.map((c) => c.close),
              },
        ),
        { status: 200 },
      );
    },
  });
}

describe('PriceService.ensureRange', () => {
  it('fetches only the minutes that are missing', async () => {
    const repository = fakeRepository([candle(BASE, 200), candle(BASE + 2 * M, 202)]);
    const requests: [number, number][] = [];
    const service = new PriceService({
      repository,
      pyth: pythReturning([candle(BASE + M, 201)], (from, to) => requests.push([from, to])),
      series: new SolUsdSeries(300),
    });

    const result = await service.ensureRange(BASE, BASE + 2 * M);

    expect(requests).toEqual([[BASE + M, BASE + M]]);
    expect(result).toEqual({ requestedMinutes: 3, alreadyStored: 2, fetched: 1, stillMissing: 0 });
  });

  it('makes no Pyth request at all when the range is already stored', async () => {
    const repository = fakeRepository([candle(BASE, 200), candle(BASE + M, 201)]);
    const requests: [number, number][] = [];
    const service = new PriceService({
      repository,
      pyth: pythReturning([], (from, to) => requests.push([from, to])),
      series: new SolUsdSeries(300),
    });

    await service.ensureRange(BASE, BASE + M);
    expect(requests).toEqual([]);
  });

  it('loads what it fetched into the in-memory series', async () => {
    const series = new SolUsdSeries(300);
    const service = new PriceService({
      repository: fakeRepository(),
      pyth: pythReturning([candle(BASE, 250)]),
      series,
    });

    await service.ensureRange(BASE, BASE);
    expect(series.lookup(BASE)?.usd).toBe(250);
  });

  it('reports minutes Pyth simply does not have, rather than inventing them', async () => {
    const service = new PriceService({
      repository: fakeRepository(),
      pyth: pythReturning([candle(BASE, 200)]),
      series: new SolUsdSeries(300),
    });

    const result = await service.ensureRange(BASE, BASE + 2 * M);
    expect(result.fetched).toBe(1);
    expect(result.stillMissing).toBe(2);
  });

  it('tags stored candles with the endpoint they came from', async () => {
    const repository = fakeRepository();
    const service = new PriceService({
      repository,
      pyth: pythReturning([candle(BASE, 200)]),
      series: new SolUsdSeries(300),
    });

    await service.ensureRange(BASE, BASE);
    expect(repository.sources).toEqual(['pyth_benchmarks']);
  });

  it('rejects a backwards range instead of silently fetching nothing', async () => {
    const service = new PriceService({
      repository: fakeRepository(),
      pyth: pythReturning([]),
      series: new SolUsdSeries(300),
    });

    await expect(service.ensureRange(BASE + M, BASE)).rejects.toThrow(RangeError);
  });
});

describe('PriceService.warm', () => {
  it('loads stored candles without fetching', async () => {
    const now = Math.floor(Date.now() / 1000);
    const series = new SolUsdSeries(300);
    const service = new PriceService({
      repository: fakeRepository([candle(now - (now % M), 199)]),
      pyth: pythReturning([]),
      series,
    });

    expect(await service.warm(1)).toBe(1);
    expect(series.size).toBe(1);
  });
});
