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

/**
 * Epoch milliseconds after which a crawl stops and reports what it has.
 *
 * The signature and transaction ceilings bound a trace in *calls*; this bounds
 * it in wall clock, which is the thing the caller is actually waiting on. They
 * are not the same limit: a provider throttling to a third of its stated rate
 * turns a budget that fits inside the timeout into one that does not, and the
 * only sign is a request that never answers. Every stopping point below sets a
 * flag the report carries, so a trace cut short says so rather than presenting
 * a partial read as a complete one (§7.2).
 */
export type Deadline = number | undefined;

function past(deadline: Deadline): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

/**
 * Why the signature crawl stopped, which decides what its silence means.
 *
 * Only `end_of_history` says the trace saw everything. The other three each
 * leave older history unread, and one of them — `lookback_cutoff` — is not a
 * budget at all but the configured window doing exactly what it was asked to
 * do. That distinction is the whole point: a wallet whose sells were read and
 * whose buys sit a day past the cutoff produces a ledger of sales with no
 * purchases, and without this the trace blames the venue parsers or a bot for
 * something the lookback did.
 */
export type CrawlStop = 'end_of_history' | 'lookback_cutoff' | 'signature_budget' | 'time_budget';

/**
 * What was actually read, counted by venue and direction — `pumpfun:buy: 4`.
 *
 * A trace that finds no losses can mean the wallet won, or that it was read
 * wrong, and the two are indistinguishable from the totals alone. A wallet
 * showing sells and no buys is not a quiet quarter; it is a read that lost half
 * the trades, and that has to be visible without attaching a debugger.
 */
export type SwapCensus = Readonly<Record<string, number>>;

export function censusOf(swaps: readonly NormalisedSwap[]): SwapCensus {
  const census: Record<string, number> = {};
  for (const swap of swaps) {
    const key = `${swap.venue}:${swap.side}`;
    census[key] = (census[key] ?? 0) + 1;
  }
  return census;
}

export interface WalletScan {
  readonly wallet: string;
  /** Swaps executed *by this wallet*, normalised and priced. */
  readonly swaps: readonly NormalisedSwap[];
  /** Those swaps counted by venue and direction. */
  readonly census: SwapCensus;
  /**
   * Of those swaps, how many got no USD price.
   *
   * The quiet failure this exists to make loud. A swap with no price makes its
   * position `unpriced`, `isAttributable` drops every one of those, and the
   * trace then reports "nothing closed in the red" — a finding about the wallet
   * produced by an outage at the price oracle. Counted here so the report can
   * tell the two apart.
   */
  readonly unpricedSwaps: number;
  /** Swaps parsed in the crawled transactions that belonged to someone else. */
  readonly foreignSwaps: number;
  /** Venue instructions refused by a parser, by venue and reason. */
  readonly parseSkips: Readonly<Record<string, number>>;
  /**
   * True when the SOL/USD warm-up was abandoned to keep the crawl's clock.
   *
   * The one upstream a trace waits on that is neither the chain nor bounded by
   * a `TRACE_*` ceiling. Pyth's Benchmarks meters over a window rather than per
   * second and answers `Retry-After: 58`, which the client honours by pausing —
   * inside the request, after every transaction has already been read. A trace
   * could therefore spend most of its clock on a price series while the
   * coverage block said nothing about it, and the wallet crawl took the blame
   * for being slow. Carried here so the report can name the right upstream.
   */
  readonly pricesCutShort: boolean;
  /**
   * Days of history this scan set out to cover.
   *
   * Carried on the scan rather than read off the trace's own limits, because
   * the two answer paths do not cover the same window. A crawl covers what the
   * request could afford; the index covers whatever a backfill already paid
   * for, which is usually more. Reporting the request's setting for both would
   * describe a 365-day answer as a 90-day one.
   */
  readonly windowDays: number;
  /** Unix seconds of the oldest signature the crawl reached. */
  readonly oldestTs: number | null;
  readonly newestTs: number | null;
  /** True when the signature budget ran out before the lookback window did. */
  readonly truncated: boolean;
  /** Why the crawl stopped. Only `end_of_history` means nothing was left behind. */
  readonly stoppedAt: CrawlStop;
  /** True when the time budget, rather than a call ceiling, ended the crawl. */
  readonly stoppedOnTime: boolean;
  /** Signatures the crawl reached but never fetched a transaction for. */
  readonly transactionsUnread: number;
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
  /** Of those, how many got no USD price and so carry no weight in netting. */
  readonly unpricedSwaps: number;
  /** True when a budget stopped the crawl before it covered every interval. */
  readonly incomplete: boolean;
  readonly cost: ScanCost;
}

