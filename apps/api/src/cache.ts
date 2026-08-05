import { AppError } from '@exitliquidity/core';

/** Raised when the service is already doing as much work as it will take on. */
export class BusyError extends AppError {
  readonly code = 'BUSY';
  readonly retryable = true;
}

export interface CacheOptions {
  readonly ttlSec: number;
  readonly maxEntries: number;
  /** Injectable clock, so the expiry tests do not sleep. */
  readonly now?: () => number;
}

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * A small TTL cache that also collapses concurrent work on the same key.
 *
 * Both halves matter for the same reason: a trace is hundreds of RPC calls, and
 * the traffic shape of a shared link is many people asking for one wallet at
 * once. Without single-flight, ten visitors to the same trace are ten crawls of
 * the same history against one key.
 */
export class ResultCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inFlight = new Map<string, Promise<T>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: CacheOptions) {
    this.#ttlMs = options.ttlSec * 1000;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  peek(key: string): T | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    // Re-insert so the Map's insertion order doubles as recency.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  async resolve(key: string, compute: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.peek(key);
    if (hit !== null) return { value: hit, cached: true };

    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return { value: await existing, cached: true };

    const work = compute();
    this.#inFlight.set(key, work);
    try {
      const value = await work;
      this.#put(key, value);
      return { value, cached: false };
    } finally {
      // Always cleared, including on failure: a rejected promise left in the
      // map would serve its error to every later caller for the process's life.
      this.#inFlight.delete(key);
    }
  }

  #put(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

export interface SemaphoreOptions {
  readonly limit: number;
  /** Callers allowed to wait. Past this, work is refused instead of queued. */
  readonly maxQueued?: number;
}

/**
 * Bounds how much work is in flight, and refuses rather than queues past a point.
 *
 * An unbounded queue under load is a service that accepts every request and
 * answers none of them: by the time a trace reaches the front, the browser that
 * asked for it has long given up, and the RPC budget it then spends is spent on
 * nobody. Refusing early gives the caller something it can act on.
 */
export class Semaphore {
  readonly #limit: number;
  readonly #maxQueued: number;
  readonly #waiting: (() => void)[] = [];
  #active = 0;

  constructor(options: SemaphoreOptions) {
    if (options.limit < 1) throw new RangeError('limit must be >= 1');
    this.#limit = options.limit;
    this.#maxQueued = options.maxQueued ?? options.limit * 4;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit && this.#waiting.length >= this.#maxQueued) {
      throw new BusyError('the trace queue is full', {
        context: { active: this.#active, queued: this.#waiting.length },
      });
    }

    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    this.#active += 1;
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}
