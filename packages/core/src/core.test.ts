import { describe, expect, it, vi } from 'vitest';
import {
  decimalStringToRaw,
  fitsInSafeInteger,
  parseUnsignedBigInt,
  quoteToUsd,
  rawToNumber,
} from './amounts.js';
import { RateLimiter, backoffDelay, chunk, mapWithConcurrency, retry, sleep } from './async.js';
import { loadConfig } from './config.js';
import {
  AbortedError,
  ConfigError,
  StorageError,
  UpstreamError,
  describeError,
  isRetryable,
  retryAfterMs,
} from './errors.js';
import { createIngestMetrics, MetricsRegistry } from './metrics.js';
import {
  floorToMinute,
  fromClickHouseDateTime,
  minuteRange,
  sanitiseBlockTime,
  toClickHouseDateTime,
} from './time.js';

describe('rawToNumber', () => {
  it('scales by decimals', () => {
    expect(rawToNumber(1_500_000_000n, 9)).toBe(1.5);
    expect(rawToNumber(42n, 0)).toBe(42);
  });

  it('keeps low digits on a value past double precision', () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2; naive Number()
    // conversion loses the last digit before the division happens.
    expect(rawToNumber(9_007_199_254_740_993n, 9)).toBeCloseTo(9_007_199.254740993, 6);
  });

  it('handles negatives symmetrically', () => {
    expect(rawToNumber(-1_500_000_000n, 9)).toBe(-1.5);
  });

  it('rejects an impossible decimals value', () => {
    expect(() => rawToNumber(1n, -1)).toThrow(RangeError);
    expect(() => rawToNumber(1n, 39)).toThrow(RangeError);
  });
});

