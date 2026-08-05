import { AbortedError, isRetryable, retryAfterMs } from './errors.js';

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
  /**
   * Ceiling on a server-supplied `Retry-After`, so a provider cannot park the
   * process for an hour. Defaults to 60s.
   */
  readonly maxRetryAfterMs?: number;
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
  // Without this the loop body never runs and the throw below rethrows
  // undefined — an error with no name, no message and no stack.
  if (maxAttempts < 1) throw new RangeError('maxAttempts must be >= 1');
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
      // A stated Retry-After wins over the guess whenever it is longer. Backing
      // off below it is a rejection the caller has already been warned about.
      const hint = Math.min(retryAfterMs(error) ?? 0, options.maxRetryAfterMs ?? 60_000);
      const delay = Math.max(backoffDelay(attempt, options), hint);
      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

/** How far below the configured rate a limiter will slow itself. */
const MAX_BACKOFF_FACTOR = 32;

/** Multiplied into the interval on a rejection, and eased out of on success. */
const BACKOFF_STEP = 2;
const RECOVERY_STEP = 0.98;

/**
 * A token-bucket limiter that listens when the far end pushes back.
 *
 * Public RPC keys are the scarcest resource in a backfill, so every outbound
 * call goes through one of these. `requestsPerSecond` is what the operator
 * believes the plan allows, and that belief is routinely wrong — a plan gets
 * downgraded, a limit is shared with another service, or the figure was a guess
 * to begin with. A limiter that only obeys the configured number turns every
 * one of those into a wall of 429s and a request that fails outright, which
 * reads as a broken key rather than as a number that is too large by two.
 *
 * So the configured rate is a ceiling, not a promise: `backOff` halves the rate
 * when the provider refuses and `recover` eases it back on sustained success.
 * The client finds the real limit in a few seconds instead of asking an
 * operator to find it by bisection.
 */
export class RateLimiter {
  readonly #intervalMs: number;
  #factor = 1;
  #next = 0;

  constructor(requestsPerSecond: number) {
    if (requestsPerSecond <= 0) throw new RangeError('requestsPerSecond must be > 0');
    this.#intervalMs = 1000 / requestsPerSecond;
  }

  /** Requests per second the limiter is currently pacing to. */
  get effectiveRate(): number {
    return 1000 / (this.#intervalMs * this.#factor);
  }

  /**
   * `cost` is how many units of the limit this acquisition spends.
   *
   * Providers meter RPC calls, not HTTP requests. A JSON-RPC batch of twenty is
   * one connection and twenty calls, so charging it as one would multiply the
   * configured rate by the batch size — which is a rate limiter that raises the
   * rate.
   */
  async acquire(signal?: AbortSignal, cost = 1): Promise<void> {
    if (cost < 1) throw new RangeError('cost must be >= 1');
    const now = Date.now();
    const scheduled = Math.max(now, this.#next);
    this.#next = scheduled + this.#intervalMs * this.#factor * cost;
    const wait = scheduled - now;
    if (wait > 0) await sleep(wait, signal);
  }

  /**
   * The far end refused. Halve the rate, and hold the next slot back so the
   * calls already scheduled do not arrive at the pace that was just rejected.
   */
  backOff(): boolean {
    if (this.#factor >= MAX_BACKOFF_FACTOR) return false;
    this.#factor = Math.min(MAX_BACKOFF_FACTOR, this.#factor * BACKOFF_STEP);
    this.#next = Math.max(this.#next, Date.now() + this.#intervalMs * this.#factor);
    return true;
  }

  /**
   * A call came back clean. Ease towards the configured rate.
   *
   * Slowly, and deliberately: recovering as fast as it backed off would put the
   * client straight back into the limit it just found, which is a client that
   * spends its life oscillating across a threshold instead of sitting under it.
   */
  recover(): void {
    if (this.#factor > 1) this.#factor = Math.max(1, this.#factor * RECOVERY_STEP);
  }
}

/**
 * Runs `items` through `worker` with a bounded number in flight, preserving order.
 *
 * The signal is checked before each item is claimed. Without it, a worker that
 * swallows its own errors turns one abort into one failure per remaining item:
 * the runners keep claiming indices, each call fails instantly with no I/O, and
 * a single Ctrl+C prints a wall of identical errors that buries what actually
 * happened. Cancellation has to stop the loop, not just the work inside it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted === true) throw new AbortedError('Aborted during mapWithConcurrency');
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
