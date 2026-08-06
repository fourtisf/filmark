import {
  RateLimiter,
  SECONDS_PER_MINUTE,
  UpstreamError,
  describeError,
  floorToMinute,
  mapWithConcurrency,
  retry,
  silentLogger,
  type Logger,
  type SolUsdCandle,
} from '@exitliquidity/core';

/**
 * Pyth clients.
 *
 * Two endpoints, because they answer different questions. Benchmarks returns
 * historical bars in bulk, which is what a 90-day backfill needs; Hermes
 * returns the current price, which is what a live stream needs. Fetching
 * history one minute at a time from Hermes would be ~130k requests for the
 * default backfill window.
 */

export const SOL_USD_SYMBOL = 'Crypto.SOL/USD';

/** Minutes per Benchmarks request. The API rejects unbounded ranges. */
const MAX_BARS_PER_REQUEST = 5000;

/** Benchmarks requests in flight at once. Shared public endpoint; keep it modest. */
const BENCHMARKS_CONCURRENCY = 4;

/** Longest a `Retry-After` may hold the client back, so nobody can park it. */
const MAX_PAUSE_MS = 120_000;

/**
 * The request windows covering `[fromSec, toSec]`, computed rather than listed.
 *
 * Materialising every minute to chunk it allocated an entry per minute — half a
 * million of them for a year — to derive a number of windows that arithmetic
 * gives directly.
 */
function candleWindows(fromSec: number, toSec: number): { from: number; to: number }[] {
  const first = floorToMinute(fromSec);
  const last = floorToMinute(toSec);
  const span = MAX_BARS_PER_REQUEST * SECONDS_PER_MINUTE;

  const windows: { from: number; to: number }[] = [];
  for (let start = first; start <= last; start += span) {
    windows.push({ from: start, to: Math.min(last, start + span - SECONDS_PER_MINUTE) });
  }
  return windows;
}

export interface PythClientOptions {
  readonly benchmarksUrl?: string;
  readonly hermesUrl?: string;
  readonly feedId?: string;
  /** Requests a second to Benchmarks. It is public and shared; keep it modest. */
  readonly maxRequestsPerSecond?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
}

interface TradingViewHistory {
  s: 'ok' | 'no_data' | 'error';
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  errmsg?: string;
}

interface HermesLatest {
  parsed?: {
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }[];
}

export class PythClient {
  readonly #benchmarksUrl: string;
  readonly #hermesUrl: string;
  readonly #feedId: string;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #limiter: RateLimiter;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;

  constructor(options: PythClientOptions = {}) {
    /*
     * Benchmarks was the one upstream here with no limiter at all.
     *
     * That was survivable while the windows ran one after another — the round
     * trip was the pacing. Overlapping them removed it, and a 60-day backfill
     * went straight into `HTTP 429` on every attempt and took the whole run
     * with it. A shared public endpoint deserves the same manners as a metered
     * one: a rate, and a client that slows when it is told to.
     */
    this.#limiter = new RateLimiter(options.maxRequestsPerSecond ?? 3);
    this.#benchmarksUrl = (options.benchmarksUrl ?? 'https://benchmarks.pyth.network').replace(
      /\/$/,
      '',
    );
    this.#hermesUrl = (options.hermesUrl ?? 'https://hermes.pyth.network').replace(/\/$/, '');
    this.#feedId = (options.feedId ?? '').replace(/^0x/, '');
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * One-minute SOL/USD bars covering `[fromSec, toSec]`.
   *
   * Requests are chunked and the results merged, so the caller can ask for a
   * quarter of history in one call — but the chunk count grows with the range,
   * and a year is 106 of them. Run one after another that is a minute of wall
   * clock spent inside a trace that has three, before a single swap has been
   * priced; a live service widened its lookback from 90 days to 365 and paid
   * for it here rather than at the RPC endpoint it was watching. A small
   * concurrency is what makes the range a caller asks for and the time it costs
   * stop being the same number.
   *
   * Bounded rather than unbounded: Benchmarks is a shared public endpoint and
   * a hundred simultaneous requests is how a client earns a rate limit.
   *
   * One window failing does not discard the rest. A year is 106 requests and
   * the odds that all of them succeed are not the odds that one does; throwing
   * on the first failure threw away a hundred good windows with it, and left
   * the series empty — which reads downstream as a wallet whose every swap was
   * unpriceable. The series is sparse by design and a minute it does not hold
   * returns null rather than a guess, so a hole is already something the
   * staleness bound handles honestly. Only a range where *nothing* could be
   * fetched raises, because that is a failure rather than a gap.
   */
  async fetchCandles(
    fromSec: number,
    toSec: number,
    signal?: AbortSignal,
  ): Promise<SolUsdCandle[]> {
    if (toSec < fromSec) throw new RangeError('toSec must be >= fromSec');

    const windows = candleWindows(fromSec, toSec);
    const failures: unknown[] = [];

    const pages = await mapWithConcurrency(
      windows,
      Math.min(BENCHMARKS_CONCURRENCY, windows.length) || 1,
      async (window) => {
        try {
          return await this.#fetchWindow(window.from, window.to, signal);
        } catch (error) {
          // An abort is the caller leaving, not a window failing; it must not
          // be absorbed into a partial answer.
          if (signal?.aborted === true) throw error;
          failures.push(error);
          return [];
        }
      },
      signal,
    );

    if (failures.length === windows.length) throw failures[0];
    if (failures.length > 0) {
      this.#logger.warn(
        { windows: windows.length, failed: failures.length, err: describeError(failures[0]) },
        'some SOL/USD windows could not be fetched; the series will have holes in it',
      );
    }

