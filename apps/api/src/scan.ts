import {
  chunk,
  daysToSeconds,
  describeError,
  nowSeconds,
  quoteAsset,
  silentLogger,
  type Logger,
  type NormalisedSwap,
  type ParsedSwap,
} from '@exitliquidity/core';
import { parseTransaction } from '@exitliquidity/parsers';
import {
  TxContext,
  fromRpcTransaction,
  type SignatureInfo,
  type SolanaRpcClient,
} from '@exitliquidity/solana';
import type { QuoteOracle } from '@exitliquidity/pricing';

/**
 * Reads swaps straight off the chain, with no index in front of it.
 *
 * The ingest pipeline in `apps/ingest` exists because a product-wide index has
 * to be built once and read many times. A single trace is the other shape of
 * the same problem: one wallet, read once, thrown away. Crawling it on demand
 * costs a few hundred RPC calls and needs no ClickHouse, which is what lets the
 * console answer an address the moment somebody pastes it.
 *
 * Every crawl is bounded. An unbounded one against a wallet with a million
 * signatures would spend an RPC key and still not answer, so each limit here
 * has a matching field on the result: a trace that ran out of budget says so
 * rather than presenting a partial read as a complete one.
 */
export interface ScanBudget {
  readonly lookbackDays: number;
  readonly maxSignatures: number;
  readonly maxPoolSignaturePages: number;
  readonly maxPoolTransactions: number;
  readonly signaturePageSize: number;
}

export interface ScanCost {
  signaturesRead: number;
  transactionsFetched: number;
}

export interface WalletScan {
  readonly wallet: string;
  /** Swaps executed *by this wallet*, normalised and priced. */
  readonly swaps: readonly NormalisedSwap[];
  /** Unix seconds of the oldest signature the crawl reached. */
  readonly oldestTs: number | null;
  readonly newestTs: number | null;
  /** True when the signature budget ran out before the lookback window did. */
  readonly truncated: boolean;
  readonly cost: ScanCost;
}

/** A stretch of a pool's history a window needs to see. */
export interface TimeInterval {
  readonly fromTs: number;
  readonly toTs: number;
}

export interface PoolScan {
  readonly poolId: string;
  readonly swaps: readonly NormalisedSwap[];
  /** True when a budget stopped the crawl before it covered every interval. */
  readonly incomplete: boolean;
  readonly cost: ScanCost;
}

export interface ScannerOptions {
  readonly rpc: SolanaRpcClient;
  /** Resolved per call, so a warmed price series is visible to the next scan. */
  readonly oracle: () => QuoteOracle;
  readonly budget: ScanBudget;
  /**
   * Called with the time range of the swaps about to be priced.
   *
   * Pricing needs a SOL/USD series covering the swaps, and the range is only
   * known once they have been parsed — so the warm-up cannot happen before the
   * crawl, and doing it per swap would be a request per minute of history.
   */
  readonly warm?: (fromTs: number, toTs: number, signal?: AbortSignal) => Promise<void>;
  readonly logger?: Logger;
}

export class ChainScanner {
  readonly #rpc: SolanaRpcClient;
  readonly #oracle: () => QuoteOracle;
  readonly #budget: ScanBudget;
  readonly #warm: ScannerOptions['warm'];
  readonly #logger: Logger;

