import {
  AbortedError,
  chunk,
  daysToSeconds,
  describeError,
  mapWithConcurrency,
  nowSeconds,
  silentLogger,
  type IngestMetrics,
  type Logger,
} from '@exitliquidity/core';
import {
  fromRpcTransaction,
  type SignatureInfo,
  type SolanaRpcClient,
} from '@exitliquidity/solana';
import type { SwapPipeline } from '../pipeline.js';
import type { SwapWriter } from '../writer.js';

export interface BackfillRequest {
  /**
   * Account to crawl. A mint covers every venue that token traded on, because
   * both P0 programs name the mint in their account list — which is exactly
   * what the P0 acceptance test needs.
   */
  readonly address: string;
  /** Stop once transactions are older than this. Defaults to the config window. */
  readonly fromSec?: number;
  /** Stop when this signature is reached; cheaper than a time cutoff on a re-run. */
  readonly untilSignature?: string;
  /** Hard cap on transactions fetched, for a bounded first look at a token. */
  readonly maxTransactions?: number;
}

export interface BackfillResult {
  readonly address: string;
  readonly signaturesScanned: number;
  readonly signaturesSkippedFailed: number;
  readonly transactionsFetched: number;
  readonly transactionsMissing: number;
  readonly swapsWritten: number;
  readonly parseSkips: number;
  readonly oldestBlockTime: number | null;
  readonly newestBlockTime: number | null;
  readonly reachedCutoff: boolean;
}

export interface BackfillRunnerOptions {
  readonly rpc: SolanaRpcClient;
  readonly pipeline: SwapPipeline;
  readonly writer: SwapWriter;
  readonly metrics: IngestMetrics;
  readonly logger?: Logger;
  readonly defaultDays?: number;
  readonly pageSize?: number;
  readonly transactionBatch?: number;
}

/**
 * Walks an account's transaction history backwards and feeds it through the
 * same pipeline the live stream uses.
 *
 * Backfill and stream share a pipeline deliberately: if the two produced rows
 * by different code paths, the acceptance test would only ever validate one of
 * them, and the seam between them is precisely where a count discrepancy would
 * hide. The swap table deduplicates, so overlap between the two is free.
 */
export class BackfillRunner {
  readonly #options: BackfillRunnerOptions;
  readonly #logger: Logger;

  constructor(options: BackfillRunnerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
  }

  async run(request: BackfillRequest, signal?: AbortSignal): Promise<BackfillResult> {
    const cutoffSec =
      request.fromSec ?? nowSeconds() - daysToSeconds(this.#options.defaultDays ?? 90);
    const pageSize = this.#options.pageSize ?? 1000;
    const batchSize = this.#options.transactionBatch ?? 20;
    const maxTransactions = request.maxTransactions ?? Number.POSITIVE_INFINITY;

    let before: string | undefined;
    let signaturesScanned = 0;
    let signaturesSkippedFailed = 0;
    let transactionsFetched = 0;
    let transactionsMissing = 0;
    let swapsWritten = 0;
    let parseSkips = 0;
    let oldestBlockTime: number | null = null;
    let newestBlockTime: number | null = null;
    let reachedCutoff = false;

    this.#logger.info(
      {
        address: request.address,
        cutoffSec,
        until: request.untilSignature,
        pageSize,
        batchSize,
        maxTransactions,
      },
      'starting backfill',
    );

    pages: for (;;) {
      if (signal?.aborted === true) throw new AbortedError('backfill aborted');

      const page = await this.#options.rpc.getSignaturesForAddress(request.address, {
        limit: pageSize,
        ...(before === undefined ? {} : { before }),
        ...(request.untilSignature === undefined ? {} : { until: request.untilSignature }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (page.length === 0) break;

      const wanted: SignatureInfo[] = [];
      for (const entry of page) {
        signaturesScanned += 1;

        // Signatures come back newest first, so the first one past the cutoff
        // ends the crawl — everything after it is older still.
        if (entry.blockTime !== null && entry.blockTime < cutoffSec) {
          reachedCutoff = true;
          before = entry.signature;
          const cutoffBudget = maxTransactions - transactionsFetched;
          if (wanted.length > 0 && cutoffBudget > 0) {
            const partial = await this.#processBatch(
              wanted.slice(0, cutoffBudget),
              batchSize,
              signal,
            );
            transactionsFetched += partial.fetched;
            transactionsMissing += partial.missing;
            swapsWritten += partial.swaps;
            parseSkips += partial.skips;
            oldestBlockTime = minOrNull(oldestBlockTime, partial.oldest);
            newestBlockTime = maxOrNull(newestBlockTime, partial.newest);
          }
          break pages;
        }

        // A failed transaction produces no rows, so fetching it is wasted RPC.
        if (entry.err != null) {
          signaturesSkippedFailed += 1;
          continue;
        }
        wanted.push(entry);
      }

      // The cap has to be applied before the fetch, not after it. Consulted only
      // at the bottom of this loop, `--max 20` still queued a whole page — up to
      // a thousand getTransaction calls, each spaced by the rate limiter — and
      // decided nothing except whether to pull a second page.
      const budget = maxTransactions - transactionsFetched;
      if (budget <= 0) break;

      const processed = await this.#processBatch(wanted.slice(0, budget), batchSize, signal);
      transactionsFetched += processed.fetched;
      transactionsMissing += processed.missing;
      swapsWritten += processed.swaps;
      parseSkips += processed.skips;
      oldestBlockTime = minOrNull(oldestBlockTime, processed.oldest);
      newestBlockTime = maxOrNull(newestBlockTime, processed.newest);

      this.#logger.info(
        { address: request.address, signaturesScanned, transactionsFetched, swapsWritten },
        'backfill page complete',
      );

      before = page[page.length - 1]?.signature;
      if (page.length < pageSize) break;
      if (transactionsFetched >= maxTransactions) break;
    }

