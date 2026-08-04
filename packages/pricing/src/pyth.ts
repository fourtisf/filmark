import {
  UpstreamError,
  chunk,
  describeError,
  floorToMinute,
  minuteRange,
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

export interface PythClientOptions {
  readonly benchmarksUrl?: string;
  readonly hermesUrl?: string;
  readonly feedId?: string;
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
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;

  constructor(options: PythClientOptions = {}) {
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
   * quarter of history in one call.
   */
  async fetchCandles(
    fromSec: number,
    toSec: number,
    signal?: AbortSignal,
  ): Promise<SolUsdCandle[]> {
    if (toSec < fromSec) throw new RangeError('toSec must be >= fromSec');

    const windows = chunk(minuteRange(fromSec, toSec), MAX_BARS_PER_REQUEST)
      .map((minutes) => ({ from: minutes[0] as number, to: minutes[minutes.length - 1] as number }))
      .filter((window) => window.from !== undefined);

    const byMinute = new Map<number, SolUsdCandle>();
    for (const window of windows) {
      for (const candle of await this.#fetchWindow(window.from, window.to, signal)) {
        byMinute.set(candle.minuteTs, candle);
      }
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
            throw new UpstreamError(`Pyth request failed with HTTP ${response.status}`, {
              context: { url: url.pathname, status: response.status, attempt },
            });
          }
          return (await response.json()) as T;
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