  constructor(options: ScannerOptions) {
    this.#rpc = options.rpc;
    this.#oracle = options.oracle;
    this.#budget = options.budget;
    this.#warm = options.warm;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Every swap `wallet` made on a parsed venue within the lookback window.
   *
   * Note what is *not* filtered: a transaction the wallet signed can contain
   * swaps by other wallets — a router filling several orders, a bundler moving
   * inventory. Those are dropped by the wallet check rather than counted, or a
   * FIFO ledger would open lots the wallet never held.
   */
  async scanWallet(wallet: string, signal?: AbortSignal): Promise<WalletScan> {
    const cost: ScanCost = { signaturesRead: 0, transactionsFetched: 0 };
    const cutoff = nowSeconds() - daysToSeconds(this.#budget.lookbackDays);

    const { signatures, truncated } = await this.#crawlSignatures(wallet, cutoff, cost, signal);
    const usable = signatures.filter((entry) => entry.err == null);

    const parsed = await this.#parseSignatures(usable, cost, signal);
    const mine = parsed.filter((entry) => entry.swap.wallet === wallet);
    const swaps = await this.#normalise(mine, signal);

    const times = signatures.map((entry) => entry.blockTime).filter(isNumber);

    return {
      wallet,
      swaps,
      oldestTs: times.length > 0 ? Math.min(...times) : null,
      newestTs: times.length > 0 ? Math.max(...times) : null,
      truncated,
      cost,
    };
  }

  /**
   * A pool's swaps inside `intervals`, and nothing outside them.
   *
   * The crawl runs backwards over signature pages, which carry a slot and a
   * block time. That is the whole reason this is affordable: a page is one RPC
   * call per thousand transactions, so the expensive `getTransaction` calls are
   * only ever spent on the handful that fall inside a window a losing buy leg
   * actually needs.
   */
  async scanPool(
    poolId: string,
    intervals: readonly TimeInterval[],
    signal?: AbortSignal,
  ): Promise<PoolScan> {
    const cost: ScanCost = { signaturesRead: 0, transactionsFetched: 0 };
    if (intervals.length === 0) {
      return { poolId, swaps: [], incomplete: false, cost };
    }

    const merged = mergeIntervals(intervals);
    const earliest = Math.min(...merged.map((interval) => interval.fromTs));
    const wanted: SignatureInfo[] = [];

    let before: string | undefined;
    let pages = 0;
    let reachedEarliest = false;

    while (pages < this.#budget.maxPoolSignaturePages) {
      const page = await this.#rpc.getSignaturesForAddress(poolId, {
        limit: this.#budget.signaturePageSize,
        ...(before === undefined ? {} : { before }),
        ...(signal === undefined ? {} : { signal }),
      });
      pages += 1;
      cost.signaturesRead += page.length;
      if (page.length === 0) {
        reachedEarliest = true;
        break;
      }

      for (const entry of page) {
        if (entry.err != null || entry.blockTime === null) continue;
        if (merged.some((interval) => within(entry.blockTime as number, interval))) {
          wanted.push(entry);
        }
      }

      const last = page[page.length - 1] as SignatureInfo;
      before = last.signature;
      if (last.blockTime !== null && last.blockTime < earliest) {
        reachedEarliest = true;
        break;
      }
      if (wanted.length >= this.#budget.maxPoolTransactions) break;
    }

    const capped = wanted.slice(0, this.#budget.maxPoolTransactions);
    const parsed = await this.#parseSignatures(capped, cost, signal);
    const swaps = await this.#normalise(
      parsed.filter((entry) => entry.swap.poolId === poolId),
      signal,
    );

    return {
      poolId,
      swaps,
      incomplete: !reachedEarliest || wanted.length > capped.length,
      cost,
    };
  }

  async #crawlSignatures(
    address: string,
    cutoffTs: number,
    cost: ScanCost,
    signal?: AbortSignal,
  ): Promise<{ signatures: SignatureInfo[]; truncated: boolean }> {
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;

    while (signatures.length < this.#budget.maxSignatures) {
      const remaining = this.#budget.maxSignatures - signatures.length;
      const page = await this.#rpc.getSignaturesForAddress(address, {
        limit: Math.min(this.#budget.signaturePageSize, remaining),
        ...(before === undefined ? {} : { before }),
        ...(signal === undefined ? {} : { signal }),
      });
      cost.signaturesRead += page.length;
      if (page.length === 0) return { signatures, truncated: false };

      for (const entry of page) {
        if (entry.blockTime !== null && entry.blockTime < cutoffTs) {
          return { signatures, truncated: false };
        }
        signatures.push(entry);
      }

      before = (page[page.length - 1] as SignatureInfo).signature;
    }