    const byMinute = new Map<number, SolUsdCandle>();
    for (const page of pages) {
      for (const candle of page) byMinute.set(candle.minuteTs, candle);
    }

    return [...byMinute.values()].sort((a, b) => a.minuteTs - b.minuteTs);
  }

  async #fetchWindow(
    fromSec: number,
    toSec: number,
    signal?: AbortSignal,
  ): Promise<SolUsdCandle[]> {
    const url = new URL('/v1/shims/tradingview/history', this.#benchmarksUrl);
    url.searchParams.set('symbol', SOL_USD_SYMBOL);
    url.searchParams.set('resolution', '1');
    url.searchParams.set('from', String(fromSec));
    url.searchParams.set('to', String(toSec));

    const body = await this.#getJson<TradingViewHistory>(url, signal);

    if (body.s === 'no_data') return [];
    if (body.s !== 'ok') {
      throw new UpstreamError(`Pyth Benchmarks returned ${body.s}: ${body.errmsg ?? 'no detail'}`, {
        context: { fromSec, toSec },
      });
    }

    const { t = [], o = [], h = [], l = [], c = [] } = body;
    const candles: SolUsdCandle[] = [];
    for (let i = 0; i < t.length; i += 1) {
      const close = c[i];
      // A bar with no close cannot price anything; dropping it leaves a gap the
      // staleness bound can reason about, which is better than a zero.
      if (close === undefined || !Number.isFinite(close)) continue;
      candles.push({
        minuteTs: floorToMinute(t[i] as number),
        open: o[i] ?? close,
        high: h[i] ?? close,
        low: l[i] ?? close,
        close,
      });
    }
    return candles;
  }

  /** The current SOL/USD price, for pricing swaps as they stream in. */
  async fetchLatest(signal?: AbortSignal): Promise<{ price: number; publishTime: number } | null> {
    if (this.#feedId === '') {
      throw new UpstreamError('a Pyth feed id is required to fetch the latest price');
    }

    const url = new URL('/v2/updates/price/latest', this.#hermesUrl);
    url.searchParams.append('ids[]', this.#feedId);

    const body = await this.#getJson<HermesLatest>(url, signal);
    const entry = body.parsed?.[0];
    if (entry === undefined) return null;

    // Pyth reports a mantissa and a base-10 exponent, never a float.
    const price = Number(entry.price.price) * 10 ** entry.price.expo;
    if (!Number.isFinite(price) || price <= 0) return null;

    return { price, publishTime: entry.price.publish_time };
  }

  async #getJson<T>(url: URL, signal?: AbortSignal): Promise<T> {
    return retry(
      async (attempt) => {
        await this.#limiter.acquire(signal);
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, this.#timeoutMs);
        const onAbort = (): void => {
          controller.abort();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
          const response = await this.#fetch(url, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          });
          if (!response.ok) {
            // Same bargain as the RPC client: the endpoint's refusal outranks
            // the configured rate, and retrying at the pace just rejected only
            // spends the attempts finding that out again.
            if (response.status === 429) {
              /*
               * Benchmarks meters over a window, not per second: it answers
               * `Retry-After: 58`. Halving a rate already under one request a
               * second is not what it is asking for — it wants to be left alone
               * until the window rolls, and every call queued behind this one
               * would otherwise walk straight into the same wall. Honour the
               * number it gave, bounded so a provider cannot park the process.
               */
              const wait = Math.min(
                MAX_PAUSE_MS,
                Number(response.headers.get('retry-after') ?? 0) * 1000,
              );
              this.#limiter.pause(wait);
              this.#limiter.backOff();
              this.#logger.warn(
                {
                  url: url.pathname,
                  rate: Number(this.#limiter.effectiveRate.toFixed(2)),
                  pausedMs: wait,
                },
                'Pyth rate limited; pausing for as long as it asked and slowing below the configured rate',
              );
            }
            throw new UpstreamError(`Pyth request failed with HTTP ${response.status}`, {
              context: {
                url: url.pathname,
                status: response.status,
                attempt,
                retryAfter: response.headers.get('retry-after'),
              },
            });
          }
          const parsed = (await response.json()) as T;
          this.#limiter.recover();
          return parsed;
        } catch (error) {
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Pyth request failed', {
            cause: error,
            context: { url: url.pathname, attempt },
          });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      },
      {
        maxAttempts: this.#maxAttempts,
        minMs: 400,
        maxMs: 8000,
        ...(signal === undefined ? {} : { signal }),
        onRetry: (error, attempt, delayMs) => {
          this.#logger.warn(
            { url: url.pathname, attempt, delayMs, err: describeError(error) },
            'retrying Pyth request',
          );
        },
      },
    );
  }
}