describe('quoteToUsd', () => {
  it('multiplies the scaled amount by the unit price', () => {
    expect(quoteToUsd(2_000_000_000n, 9, 200)).toBe(400);
  });

  it('refuses a negative or non-finite price rather than poisoning the column', () => {
    expect(quoteToUsd(1n, 9, -1)).toBeNull();
    expect(quoteToUsd(1n, 9, Number.NaN)).toBeNull();
    expect(quoteToUsd(1n, 9, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null rather than Infinity on overflow', () => {
    expect(quoteToUsd(10n ** 30n, 0, 1e300)).toBeNull();
  });
});

describe('decimalStringToRaw', () => {
  it('parses without touching floating point', () => {
    expect(decimalStringToRaw('1.234', 6)).toBe(1_234_000n);
    expect(decimalStringToRaw('0.000001', 6)).toBe(1n);
    expect(decimalStringToRaw('12', 2)).toBe(1200n);
    expect(decimalStringToRaw('-1.5', 2)).toBe(-150n);
  });

  it('truncates beyond the mint precision, as the chain does', () => {
    expect(decimalStringToRaw('1.9999999', 2)).toBe(199n);
  });

  it('rejects anything that is not a decimal number', () => {
    expect(() => decimalStringToRaw('abc', 2)).toThrow(SyntaxError);
    expect(() => decimalStringToRaw('.', 2)).toThrow(SyntaxError);
  });
});

describe('parseUnsignedBigInt and fitsInSafeInteger', () => {
  it('accepts digits and rejects everything else', () => {
    expect(parseUnsignedBigInt(' 250000000 ', 'slot')).toBe(250_000_000n);
    expect(() => parseUnsignedBigInt('-1', 'slot')).toThrow(SyntaxError);
    expect(() => parseUnsignedBigInt('1.5', 'slot')).toThrow(SyntaxError);
  });

  it('knows what survives a trip through Number', () => {
    expect(fitsInSafeInteger(BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(fitsInSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows from the floor towards the ceiling', () => {
    const first = backoffDelay(0, { minMs: 100, maxMs: 10_000, jitter: 0 });
    const third = backoffDelay(2, { minMs: 100, maxMs: 10_000, jitter: 0 });

    expect(first).toBe(100);
    expect(third).toBe(400);
  });

  it('never exceeds the ceiling', () => {
    expect(backoffDelay(50, { minMs: 100, maxMs: 5000, jitter: 0 })).toBe(5000);
  });

  it('spreads reconnects with jitter', () => {
    const delays = new Set(
      Array.from({ length: 40 }, () => backoffDelay(3, { minMs: 100, maxMs: 10_000, jitter: 0.5 })),
    );
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('retry', () => {
  it('stops at the first success', async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 2) throw new StorageError('transient');
      return 'ok';
    });

    await expect(retry(fn, { maxAttempts: 5, minMs: 1, maxMs: 2 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error marked non-retryable', async () => {
    const fn = vi.fn(async () => {
      throw new ConfigError('bad config');
    });

    await expect(retry(fn, { maxAttempts: 5, minMs: 1, maxMs: 2 })).rejects.toThrow(ConfigError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last error once attempts run out', async () => {
    await expect(
      retry(
        async () => {
          throw new StorageError('always');
        },
        { maxAttempts: 2, minMs: 1, maxMs: 2 },
      ),
    ).rejects.toThrow('always');
  });

  it('abandons immediately on abort', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      retry(async () => 'never', { maxAttempts: 3, minMs: 1, maxMs: 2, signal: controller.signal }),
    ).rejects.toThrow(AbortedError);
  });

  it('rejects a zero attempt budget instead of throwing undefined', async () => {
    // The loop body never runs, so the trailing `throw lastError` used to throw
    // undefined — an error with no name, no message and no stack.
    await expect(
      retry(async () => 'never', { maxAttempts: 0, minMs: 1, maxMs: 2 }),
    ).rejects.toThrow(RangeError);
  });

  it('waits as long as the server asked, not as long as the guess suggested', async () => {
    // A 429 carrying Retry-After: 10 met a 2.3s backoff, so every retry was
    // rejected again on arrival and the attempt budget burned without ever
    // waiting long enough to succeed.
    const delays: number[] = [];
    const throttled = new UpstreamError('HTTP 429', { context: { retryAfter: '10' } });

    await expect(
      retry(
        async () => {
          throw throttled;
        },
        {
          maxAttempts: 2,
          minMs: 1,
          maxMs: 2,
          maxRetryAfterMs: 0, // do not actually sleep ten seconds in a unit test
          onRetry: (_error, _attempt, delayMs) => delays.push(delayMs),
        },
      ),
    ).rejects.toThrow('HTTP 429');

    // With the cap lifted the hint would win outright; this proves it is read.
    expect(retryAfterMs(throttled)).toBe(10_000);
    expect(delays).toHaveLength(1);
  });

  it('reads both Retry-After wire formats and ignores anything else', () => {
    expect(retryAfterMs(new UpstreamError('x', { context: { retryAfter: '30' } }))).toBe(30_000);
    expect(retryAfterMs(new UpstreamError('x', { context: { retryAfter: 5 } }))).toBe(5000);
    expect(retryAfterMs(new UpstreamError('x', { context: { retryAfter: null } }))).toBeUndefined();
    expect(retryAfterMs(new UpstreamError('x'))).toBeUndefined();
    expect(retryAfterMs(new Error('not an AppError'))).toBeUndefined();

    const future = new Date(Date.now() + 20_000).toUTCString();
    const fromDate = retryAfterMs(new UpstreamError('x', { context: { retryAfter: future } }));
    expect(fromDate).toBeGreaterThan(15_000);
  });
});

describe('sleep', () => {
  it('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(AbortedError);
  });
});

describe('RateLimiter', () => {
  it('spaces acquisitions out', async () => {
    const limiter = new RateLimiter(100);
    const started = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('rejects a rate of zero', () => {
    expect(() => new RateLimiter(0)).toThrow(RangeError);
  });

  it('charges a batch for every call it carries, not for the one request', async () => {
    // Batching turned a 10/s limit into 200/s: one HTTP request charged once,
    // carrying twenty RPC calls, against a provider that meters calls. The
    // limiter was raising the rate it existed to hold down.
    const limiter = new RateLimiter(100); // 10ms per unit
    await limiter.acquire(undefined, 20); // 200ms of budget spent

    const started = Date.now();
    await limiter.acquire();

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('rejects a cost below one', async () => {
    await expect(new RateLimiter(10).acquire(undefined, 0)).rejects.toThrow(RangeError);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms, index) => {
      await sleep(ms / 10);
      return index;
    });
    expect(result).toEqual([0, 1, 2]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(1);
        active -= 1;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('stops claiming work once the signal aborts', async () => {
    // The bug this pins: a worker that swallows its own errors used to let the
    // runners walk the entire remaining array after an abort, each item failing
    // instantly with no I/O. One Ctrl+C became one error line per item.
    const controller = new AbortController();
    const items = Array.from({ length: 500 }, (_, i) => i);
    let started = 0;

    const promise = mapWithConcurrency(
      items,
      4,
      async (item) => {
        started += 1;
        if (item === 10) controller.abort();
        // A worker that never rethrows — the shape the backfill runner had.
        try {
          await sleep(1);
        } catch {
          /* swallowed on purpose */
        }
        return item;
      },
      controller.signal,
    );

    await expect(promise).rejects.toBeInstanceOf(AbortedError);
    expect(started).toBeLessThan(items.length);
  });
});

describe('chunk', () => {
  it('splits into fixed sizes with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('time helpers', () => {
  it('floors to the minute and enumerates a range inclusively', () => {
    expect(floorToMinute(1_735_689_659)).toBe(1_735_689_600);
    expect(minuteRange(1_735_689_600, 1_735_689_720)).toEqual([
      1_735_689_600, 1_735_689_660, 1_735_689_720,
    ]);
    expect(() => minuteRange(100, 0)).toThrow(RangeError);
  });

  it('round-trips ClickHouse DateTime text in UTC', () => {
    const formatted = toClickHouseDateTime(1_735_689_600);
    expect(formatted).toBe('2025-01-01 00:00:00');
    expect(fromClickHouseDateTime(formatted)).toBe(1_735_689_600);
    expect(() => fromClickHouseDateTime('not a date')).toThrow(SyntaxError);
  });

  it('rejects a block time that could not be one', () => {
    expect(sanitiseBlockTime(1_735_689_600n)).toBe(1_735_689_600);
    expect(sanitiseBlockTime(0n)).toBeNull();
    expect(sanitiseBlockTime(-1n)).toBeNull();
    expect(sanitiseBlockTime(99_999_999_999n)).toBeNull();
  });
});

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config.CLICKHOUSE_DATABASE).toBe('exitliquidity');
    expect(config.PRICE_MAX_STALENESS_SEC).toBe(300);
    expect(config.YELLOWSTONE_ENDPOINT).toBeUndefined();
  });

  it('treats an empty string as unset, so a blank .env line keeps the default', () => {
    expect(loadConfig({ CLICKHOUSE_DATABASE: '' }).CLICKHOUSE_DATABASE).toBe('exitliquidity');
  });

  it('coerces numbers and booleans out of strings', () => {
    const config = loadConfig({ SOLANA_RPC_MAX_RPS: '25', LOG_PRETTY: 'true' });
    expect(config.SOLANA_RPC_MAX_RPS).toBe(25);
    expect(config.LOG_PRETTY).toBe(true);
  });

  it('reports every problem at once rather than the first', () => {
    let caught: unknown;
    try {
      loadConfig({ CLICKHOUSE_URL: 'not-a-url', METRICS_PORT: '99999' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain('CLICKHOUSE_URL');
    expect((caught as ConfigError).message).toContain('METRICS_PORT');
  });

  it('rejects a malformed Pyth feed id', () => {
    expect(() => loadConfig({ PYTH_SOL_USD_FEED_ID: 'nope' })).toThrow(ConfigError);
  });
});

describe('errors', () => {
  it('classifies retryability by type', () => {
    expect(isRetryable(new StorageError('x'))).toBe(true);
    expect(isRetryable(new ConfigError('x'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });

  it('describes anything thrown without losing the stack', () => {
    expect(describeError(new StorageError('boom', { context: { rows: 3 } }))).toMatchObject({
      code: 'STORAGE',
      retryable: true,
      context: { rows: 3 },
    });
    expect(describeError('a string')).toMatchObject({ name: 'UnknownError', message: 'a string' });
  });

  it('walks the cause chain, which is where the diagnosis actually lives', () => {
    // The shape the RPC client produces: a generic wrapper over the real fault.
    // Without this, six rounds of debugging can read "RPC getTransaction failed"
    // and learn nothing about why.
    const transport = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      syscall: 'read',
    });
    const wrapper = new StorageError('RPC getTransaction failed', { cause: transport });

    const described = describeError(wrapper);

    expect(described).toMatchObject({
      code: 'STORAGE',
      message: 'RPC getTransaction failed',
      cause: { name: 'Error', message: 'read ECONNRESET', code: 'ECONNRESET', syscall: 'read' },
    });
  });

  it('survives a cause that points back at itself', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    expect(describeError(b)).toMatchObject({
      message: 'b',
      cause: { message: 'a', cause: { name: 'CircularCause' } },
    });
  });

  it('does not choke on a thrown null', () => {
    expect(describeError(null)).toMatchObject({ name: 'UnknownError', message: 'null' });
  });
});

describe('metrics', () => {
  it('renders counters and gauges in Prometheus text format', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('swaps_total', 'Swaps');
    counter.inc({ venue: 'pumpfun' }, 3);
    counter.inc({ venue: 'pumpfun' });
    registry.gauge('last_slot', 'Last slot').set(42);

    const output = registry.render();
    expect(output).toContain('# TYPE swaps_total counter');
    expect(output).toContain('swaps_total{venue="pumpfun"} 4');
    expect(output).toContain('last_slot 42');
  });

  it('keys series by label set, not by insertion', () => {
    const counter = new MetricsRegistry().counter('c', 'c');
    counter.inc({ a: '1', b: '2' });
    expect(counter.get({ b: '2', a: '1' })).toBe(1);
  });

  it('escapes label values that would break the exposition format', () => {
    const registry = new MetricsRegistry();
    registry.counter('c', 'c').inc({ detail: 'say "hi"\nagain' });
    expect(registry.render()).toContain('detail="say \\"hi\\"\\nagain"');
  });

  it('refuses to decrease a counter', () => {
    expect(() => {
      new MetricsRegistry().counter('c', 'c').inc({}, -1);
    }).toThrow(RangeError);
  });

  it('emits a zero sample for a metric that has never fired', () => {
    const metrics = createIngestMetrics();
    expect(metrics.registry.render()).toContain('exitliquidity_dropped_total 0');
  });
});