    // Stopped on the budget rather than on the cutoff: there is more history
    // behind this, and the trace has to say so.
    return { signatures, truncated: true };
  }

  async #parseSignatures(
    signatures: readonly SignatureInfo[],
    cost: ScanCost,
    signal?: AbortSignal,
  ): Promise<ParsedWithTime[]> {
    const out: ParsedWithTime[] = [];
    if (signatures.length === 0) return out;

    const size = Math.max(1, this.#rpc.transactionBatchSize);
    for (const group of chunk([...signatures], size)) {
      const responses = await this.#rpc.getTransactions(
        group.map((entry) => entry.signature),
        signal,
      );
      cost.transactionsFetched += group.length;

      responses.forEach((response, index) => {
        if (response === null) return;
        const info = group[index] as SignatureInfo;
        try {
          const raw = fromRpcTransaction(response);
          if (raw.failed) return;
          const ctx = TxContext.from(raw);
          for (const swap of parseTransaction(ctx).swaps) {
            out.push({ swap, ctx, blockTime: swap.blockTime ?? raw.blockTime ?? info.blockTime });
          }
        } catch (error) {
          // One undecodable transaction must not end a trace. It is logged and
          // skipped, exactly as the ingest pipeline treats it.
          this.#logger.debug(
            { signature: info.signature, err: describeError(error) },
            'skipping transaction that would not decode',
          );
        }
      });
    }

    return out;
  }

  /**
   * Fills in decimals and prices, dropping anything that cannot have both.
   *
   * Decimals come from the transaction's own token balances first — which is
   * where they are for almost every swap — and from RPC only for the mints that
   * had none. A mint that resolves nowhere is dropped rather than assumed to
   * have six: DECISIONS.md is explicit that a wrong exponent is a thousand-fold
   * error in every dollar figure downstream, and unlike a missing row it does
   * not look wrong.
   */
  async #normalise(
    parsed: readonly ParsedWithTime[],
    signal?: AbortSignal,
  ): Promise<NormalisedSwap[]> {
    if (parsed.length === 0) return [];

    const times = parsed.map((entry) => entry.blockTime).filter(isNumber);
    if (times.length > 0 && this.#warm !== undefined) {
      await this.#warm(Math.min(...times), Math.max(...times), signal);
    }
    const oracle = this.#oracle();

    const known = new Map<string, number>();
    for (const entry of parsed) {
      for (const mint of entry.ctx.mints()) {
        const decimals = entry.ctx.decimalsFor(mint);
        if (decimals !== null) known.set(mint, decimals);
      }
      if (entry.swap.baseDecimals !== null) known.set(entry.swap.mint, entry.swap.baseDecimals);
      if (entry.swap.quoteDecimals !== null)
        known.set(entry.swap.quoteMint, entry.swap.quoteDecimals);
    }

    const missing = new Set<string>();
    for (const entry of parsed) {
      for (const mint of [entry.swap.mint, entry.swap.quoteMint]) {
        const asset = quoteAsset(mint);
        if (asset !== null) known.set(mint, asset.decimals);
        else if (!known.has(mint)) missing.add(mint);
      }
    }

    if (missing.size > 0) {
      const mints = [...missing];
      const resolved = await this.#rpc.getMintDecimals(mints, signal);
      resolved.forEach((decimals, index) => {
        if (decimals !== null) known.set(mints[index] as string, decimals);
      });
    }

    const out: NormalisedSwap[] = [];
    for (const entry of parsed) {
      const blockTime = entry.blockTime;
      if (blockTime === null) continue;

      const baseDecimals = entry.swap.baseDecimals ?? known.get(entry.swap.mint);
      const quoteDecimals = entry.swap.quoteDecimals ?? known.get(entry.swap.quoteMint);
      if (baseDecimals === undefined || quoteDecimals === undefined) continue;

      const { price } = oracle.price(
        entry.swap.quoteMint,
        entry.swap.quoteAmount,
        quoteDecimals,
        blockTime,
      );

      out.push({
        signature: entry.swap.signature,
        slot: entry.swap.slot,
        blockTime,
        venue: entry.swap.venue,
        poolId: entry.swap.poolId,
        mint: entry.swap.mint,
        wallet: entry.swap.wallet,
        side: entry.swap.side,
        baseAmount: entry.swap.baseAmount,
        baseDecimals,
        quoteAmount: entry.swap.quoteAmount,
        quoteFeeAmount: entry.swap.quoteFeeAmount,
        quoteMint: entry.swap.quoteMint,
        quoteDecimals,
        usdValue: price?.usd ?? null,
        usdPriceSource: price?.source ?? 'none',
        ixIndex: entry.swap.ixIndex,
        innerIxIndex: entry.swap.innerIxIndex,
        ingestSource: 'backfill',
      });
    }

    return out;
  }
}

interface ParsedWithTime {
  readonly swap: ParsedSwap;
  readonly ctx: TxContext;
  readonly blockTime: number | null;
}

/** Collapses overlapping intervals so a pool crawl does not fetch a slot twice. */
export function mergeIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const sorted = [...intervals].sort((a, b) => a.fromTs - b.fromTs);
  const out: TimeInterval[] = [];

  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && interval.fromTs <= last.toTs) {
      out[out.length - 1] = { fromTs: last.fromTs, toTs: Math.max(last.toTs, interval.toTs) };
    } else {
      out.push(interval);
    }
  }

  return out;
}

function within(ts: number, interval: TimeInterval): boolean {
  return ts >= interval.fromTs && ts <= interval.toTs;
}

function isNumber(value: number | null): value is number {
  return value !== null;
}