/**
 * Pool-crawl work remaining, shared by every pool in one trace.
 *
 * Deliberately not per pool. A trace with twelve losing positions can touch
 * twelve pools, and a per-pool budget quietly multiplies by twelve — the
 * configured ceiling then bears no relation to what a request actually spends,
 * and the trace times out instead of returning a smaller answer. One budget,
 * drawn down in order of the largest loss first, is a number an operator can
 * reason about against the timeout.
 */
export interface PoolCrawlBudget {
  signaturePages: number;
  transactions: number;
}

export function newPoolCrawlBudget(budget: ScanBudget): PoolCrawlBudget {
  return {
    signaturePages: budget.maxPoolSignaturePages,
    transactions: budget.maxPoolTransactions,
  };
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

/** Race marker for the price warm-up. A sentinel, so `null` stays a real result. */
const TIMED_OUT = Symbol('price warm-up deadline');

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

  /** The configured ceilings, so a caller can open a crawl budget against them. */
  get budget(): ScanBudget {
    return this.#budget;
  }

  /**
   * Every swap `wallet` made on a parsed venue within the lookback window.
   *
   * Note what is *not* filtered: a transaction the wallet signed can contain
   * swaps by other wallets — a router filling several orders, a bundler moving
   * inventory. Those are dropped by the wallet check rather than counted, or a
   * FIFO ledger would open lots the wallet never held.
   */
  async scanWallet(wallet: string, signal?: AbortSignal, deadline?: Deadline): Promise<WalletScan> {
    const cost: ScanCost = { signaturesRead: 0, transactionsFetched: 0 };
    const cutoff = nowSeconds() - daysToSeconds(this.#budget.lookbackDays);

    const crawl = await this.#crawlSignatures(wallet, cutoff, cost, signal, deadline);
    const usable = crawl.signatures.filter((entry) => entry.err == null);

    const parseSkips: Record<string, number> = {};
    const read = await this.#parseSignatures(usable, cost, parseSkips, signal, deadline);
    // The venue event names the trader, never the fee payer, so a wallet whose
    // entry legs are placed by a bot or an aggregator sees them land under that
    // bot's address. Those swaps are counted rather than silently dropped.
    const mine = read.parsed.filter((entry) => entry.swap.wallet === wallet);
    const normalised = await this.#normalise(mine, signal, deadline);

    /*
     * The window that was *read*, not the window that was crawled.
     *
     * Signatures are cheap and transactions are not, so a crawl routinely
     * reaches the cutoff and then runs out of clock partway through fetching
     * them. Taking the span from every signature seen would then report a year
     * of coverage over a read that stopped two months in — a configured
     * intention presented as a measurement, which is the §7.4 failure turned on
     * the coverage block itself. Signatures come back newest first, so what was
     * read is the head of the list.
     */
    const readSignatures = usable.slice(0, usable.length - read.unread);
    const times = readSignatures.map((entry) => entry.blockTime).filter(isNumber);

    return {
      wallet,
      swaps: normalised.swaps,
      census: censusOf(normalised.swaps),
      unpricedSwaps: normalised.unpriced,
      // Parsed swaps in the wallet's own transactions that another wallet made.
      // A large number beside an empty census means the trades are being made
      // through something else — a bot or a router whose own account signs.
      foreignSwaps: read.parsed.length - mine.length,
      parseSkips,
      pricesCutShort: normalised.pricesCutShort,
      windowDays: this.#budget.lookbackDays,
      oldestTs: times.length > 0 ? Math.min(...times) : null,
      newestTs: times.length > 0 ? Math.max(...times) : null,
      // Either ceiling leaves history behind, so both mean the same thing to a
      // reader: there is more of this wallet than the trace covers. The
      // lookback cutoff is deliberately not one of them — it leaves history
      // behind too, but by instruction rather than by running out, and
      // `stoppedAt` is what carries that difference.
      truncated: crawl.stoppedAt === 'signature_budget' || read.unread > 0,
      // A crawl that reached the cutoff but whose transactions were then cut
      // short by the clock did not really cover the window it claims to.
      stoppedAt: read.unread > 0 ? 'time_budget' : crawl.stoppedAt,
      stoppedOnTime: crawl.stoppedAt === 'time_budget' || read.stoppedOnTime,
      transactionsUnread: read.unread,
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
    budget: PoolCrawlBudget,
    signal?: AbortSignal,
    deadline?: Deadline,
  ): Promise<PoolScan> {
    const cost: ScanCost = { signaturesRead: 0, transactionsFetched: 0 };
    if (intervals.length === 0) {
      return { poolId, swaps: [], unpricedSwaps: 0, incomplete: false, cost };
    }
    if (budget.signaturePages <= 0 || budget.transactions <= 0 || past(deadline)) {
      // Earlier pools spent the trace's allowance, or its clock. Reported, never faked.
      return { poolId, swaps: [], unpricedSwaps: 0, incomplete: true, cost };
    }

    const merged = mergeIntervals(intervals);
    const earliest = Math.min(...merged.map((interval) => interval.fromTs));
    const wanted: SignatureInfo[] = [];

    let before: string | undefined;
    let reachedEarliest = false;
    let stoppedOnTime = false;

    while (budget.signaturePages > 0) {
      if (past(deadline)) {
        stoppedOnTime = true;
        break;
      }
      const page = await this.#rpc.getSignaturesForAddress(poolId, {
        limit: this.#budget.signaturePageSize,
        ...(before === undefined ? {} : { before }),
        ...(signal === undefined ? {} : { signal }),
      });
      budget.signaturePages -= 1;
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
      if (wanted.length >= budget.transactions) break;
    }

    const capped = wanted.slice(0, budget.transactions);
    budget.transactions -= capped.length;

    const read = await this.#parseSignatures(capped, cost, {}, signal, deadline);
    const normalised = await this.#normalise(
      read.parsed.filter((entry) => entry.swap.poolId === poolId),
      signal,
      deadline,
    );

    return {
      poolId,
      swaps: normalised.swaps,
      unpricedSwaps: normalised.unpriced,
      incomplete:
        !reachedEarliest || wanted.length > capped.length || stoppedOnTime || read.unread > 0,
      cost,
    };
  }

  async #crawlSignatures(
    address: string,
    cutoffTs: number,
    cost: ScanCost,
    signal?: AbortSignal,
    deadline?: Deadline,
  ): Promise<{ signatures: SignatureInfo[]; stoppedAt: CrawlStop }> {
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;

    while (signatures.length < this.#budget.maxSignatures) {
      if (past(deadline)) return { signatures, stoppedAt: 'time_budget' };

      const remaining = this.#budget.maxSignatures - signatures.length;
      const page = await this.#rpc.getSignaturesForAddress(address, {
        limit: Math.min(this.#budget.signaturePageSize, remaining),
        ...(before === undefined ? {} : { before }),
        ...(signal === undefined ? {} : { signal }),
      });
      cost.signaturesRead += page.length;
      // The address itself ran out. This is the only stop that means the trace
      // saw everything there is to see.
      if (page.length === 0) return { signatures, stoppedAt: 'end_of_history' };

      for (const entry of page) {
        if (entry.blockTime !== null && entry.blockTime < cutoffTs) {
          return { signatures, stoppedAt: 'lookback_cutoff' };
        }
        signatures.push(entry);
      }

      before = (page[page.length - 1] as SignatureInfo).signature;
    }

    return { signatures, stoppedAt: 'signature_budget' };
  }

  /**
   * Decodes a batch of transactions into swaps, tallying what was refused.
   *
   * The skips are the competing explanation for a missing trade, and they used
   * to be thrown on the floor here. Without them, a swap the parser could not
   * decode and a swap that belonged to another wallet are indistinguishable
   * from the outside — both are simply absent — and there is no way to tell a
   * broken decoder from a wallet that trades through a bot.
   */
  async #parseSignatures(
    signatures: readonly SignatureInfo[],
    cost: ScanCost,
    skips: Record<string, number>,
    signal?: AbortSignal,
    deadline?: Deadline,
  ): Promise<ParseRun> {
    const out: ParsedWithTime[] = [];
    if (signatures.length === 0) return { parsed: out, unread: 0, stoppedOnTime: false };

    // A window, not a batch. Chunking to the batch width handed the client one
    // batch per call, so the overlap inside it had nothing to overlap with and
    // the crawl waited out every round trip — the configured rate was never
    // reached and no counter said so. The deadline is now checked once per
    // window instead of once per batch, which is the price of the overlap.
    const size = Math.max(1, this.#rpc.transactionWindowSize);
    let read = 0;
    for (const group of chunk([...signatures], size)) {
      // Signatures arrive newest first, so stopping here drops the oldest — the
      // same shape as a shorter lookback, which the report already knows how to
      // describe. Stopping mid-crawl and returning what was read beats spending
      // the rest of the budget on a request the caller has already abandoned.
      if (past(deadline)) {
        return { parsed: out, unread: signatures.length - read, stoppedOnTime: true };
      }
      read += group.length;
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
          const parsed = parseTransaction(ctx);
          for (const entry of parsed.skipped) {
            const key = `${entry.venue}:${entry.reason}`;
            skips[key] = (skips[key] ?? 0) + 1;
          }
          for (const swap of parsed.swaps) {
            out.push({ swap, ctx, blockTime: swap.blockTime ?? raw.blockTime ?? info.blockTime });
          }
        } catch (error) {
          // One undecodable transaction must not end a trace. It is logged and
          // counted, exactly as the ingest pipeline treats it.
          skips['transaction:undecodable'] = (skips['transaction:undecodable'] ?? 0) + 1;
          this.#logger.debug(
            { signature: info.signature, err: describeError(error) },
            'skipping transaction that would not decode',
          );
        }
      });
    }

    return { parsed: out, unread: 0, stoppedOnTime: false };
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
    deadline?: Deadline,
  ): Promise<{ swaps: NormalisedSwap[]; unpriced: number; pricesCutShort: boolean }> {
    if (parsed.length === 0) return { swaps: [], unpriced: 0, pricesCutShort: false };

    const times = parsed.map((entry) => entry.blockTime).filter(isNumber);
    const warmed =
      times.length === 0
        ? true
        : await this.#warmPrices(Math.min(...times), Math.max(...times), signal, deadline);
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
    let unpriced = 0;
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
      if (price === null) unpriced += 1;

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

    return { swaps: out, unpriced, pricesCutShort: !warmed };
  }

  /**
   * Fills the SOL/USD series, but not past the clock the crawl was given.
   *
   * Every other wait in a trace is bounded: the signature ceiling, the
   * transaction ceiling and the deadline all have a field on the report behind
   * them. This one was not, and it is the only wait that happens *after* the
   * chain has already answered — so a trace could read a wallet in fifteen
   * seconds, spend ninety more inside Benchmarks' `Retry-After`, and come back
   * with a coverage block blaming the RPC endpoint. The price fetch is metered
   * over a window by a shared public service; it is exactly the upstream a
   * request cannot afford to wait on indefinitely.
   *
   * Giving up on the wait does not give up on the fetch. The cache is
   * process-wide and the fill keeps running behind this trace, so the minutes
   * land for the next one; this trace prices from what the series already holds
   * and `unpricedSwaps` counts the rest, which the report already explains.
   */
  async #warmPrices(
    fromTs: number,
    toTs: number,
    signal?: AbortSignal,
    deadline?: Deadline,
  ): Promise<boolean> {
    if (this.#warm === undefined) return true;

    const warm = this.#warm(fromTs, toTs, signal);
    if (deadline === undefined) {
      await warm;
      return true;
    }

    // Settled either way, so abandoning the race cannot leave a rejected
    // promise with nobody listening — which crashes the process, not the trace.
    const settled = warm.then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? error : new Error(`price warm-up failed: ${String(error)}`),
    );

    const left = deadline - Date.now();
    if (left <= 0) {
      this.#logger.warn(
        { fromTs, toTs },
        'no clock left to warm the SOL/USD series; pricing from what is held',
      );
      return false;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT);
      }, left);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([settled, expired]);
      if (outcome === TIMED_OUT) {
        this.#logger.warn(
          { fromTs, toTs, waitedMs: left },
          'the SOL/USD series did not fill inside this trace’s clock; pricing from what is held and reporting the rest unpriced',
        );
        return false;
      }
      // A warm-up that failed outright is the caller's business — an abort in
      // particular has to keep travelling rather than be read as a slow feed.
      if (outcome !== null) throw outcome;
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ParsedWithTime {
  readonly swap: ParsedSwap;
  readonly ctx: TxContext;
  readonly blockTime: number | null;
}

/** What one pass of `#parseSignatures` read, and what it left behind. */
interface ParseRun {
  readonly parsed: ParsedWithTime[];
  /** Signatures never fetched because the time budget ran out first. */
  readonly unread: number;
  readonly stoppedOnTime: boolean;
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
