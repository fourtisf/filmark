import yellowstone from '@triton-one/yellowstone-grpc';
import type { SubscribeUpdate } from '@triton-one/yellowstone-grpc';
import type { ClientDuplexStream } from '@grpc/grpc-js';
import {
  AbortedError,
  UpstreamError,
  backoffDelay,
  describeError,
  parseUnsignedBigInt,
  silentLogger,
  sleep,
  type IngestMetrics,
  type Logger,
} from '@exitliquidity/core';
import type { CheckpointRepository } from '@exitliquidity/clickhouse';
import { PARSED_PROGRAM_IDS } from '@exitliquidity/parsers';
import { fromYellowstoneTransaction } from '@exitliquidity/solana';
import { BlockTimeCache } from './block-times.js';
import { buildSubscribeRequest, type CommitmentName } from './subscription.js';
import type { SwapPipeline } from '../pipeline.js';
import type { SwapWriter } from '../writer.js';

/**
 * The gRPC client class.
 *
 * `@triton-one/yellowstone-grpc` is CommonJS with a TypeScript default export,
 * so from an ES module the import gives the module namespace and the class
 * lives on `.default`.
 */
const GeyserClient = yellowstone.default;
type GeyserClient = InstanceType<typeof GeyserClient>;

/** Checkpoint name for the live stream. */
export const STREAM_CHECKPOINT = 'stream:pumpfun+pumpswap';

export interface StreamConsumerOptions {
  readonly endpoint: string;
  readonly xToken?: string;
  readonly commitment: CommitmentName;
  readonly pipeline: SwapPipeline;
  readonly writer: SwapWriter;
  readonly metrics: IngestMetrics;
  readonly checkpoints?: CheckpointRepository;
  readonly logger?: Logger;
  readonly programIds?: readonly string[];
  /** Silence longer than this is treated as a dead connection. */
  readonly idleTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  /** Slots between checkpoint writes. */
  readonly checkpointEverySlots?: number;
  /** Injectable for tests. */
  readonly createClient?: (endpoint: string, xToken: string | undefined) => GeyserClient;
}

type Stream = ClientDuplexStream<unknown, SubscribeUpdate>;

/**
 * The Yellowstone gRPC consumer.
 *
 * Runs until aborted, reconnecting with backoff on every failure. A geyser
 * stream drops regularly — provider restarts, node catch-up, transient
 * networking — so reconnection is the normal case rather than the exception,
 * and the consumer resumes from its checkpoint where the provider supports
 * `fromSlot`.
 */
export class StreamConsumer {
  readonly #options: StreamConsumerOptions;
  readonly #logger: Logger;
  readonly #blockTimes = new BlockTimeCache();

  #lastSlot = 0n;
  #lastCheckpointSlot = 0n;

  constructor(options: StreamConsumerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
  }

  get lastSlot(): bigint {
    return this.#lastSlot;
  }

  /** Consumes until `signal` aborts. Only an abort ends this normally. */
  async run(signal: AbortSignal): Promise<void> {
    const resumeFrom = await this.#loadCheckpoint();
    if (resumeFrom !== null) {
      this.#lastSlot = resumeFrom;
      this.#lastCheckpointSlot = resumeFrom;
      this.#logger.info({ slot: resumeFrom.toString() }, 'resuming stream from checkpoint');
    }

    let attempt = 0;

    while (!signal.aborted) {
      try {
        await this.#consumeOnce(signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted || error instanceof AbortedError) break;

        attempt += 1;
        this.#metrics.errors.inc({ stage: 'stream' });
        const delayMs = backoffDelay(attempt - 1, {
          minMs: this.#options.reconnectMinMs ?? 500,
          maxMs: this.#options.reconnectMaxMs ?? 30_000,
        });
        this.#logger.warn(
          { attempt, delayMs, lastSlot: this.#lastSlot.toString(), err: describeError(error) },
          'stream disconnected, reconnecting',
        );

        try {
          await sleep(delayMs, signal);
        } catch {
          break;
        }
      }
    }

    await this.#saveCheckpoint(true);
  }

