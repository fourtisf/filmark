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
    return this.#swaps.length;
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
    this.#metrics.pendingRows.set(this.#swaps.length);

    if (this.#swaps.length >= this.#maxPendingRows) {
      await this.flush();
      return;
    }
    if (this.#swaps.length >= this.#maxRows) {
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
    // in-flight one is awaited rather than duplicated.
    while (this.#inFlight !== null) await this.#inFlight;

    if (this.#swaps.length === 0 && this.#skips.length === 0) return;

    this.#clearTimer();
    const swaps = this.#swaps;
    const skips = this.#skips;
    this.#swaps = [];
    this.#skips = [];

    this.#inFlight = this.#write(swaps, skips).finally(() => {
      this.#inFlight = null;
      this.#metrics.pendingRows.set(this.#swaps.length);
    });

    await this.#inFlight;
  }

  /** Flushes and refuses further writes. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#clearTimer();
    await this.flush();
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
    } catch (error) {
      // Losing rows silently would make the acceptance test unfalsifiable, so
      // the signatures go to the log where they can be re-backfilled.
      this.#metrics.errors.inc({ stage: 'write_failed' });
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
    if (this.#timer !== null || this.#swaps.length === 0) return;
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
