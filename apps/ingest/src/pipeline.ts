import {
  describeError,
  nowSeconds,
  silentLogger,
  type IngestMetrics,
  type IngestSource,
  type Logger,
  type NormalisedSwap,
  type ParsedSwap,
} from '@exitliquidity/core';
import type { SkipRow } from '@exitliquidity/clickhouse';
import { parseTransaction } from '@exitliquidity/parsers';
import { TxContext, type RawTransaction } from '@exitliquidity/solana';
import type { QuoteOracle } from '@exitliquidity/pricing';
import type { MintDecimalsResolver } from './decimals.js';

/** Why a parsed swap never became a row. Every reason is a metric label. */
export type DropReason =
  | 'vote_transaction'
  | 'failed_transaction'
  | 'no_block_time'
  | 'unknown_base_decimals'
  | 'unknown_quote_decimals'
  | 'below_min_usd'
  | 'context_error';

export interface PipelineOutput {
  readonly swaps: readonly NormalisedSwap[];
  readonly skips: readonly SkipRow[];
}

export interface SwapPipelineOptions {
  readonly decimals: MintDecimalsResolver;
  readonly oracle: QuoteOracle;
  readonly metrics: IngestMetrics;
  readonly logger?: Logger;
  /** Drops swaps below this USD size. Zero keeps everything. */
  readonly minSwapUsd?: number;
}

/**
 * Turns a raw transaction into `swaps` rows.
 *
 * Everything that can go wrong here is a drop with a counter, never a throw:
 * one malformed transaction must not stall a stream that is processing
 * thousands a second. The counters are the contract — a silent drop would show
 * up in the P0 acceptance test as an unexplained shortfall against Dexscreener.
 */
export class SwapPipeline {
  readonly #decimals: MintDecimalsResolver;
  readonly #oracle: QuoteOracle;
  readonly #metrics: IngestMetrics;
  readonly #logger: Logger;
  readonly #minSwapUsd: number;

  constructor(options: SwapPipelineOptions) {
    this.#decimals = options.decimals;
    this.#oracle = options.oracle;
    this.#metrics = options.metrics;
    this.#logger = options.logger ?? silentLogger;
    this.#minSwapUsd = options.minSwapUsd ?? 0;
  }

  async process(
    raw: RawTransaction,
    source: IngestSource,
    signal?: AbortSignal,
  ): Promise<PipelineOutput> {
    this.#metrics.transactions.inc({ source });

    if (raw.isVote) {
      this.#metrics.dropped.inc({ reason: 'vote_transaction', source });
      return EMPTY;
    }
    if (raw.failed) {
      // A failed transaction moved no tokens. Recording one would invent a
      // trade that never happened.
      this.#metrics.dropped.inc({ reason: 'failed_transaction', source });
      return EMPTY;
    }

    let ctx: TxContext;
    try {
      ctx = TxContext.from(raw);
    } catch (error) {
      this.#metrics.dropped.inc({ reason: 'context_error', source });
      this.#metrics.errors.inc({ stage: 'context' });
      this.#logger.warn(
        { signature: raw.signature, err: describeError(error) },
        'could not build transaction context',
      );
      return EMPTY;
    }

    // Decimals seen in this transaction are authoritative and free.
    for (const balance of [...raw.preTokenBalances, ...raw.postTokenBalances]) {
      this.#decimals.remember(balance.mint, balance.decimals);
    }

    const { swaps: parsed, skipped } = parseTransaction(ctx);

    const skips: SkipRow[] = skipped.map((entry) => {
      this.#metrics.parseFailures.inc({ venue: entry.venue, reason: entry.reason });
      return {
        slot: raw.slot.toString(),
        signature: entry.signature,
        venue: entry.venue,
        reason: entry.reason,
        ix_index: entry.ixIndex,
        inner_ix_index: entry.innerIxIndex,
        detail: entry.detail ?? '',
      };
    });

    if (parsed.length === 0) return { swaps: [], skips };

    const normalised: NormalisedSwap[] = [];
    for (const swap of parsed) {
      this.#metrics.swaps.inc({ venue: swap.venue, source });
      const row = await this.#normalise(swap, raw, source, signal);
      if (row !== null) normalised.push(row);
    }

    if (normalised.length > 0) {
      const newest = normalised.reduce(
        (max, row) => (row.blockTime > max ? row.blockTime : max),
        0,
      );
      this.#metrics.ingestLagSeconds.set(Math.max(0, nowSeconds() - newest), { source });
      this.#metrics.lastSlot.set(Number(raw.slot), { source });
    }

    return { swaps: normalised, skips };
  }

  async #normalise(
    swap: ParsedSwap,
    raw: RawTransaction,
    source: IngestSource,
    signal?: AbortSignal,
  ): Promise<NormalisedSwap | null> {
    const blockTime = swap.blockTime ?? raw.blockTime;
    if (blockTime === null) {
      // Without a timestamp the row cannot be partitioned, priced, or netted
      // into a window. It is not salvageable later either, so it is dropped.
      this.#metrics.dropped.inc({ reason: 'no_block_time', source, venue: swap.venue });
      return null;
    }

    const baseDecimals = swap.baseDecimals ?? (await this.#decimals.resolve(swap.mint, signal));
    if (baseDecimals === null) {
      this.#metrics.dropped.inc({ reason: 'unknown_base_decimals', source, venue: swap.venue });
      this.#logger.warn(
        { signature: swap.signature, mint: swap.mint },
        'dropping swap with unresolvable base decimals',
      );
      return null;
    }

    const quoteDecimals =
      swap.quoteDecimals ?? (await this.#decimals.resolve(swap.quoteMint, signal));
    if (quoteDecimals === null) {
      this.#metrics.dropped.inc({ reason: 'unknown_quote_decimals', source, venue: swap.venue });
      return null;
    }

    const { price, reason } = this.#oracle.price(
      swap.quoteMint,
      swap.quoteAmount,
      quoteDecimals,
      blockTime,
    );
    if (price === null) {
      this.#metrics.unpriced.inc({ reason: reason ?? 'unknown', venue: swap.venue });
    }

    // An unpriced swap is still a real swap and still counts towards the P0
    // acceptance test, so a size filter can only apply where a size is known.
    if (this.#minSwapUsd > 0 && price !== null && price.usd < this.#minSwapUsd) {
      this.#metrics.dropped.inc({ reason: 'below_min_usd', source, venue: swap.venue });
      return null;
    }

    return {
      signature: swap.signature,
      slot: swap.slot,
      blockTime,
      venue: swap.venue,
      poolId: swap.poolId,
      mint: swap.mint,
      wallet: swap.wallet,
      side: swap.side,
      baseAmount: swap.baseAmount,
      baseDecimals,
      quoteAmount: swap.quoteAmount,
      quoteFeeAmount: swap.quoteFeeAmount,
      quoteMint: swap.quoteMint,
      quoteDecimals,
      usdValue: price?.usd ?? null,
      usdPriceSource: price?.source ?? 'none',
      ixIndex: swap.ixIndex,
      innerIxIndex: swap.innerIxIndex,
      ingestSource: source,
    };
  }
}

const EMPTY: PipelineOutput = Object.freeze({ swaps: [], skips: [] });