  get #metrics(): IngestMetrics {
    return this.#options.metrics;
  }

  async #consumeOnce(signal: AbortSignal): Promise<void> {
    const client =
      this.#options.createClient?.(this.#options.endpoint, this.#options.xToken) ??
      new GeyserClient(this.#options.endpoint, this.#options.xToken, {
        // Geyser messages are large; the defaults reject blocks outright.
        'grpc.max_receive_message_length': 128 * 1024 * 1024,
        'grpc.keepalive_time_ms': 20_000,
        'grpc.keepalive_timeout_ms': 10_000,
        'grpc.keepalive_permit_without_calls': 1,
      });

    const stream = (await client.subscribe()) as unknown as Stream;

    try {
      await this.#pump(stream, signal);
    } finally {
      stream.removeAllListeners();
      stream.destroy();
    }
  }

  /**
   * Reads one connection to completion.
   *
   * Resolves when the abort signal fires, rejects on stream error or on
   * silence past the idle timeout. The idle timer matters more than it looks:
   * a half-open TCP connection produces no error and no data, and without it
   * the consumer would sit there looking healthy forever.
   */
  async #pump(stream: Stream, signal: AbortSignal): Promise<void> {
    const idleTimeoutMs = this.#options.idleTimeoutMs ?? 30_000;
    const pingIntervalMs = this.#options.pingIntervalMs ?? 10_000;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let processing: Promise<void> = Promise.resolve();
      // Held together so `finish` can clear both without either being
      // reassigned after `finish` closes over it.
      const timers: { idle?: NodeJS.Timeout; ping?: NodeJS.Timeout } = {};

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timers.idle);
        clearInterval(timers.ping);
        signal.removeEventListener('abort', onAbort);
        // Let the in-flight batch finish before tearing the stream down, so a
        // reconnect does not have to redo work already parsed.
        void processing.finally(() => {
          if (error === undefined) resolve();
          else reject(error);
        });
      };

      const resetIdle = (): void => {
        clearTimeout(timers.idle);
        timers.idle = setTimeout(() => {
          finish(new UpstreamError(`no stream activity for ${idleTimeoutMs}ms`));
        }, idleTimeoutMs);
        timers.idle.unref?.();
      };

      const onAbort = (): void => {
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      stream.on('data', (update: SubscribeUpdate) => {
        resetIdle();
        // Updates are handled in arrival order; chaining keeps slot ordering
        // intact, which the checkpoint depends on.
        processing = processing
          .then(() => this.#handleUpdate(update, stream))
          .catch((error: unknown) => {
            this.#metrics.errors.inc({ stage: 'stream_update' });
            this.#logger.error({ err: describeError(error) }, 'failed to handle stream update');
          });
      });

      stream.on('error', (error: Error) => {
        finish(new UpstreamError('stream error', { cause: error }));
      });
      stream.on('end', () => {
        finish(new UpstreamError('stream ended'));
      });
      stream.on('close', () => {
        finish(new UpstreamError('stream closed'));
      });

      resetIdle();

      // An application-level ping keeps idle providers from dropping the
      // subscription, and proves the socket is still two-way.
      timers.ping = setInterval(() => {
        try {
          stream.write({ ...EMPTY_REQUEST, ping: { id: 1 } });
        } catch (error) {
          finish(new UpstreamError('failed to write ping', { cause: error }));
        }
      }, pingIntervalMs);
      timers.ping.unref?.();

      try {
        stream.write(
          buildSubscribeRequest({
            programIds: this.#options.programIds ?? PARSED_PROGRAM_IDS,
            commitment: this.#options.commitment,
            ...(this.#lastSlot > 0n ? { fromSlot: this.#lastSlot } : {}),
          }),
        );
      } catch (error) {
        finish(new UpstreamError('failed to send subscribe request', { cause: error }));
      }
    });
  }

  async #handleUpdate(update: SubscribeUpdate, stream: Stream): Promise<void> {
    if (update.ping !== undefined) {
      stream.write({ ...EMPTY_REQUEST, ping: { id: 1 } });
      return;
    }
    if (update.pong !== undefined) return;

    if (update.blockMeta !== undefined) {
      const timestamp = update.blockMeta.blockTime?.timestamp;
      if (timestamp !== undefined) {
        this.#blockTimes.set(
          parseUnsignedBigInt(update.blockMeta.slot, 'blockMeta.slot'),
          Number(timestamp),
        );
      }
      return;
    }

    if (update.slot !== undefined) {
      this.#advanceSlot(parseUnsignedBigInt(update.slot.slot, 'slot'));
      await this.#saveCheckpoint(false);
      return;
    }

    const transaction = update.transaction;
    if (transaction?.transaction === undefined) return;

    const slot = parseUnsignedBigInt(transaction.slot, 'transaction.slot');
    this.#advanceSlot(slot);

    const raw = fromYellowstoneTransaction(transaction.transaction, slot, {
      blockTime: this.#blockTimes.get(slot),
    });

    const { swaps, skips } = await this.#options.pipeline.process(raw, 'stream');
    if (swaps.length > 0 || skips.length > 0) await this.#options.writer.add(swaps, skips);
  }

  #advanceSlot(slot: bigint): void {
    if (slot > this.#lastSlot) this.#lastSlot = slot;
  }

  async #loadCheckpoint(): Promise<bigint | null> {
    if (this.#options.checkpoints === undefined) return null;
    try {
      const checkpoint = await this.#options.checkpoints.get(STREAM_CHECKPOINT);
      return checkpoint?.slot ?? null;
    } catch (error) {
      // A missing checkpoint means starting from the tip, which is recoverable.
      // Refusing to start would not be.
      this.#logger.warn({ err: describeError(error) }, 'could not read stream checkpoint');
      return null;
    }
  }

  async #saveCheckpoint(force: boolean): Promise<void> {
    const repository = this.#options.checkpoints;
    if (repository === undefined || this.#lastSlot === 0n) return;

    const every = BigInt(this.#options.checkpointEverySlots ?? 150);
    if (!force && this.#lastSlot - this.#lastCheckpointSlot < every) return;

    const slot = this.#lastSlot;
    try {
      // Checkpoint behind the tip: rows are written asynchronously, so
      // resuming exactly at `lastSlot` could skip a slot whose rows never
      // landed. Re-reading a few slots is free — the table deduplicates.
      const safeSlot = slot > every ? slot - every : 0n;
      await repository.set(STREAM_CHECKPOINT, safeSlot);
      this.#lastCheckpointSlot = slot;
    } catch (error) {
      this.#logger.warn(
        { slot: slot.toString(), err: describeError(error) },
        'could not write stream checkpoint',
      );
    }
  }
}

/** A subscription request with every filter empty, for pings. */
const EMPTY_REQUEST = {
  accounts: {},
  slots: {},
  transactions: {},
  transactionsStatus: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
  accountsDataSlice: [],
} as const;
