import { AbortedError, isRetryable } from './errors.js';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new AbortedError('Aborted before sleep'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError('Aborted during sleep'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface BackoffOptions {
  readonly minMs: number;
  readonly maxMs: number;
  /** Multiplier per attempt. 2 doubles each time. */
  readonly factor?: number;
  /** Fraction of the delay randomised away, to stop reconnect storms. */
  readonly jitter?: number;
}

/**
 * Exponential backoff with full-ish jitter.
 *
 * `attempt` is 0-based: attempt 0 returns roughly `minMs`.
 */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const { minMs, maxMs, factor = 2, jitter = 0.2 } = options;
  const raw = Math.min(maxMs, minMs * factor ** Math.max(0, attempt));
  const spread = raw * jitter;
  return Math.max(0, Math.round(raw - spread + Math.random() * spread * 2));
}

export interface RetryOptions extends BackoffOptions {
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
  /** Defaults to "retry only errors marked retryable". */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Runs `fn` until it succeeds, `maxAttempts` is exhausted, or the error is not
 * retryable. Rethrows the last error, so callers keep the original cause.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxAttempts, signal, shouldRetry = (error) => isRetryable(error), onRetry } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted === true) throw new AbortedError('Aborted before retry attempt');
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof AbortedError) throw error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(error, attempt)) throw error;
      const delay = backoffDelay(attempt, options);
      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

/**
 * A token-bucket limiter. Public RPC keys are the scarcest resource in a
 * backfill, so every outbound call goes through one of these.
 */
export class RateLimiter {
  readonly #intervalMs: number;
  #next = 0;

  constructor(requestsPerSecond: number) {
    if (requestsPerSecond <= 0) throw new RangeError('requestsPerSecond must be > 0');
    this.#intervalMs = 1000 / requestsPerSecond;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(now, this.#next);
    this.#next = scheduled + this.#intervalMs;
    const wait = scheduled - now;
    if (wait > 0) await sleep(wait, signal);
  }
}

/** Runs `items` through `worker` with a bounded number in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Splits an array into fixed-size chunks. The last chunk may be short. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