    await this.#options.writer.flush();

    const result: BackfillResult = {
      address: request.address,
      signaturesScanned,
      signaturesSkippedFailed,
      transactionsFetched,
      transactionsMissing,
      swapsWritten,
      parseSkips,
      oldestBlockTime,
      newestBlockTime,
      reachedCutoff,
    };
    this.#logger.info(result, 'backfill complete');
    return result;
  }

  async #processBatch(
    signatures: readonly SignatureInfo[],
    batchSize: number,
    signal?: AbortSignal,
  ): Promise<{
    fetched: number;
    missing: number;
    swaps: number;
    skips: number;
    oldest: number | null;
    newest: number | null;
  }> {
    let fetched = 0;
    let missing = 0;
    let swaps = 0;
    let skips = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    // One HTTP request carries many transactions, so the unit of work here is a
    // group rather than a signature. `batchSize` keeps its old meaning —
    // transactions in flight — which is why the concurrency is derived from it
    // rather than used directly: twenty in flight is one request of twenty, not
    // twenty requests. With batching turned off the two are identical again.
    const groupSize = Math.max(1, this.#options.rpc.transactionBatchSize);
    const groups = chunk([...signatures], groupSize);
    const inFlight = Math.max(1, Math.ceil(batchSize / groupSize));

    let done = 0;
    const grouped = await mapWithConcurrency(
      groups,
      inFlight,
      async (group) => {
        try {
          return await this.#options.rpc.getTransactions(
            group.map((entry) => entry.signature),
            signal,
          );
        } catch (error) {
          // A shutdown is not an unfetchable transaction. Counting it as one
          // turns a single Ctrl+C into one bogus warning per remaining
          // signature and inflates the error metric by the length of the page.
          if (error instanceof AbortedError) throw error;
          // A genuinely unfetchable group must not abandon the whole crawl; it
          // is counted so the shortfall is visible in the result.
          this.#options.metrics.errors.inc({ stage: 'backfill_fetch' });
          this.#logger.warn(
            { signatures: group.length, from: group[0]?.signature, err: describeError(error) },
            'could not fetch a batch of transactions during backfill',
          );
          return group.map(() => null);
        } finally {
          // Inside the worker, not after the map: a line printed once the page
          // is done arrives after all the waiting is over, which is exactly
          // when nobody needs it. At a low rate limit this is the only
          // evidence the process is alive.
          done += group.length;
          this.#logger.info({ done, total: signatures.length }, 'backfill fetch progress');
        }
      },
      signal,
    );
    const responses = grouped.flat();

    for (const response of responses) {
      if (response === null) {
        missing += 1;
        continue;
      }
      fetched += 1;

      const raw = fromRpcTransaction(response);
      const output = await this.#options.pipeline.process(raw, 'backfill', signal);
      if (output.swaps.length > 0 || output.skips.length > 0) {
        await this.#options.writer.add(output.swaps, output.skips);
      }
      swaps += output.swaps.length;
      skips += output.skips.length;

      for (const swap of output.swaps) {
        oldest = minOrNull(oldest, swap.blockTime);
        newest = maxOrNull(newest, swap.blockTime);
      }
    }

    return { fetched, missing, swaps, skips, oldest, newest };
  }
}

function minOrNull(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  return current === null ? candidate : Math.min(current, candidate);
}

function maxOrNull(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  return current === null ? candidate : Math.max(current, candidate);
}
