import {
  describeError,
  retry,
  silentLogger,
  type IngestMetrics,
  type Logger,
  type NormalisedSwap,
} from '@exitliquidity/core';
import type { SkipRow, SwapRepository } from '@exitliquidity/clickhouse';

export interface SwapWriterOptions {
  readonly repository: SwapRepository;
  readonly metrics: IngestMetrics;
  readonly logger?: Logger;
  /** Rows buffered before a flush is forced. */
  readonly maxRows?: number;
  /** Longest a row may wait before being flushed anyway. */
  readonly maxDelayMs?: number;
  /** Hard ceiling; `add` blocks on a flush once the buffer reaches it. */
  readonly maxPendingRows?: number;
  readonly maxAttempts?: number;
}

/**
 * Buffers swap rows and writes them to ClickHouse in batches.
 *
 * ClickHouse wants few large inserts, not many small ones — every insert
 * creates a part, and a part per swap would bury the merge scheduler. Rows are
 * therefore held until either the batch is full or it has waited long enough,
 * and the buffer has a hard ceiling so a stalled ClickHouse turns into
 * backpressure on the stream rather than unbounded memory growth.
 */
export class SwapWriter {
  readonly #repository: SwapRepository;
  readonly #metrics: IngestMetrics;
  readonly #logger: Logger;
  readonly #maxRows: number;
  readonly #maxDelayMs: number;
  readonly #maxPendingRows: number;
  readonly #maxAttempts: number;

  #swaps: NormalisedSwap[] = [];
  #skips: SkipRow[] = [];
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #lastWriteFailed = false;
  #closed = false;

  constructor(options: SwapWriterOptions) {
    this.#repository = options.repository;
    this.#metrics = options.metrics;
    this.#logger = options.logger ?? silentLogger;
    this.#maxRows = options.maxRows ?? 5000;
    this.#maxDelayMs = options.maxDelayMs ?? 2000;
    this.#maxPendingRows = options.maxPendingRows ?? (options.maxRows ?? 5000) * 4;
    this.#maxAttempts = options.maxAttempts ?? 5;
  }

  get pending(): number {
    // Skips count. They are rows waiting to be written, and reporting only
    // swaps made /metrics say zero while thousands of skip rows sat buffered.
    return this.#swaps.length + this.#skips.length;
  }

  /**
   * True when the last write exhausted its retries.
   *
   * The stream reads this before advancing its checkpoint: acknowledging a slot
   * whose rows were dropped turns a transient storage outage into a permanent,
   * invisible hole that no restart will revisit.
   */
  get lastWriteFailed(): boolean {
    return this.#lastWriteFailed;
  }

  /**
   * Queues rows for writing.
   *
   * Resolves once the rows are buffered — or, if the buffer is already at its
   * ceiling, once enough of it has been written to make room.
   */
  async add(swaps: readonly NormalisedSwap[], skips: readonly SkipRow[] = []): Promise<void> {
    if (this.#closed) throw new Error('writer is closed');

    this.#swaps.push(...swaps);
    this.#skips.push(...skips);
    this.#metrics.pendingRows.set(this.pending);

    // Every threshold counts both arrays. Measuring swaps alone meant a batch
    // of nothing but parse skips armed no timer and hit no ceiling — so on a
    // run where every instruction failed to parse, `swaps` was empty because
    // nothing parsed and `ingest_skips` was empty because nothing flushed, and
    // the table that exists to explain the shortfall explained nothing.
    if (this.pending >= this.#maxPendingRows) {
      await this.flush();
      return;
    }
    if (this.pending >= this.#maxRows) {
      // Deliberately not awaited: a full batch should start writing while the
      // caller keeps consuming the stream.
      void this.flush().catch(() => undefined);
      return;
    }
    this.#scheduleFlush();
  }

  /** Writes everything buffered. Safe to call concurrently. */
  async flush(): Promise<void> {
    // Serialise flushes so two callers cannot interleave batches, and so the
    // in-flight one is awaited rather than duplicated. The rejection is
    // swallowed because #write has already logged and counted it: rethrowing
    // here would abandon the buffer before the swap below, losing rows added
    // since the failing batch started — including on close().
    while (this.#inFlight !== null) {
      try {
        await this.#inFlight;
      } catch {
        /* already logged and counted by #write */
      }
    }

    if (this.#swaps.length === 0 && this.#skips.length === 0) return;

    this.#clearTimer();
    const swaps = this.#swaps;
    const skips = this.#skips;
    this.#swaps = [];
    this.#skips = [];

    this.#inFlight = this.#write(swaps, skips).finally(() => {
      this.#inFlight = null;
      this.#metrics.pendingRows.set(this.pending);
    });

    await this.#inFlight;
  }

  /** Flushes and refuses further writes. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#clearTimer();
    try {
      await this.flush();
    } catch (error) {
      // Say how much is being abandoned. "close failed" without a row count
      // reads as a tidy-up problem rather than data loss.
      this.#logger.error(
        { rows: this.pending, err: describeError(error) },
        'writer close failed with rows still buffered',
      );
      throw error;
    }
  }

  async #write(swaps: NormalisedSwap[], skips: SkipRow[]): Promise<void> {
    try {
      await retry(() => this.#repository.insert(swaps), {
        maxAttempts: this.#maxAttempts,
        minMs: 250,
        maxMs: 10_000,
        onRetry: (error, attempt, delayMs) => {
          this.#metrics.errors.inc({ stage: 'write' });
          this.#logger.warn(
            { attempt, delayMs, rows: swaps.length, err: describeError(error) },
            'retrying swap insert',
          );
        },
      });
      this.#metrics.rowsWritten.inc({}, swaps.length);
      this.#lastWriteFailed = false;
    } catch (error) {
      this.#lastWriteFailed = true;
      // Losing rows silently would make the acceptance test unfalsifiable, so
      // the signatures go to the log where they can be re-backfilled.
      this.#metrics.errors.inc({ stage: 'write_failed' });
      this.#metrics.dropped.inc({ reason: 'write_failed', source: 'writer' }, swaps.length);
      this.#logger.error(
        {
          rows: swaps.length,
          signatures: [...new Set(swaps.map((s) => s.signature))].slice(0, 20),
          err: describeError(error),
        },
        'dropping a batch of swaps after exhausting retries',
      );
      throw error;
    } finally {
      // Diagnostics are best-effort: failing to record why a swap was skipped
      // must never take down the path that records the swaps themselves.
      if (skips.length > 0) {
        try {
          await this.#repository.insertSkips(skips);
        } catch (error) {
          this.#logger.warn({ err: describeError(error) }, 'could not record parse skips');
        }
      }
    }
  }

  #scheduleFlush(): void {
    if (this.#timer !== null || this.pending === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch((error: unknown) => {
        this.#logger.error({ err: describeError(error) }, 'scheduled flush failed');
      });
    }, this.#maxDelayMs);
    // A pending flush must not hold the process open at shutdown.
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
