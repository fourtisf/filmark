import {
  PUMP_FUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  nowSeconds,
  silentLogger,
  type Logger,
  type NormalisedSwap,
} from '@exitliquidity/core';
import {
  DEFAULT_MAX_WINDOW_SEC,
  allocatePosition,
  buyLegInput,
  mergeResults,
  netWindow,
  rollUpByCounterparty,
  type AttributionResult,
  type LegWindow,
  type NettingOptions,
} from '@exitliquidity/attribution';
import {
  accountPositions,
  isAttributable,
  type Position,
  type PositionBuyLeg,
} from '@exitliquidity/positions';
import type { TokenMetadataResolver } from './metadata.js';
import {
  newPoolCrawlBudget,
  type ChainScanner,
  type Deadline,
  type TimeInterval,
  type WalletScan,
} from './scan.js';
import type {
  TraceCoverage,
  TraceCounterparty,
  TraceReport,
  TraceStatus,
  TraceToken,
  TraceTotals,
} from './report.js';

/** Venues with a parser. Everything else a wallet traded is invisible to a trace. */
export const PARSED_VENUES: readonly string[] = ['pumpfun', 'pumpswap'];

export const VENUE_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  pumpfun: PUMP_FUN_PROGRAM_ID,
  pumpswap: PUMPSWAP_PROGRAM_ID,
});

export interface TraceLimits {
  readonly lookbackDays: number;
  readonly maxPositions: number;
  readonly maxLegsPerPosition: number;
}

export interface TraceServiceOptions {
  readonly scanner: ChainScanner;
  readonly metadata: TokenMetadataResolver;
  readonly limits: TraceLimits;
  readonly netting?: NettingOptions;
  /**
   * The SOL/USD minutes the service holds right now, for the coverage block.
   *
   * Resolved per trace rather than injected once: the series grows as traces
   * warm it, and a snapshot taken at construction would report an empty cache
   * forever.
   */
  readonly priceSeries?: () => { fromTs: number; toTs: number; minutes: number } | null;
  readonly logger?: Logger;
}

/**
 * Share of a trace's time budget the wallet crawl may spend before pool
 * crawling gets what is left.
 *
 * Without a split the first stage would happily spend the whole clock and the
 * netting stage would find none, which produces a trace that read a wallet
 * perfectly and attributed nothing — the least useful of the two halves to
 * keep. Weighted towards the wallet because a trace with no swaps has nothing
 * to net in the first place.
 */
const WALLET_SCAN_TIME_SHARE = 0.6;

/**
 * One wallet in, one trace out.
 *
 * The pipeline is the spec's, in order: read the wallet's swaps (§2 Stage 1),
 * build FIFO positions from them (Stage 2), net each losing buy leg against the
 * pool activity around it (Stage 3), then scale the realised loss across the
 * wallets that were selling into those windows (Stage 4).
 *
 * What it does not do is fill gaps. A leg whose pool could not be crawled far
 * enough contributes to `unattributedUsd` and to a note, never to a
 * counterparty's total — the difference between measuring less than you hoped
 * and reporting more than you measured.
 */
export class TraceService {
  readonly #scanner: ChainScanner;
  readonly #metadata: TokenMetadataResolver;
  readonly #limits: TraceLimits;
  readonly #netting: NettingOptions;
  readonly #priceSeries: TraceServiceOptions['priceSeries'];
  readonly #logger: Logger;

  constructor(options: TraceServiceOptions) {
    this.#scanner = options.scanner;
    this.#metadata = options.metadata;
    this.#limits = options.limits;
    this.#netting = options.netting ?? {};
    this.#priceSeries = options.priceSeries;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * `deadline` is epoch milliseconds: the point past which the crawls stop and
   * report what they have. Omitted, a trace runs to its call ceilings and is
   * bounded only by the caller's own timeout — which returns nothing at all.
   */
  async trace(wallet: string, signal?: AbortSignal, deadline?: Deadline): Promise<TraceReport> {
    const startedAt = Date.now();
    const walletDeadline =
      deadline === undefined
        ? undefined
        : startedAt + Math.max(0, deadline - startedAt) * WALLET_SCAN_TIME_SHARE;

    const scan = await this.#scanner.scanWallet(wallet, signal, walletDeadline);

    const cost = { ...scan.cost };
    const notes: string[] = [];

    if (scan.stoppedOnTime) {
      notes.push(
        `The trace ran out of time before it ran out of budget${scan.transactionsUnread > 0 ? `, leaving ${scan.transactionsUnread.toLocaleString('en-US')} transactions unread` : ''}. Everything below is what was read in the time allowed, not everything there is — the RPC endpoint is answering slower than this trace's budget assumes.`,
      );
    } else if (scan.truncated) {
      notes.push(
        `Only the most recent ${cost.signaturesRead.toLocaleString('en-US')} transactions were read; this wallet has more history than one trace covers.`,
      );
    }

    if (scan.swaps.length === 0) {
      return this.#empty(wallet, 'no_swaps', scan, cost, startedAt, notes, 0);
    }

    if (scan.unpricedSwaps > 0 && scan.unpricedSwaps < scan.swaps.length) {
      notes.push(
        `${scan.unpricedSwaps} of ${scan.swaps.length} swaps had no SOL/USD price within the staleness bound. A position touching one of them is excluded from attribution rather than valued on a partial basis.`,
      );
    }

    const positions = accountPositions(wallet, scan.swaps);
    const excluded = tallyExclusions(positions);

    /*
     * A wallet cannot sell what it never bought.
     *
     * Sells with no buys is not a quiet quarter; it is arithmetically
     * impossible, and it means the read lost the entry legs rather than that
     * the wallet only ever sold. Every figure derived from it is void, so this
     * refuses to answer instead of reporting "nothing closed in the red" —
     * which is a finding the data cannot support (§7.1).
     *
     * The likeliest cause is the trader-identity filter in the scan: both
     * venues name the trader in their event, never the fee payer, so a wallet
     * whose entries are placed by a bot or an aggregator sees them land under
     * that bot's address. `foreignSwaps` is how many such swaps were seen in
     * this wallet's own transactions, and it is the number to look at first.
     */
    const sideTotal = (suffix: string): number =>
      Object.entries(scan.census)
        .filter(([key]) => key.endsWith(suffix))
        .reduce((total, [, count]) => total + count, 0);
    const buys = sideTotal(':buy');
    const sells = sideTotal(':sell');

    if (sells > 0 && buys === 0) {
      notes.push(
        `${sells} ${plural(sells, 'sell was', 'sells were')} read for this wallet and no buys at all, which cannot be what happened — a wallet cannot sell what it never bought. No profit or loss is reported rather than one invented from a basis that was never read.`,
        ...missingBuyLegCauses(scan, this.#limits.lookbackDays, this.#scanner.budget.maxSignatures),
      );
      return this.#empty(
        wallet,
        'unreadable_history',
        scan,
        cost,
        startedAt,
        notes,
        positions.filter((p) => p.status === 'closed').length,
        excluded,
      );
    }

    /*
     * Cost basis is a dollar figure, so a trace with no prices has no basis.
     *
     * Every position then comes out `unpriced`, `isAttributable` drops all of
     * them, and the trace lands on `no_losses` — "nothing closed in the red" —
     * which is a claim about the wallet produced by an outage at the price
     * oracle. §7.1 forbids exactly that, and the answer is the one
     * `unreadable_history` already uses: name the failure rather than report a
     * result the data cannot support. Checked after the buy-leg guard because a
     * read that lost half the trades is the more fundamental fault of the two.
     */
    if (scan.unpricedSwaps === scan.swaps.length) {
      notes.push(
        `All ${scan.swaps.length} ${plural(scan.swaps.length, 'swap', 'swaps')} read for this wallet came back with no USD price, so there is no cost basis to compute a profit or loss from. That is a failure at the SOL/USD feed, not a finding about the wallet: nothing is reported rather than a figure derived from a basis of zero. Retrying in a few minutes is the right response.`,
      );
      return this.#empty(
        wallet,
        'unpriced_history',
        scan,
        cost,
        startedAt,
        notes,
        positions.filter((p) => p.status === 'closed').length,
        excluded,
      );
    }

    const losing = positions
      .filter(isAttributable)
      .sort((a, b) => a.realisedPnlUsd - b.realisedPnlUsd);

    if (losing.length === 0) {
      return this.#empty(
        wallet,
        'no_losses',
        scan,
        cost,
        startedAt,
        notes,
        positions.filter((p) => p.status === 'closed').length,
        excluded,
      );
    }

    const analysed = losing.slice(0, this.#limits.maxPositions);
    if (losing.length > analysed.length) {
      notes.push(
        `${losing.length - analysed.length} smaller losing positions were not attributed; the ${analysed.length} largest were.`,
      );
    }

    const plan = this.#planLegs(analysed);
    const maxWindowSec = this.#netting.maxWindowSec ?? DEFAULT_MAX_WINDOW_SEC;
    const poolSwaps = new Map<string, readonly NormalisedSwap[]>();
    // One allowance for the whole trace, drawn down pool by pool. `analysed` is
    // ordered by largest loss, so what runs out of budget is what mattered least.
    const crawlBudget = newPoolCrawlBudget(this.#scanner.budget);
    let poolsIncomplete = 0;
    let poolSwapsUnpriced = 0;

    for (const [poolId, legs] of groupLegsByPool(plan.legs)) {
      const intervals: TimeInterval[] = legs.map((leg) => ({
        fromTs: leg.blockTime - maxWindowSec,
        toTs: leg.blockTime + maxWindowSec,
      }));
      const scanned = await this.#scanner.scanPool(
        poolId,
        intervals,
        crawlBudget,
        signal,
        deadline,
      );
      cost.signaturesRead += scanned.cost.signaturesRead;
      cost.transactionsFetched += scanned.cost.transactionsFetched;
      poolSwaps.set(poolId, scanned.swaps);
      poolSwapsUnpriced += scanned.unpricedSwaps;
      if (scanned.incomplete) poolsIncomplete += 1;
    }

    if (poolsIncomplete > 0) {
      notes.push(
        `${poolsIncomplete} pool${poolsIncomplete > 1 ? 's were' : ' was'} too busy to crawl back to every window within this trace's budget. The loss from those legs is reported as unattributed rather than spread over the counterparties that were found.`,
      );
    }

    if (poolSwapsUnpriced > 0) {
      notes.push(
        `${poolSwapsUnpriced} pool ${plural(poolSwapsUnpriced, 'swap', 'swaps')} inside these windows had no USD price. A sell that cannot be sized carries no weight, so those wallets are excluded rather than counted at zero.`,
      );
    }

    const results: AttributionResult[] = analysed.map((position) => {
      const legWindows: LegWindow[] = (plan.byPosition.get(position) ?? []).map((leg) => ({
        leg,
        window: netWindow(buyLegInput(leg, wallet), poolSwaps.get(leg.poolId) ?? [], this.#netting),
      }));
      return allocatePosition(position, legWindows);
    });

    const merged = mergeResults(results);
    const counterparties = rollUpByCounterparty(merged.rows);
    const symbols = await this.#symbols(analysed, signal);

    const status: TraceStatus = counterparties.length === 0 ? 'no_attribution' : 'ok';
    if (status === 'no_attribution') {
      notes.push(
        'Losses were found, but every wallet selling into their windows was filtered out as the trader itself, a round-tripping bot, or unpriced. Nothing is attributed rather than something invented.',
      );
    }

    if (plan.legsSkipped > 0) {
      notes.push(
        `${plan.legsSkipped} smaller buy legs were not netted, so their share of the loss is unattributed.`,
      );
    }

    const unknownFeeLegs = plan.legs.filter((leg) => !leg.feeKnown).length;
    if (unknownFeeLegs > 0) {
      notes.push(
        `${unknownFeeLegs} buy legs ran on the pump.fun bonding curve, which does not report its fee. Their cost basis — and so the loss — is understated by roughly the fee.`,
      );
    }

    notes.push(
      'Attribution measures overlap, not payment. On an AMM you trade against a pool; these are the wallets that were reducing supply into the same windows, weighted by size and proximity.',
    );

    const totals = buildTotals(positions, analysed, merged, counterparties);

    return {
      wallet,
      generatedAt: nowSeconds(),
      status,
      totals,
      tokens: buildTokens(analysed, merged, symbols),
      counterparties: counterparties.map((entry) => toCounterparty(entry, symbols)),
      coverage: this.#coverage(scan, cost, {
        losingPositions: losing.length,
        poolsIncomplete,
        excluded,
        positionsAttributed: analysed.length,
        legsSkipped: plan.legsSkipped,
        legsWithUnknownFees: unknownFeeLegs,
        poolSwapsUnpriced,
      }),
      notes,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * Chooses which buy legs are worth an RPC budget.
   *
   * Legs are taken largest basis first, because attribution scales with basis:
   * dropping the smallest leg of a position costs the least accuracy per call
   * saved. What is dropped is counted, never quietly rounded away.
   */
  #planLegs(positions: readonly Position[]): {
    legs: PositionBuyLeg[];
    byPosition: Map<Position, PositionBuyLeg[]>;
    legsSkipped: number;
  } {
    const byPosition = new Map<Position, PositionBuyLeg[]>();
    const legs: PositionBuyLeg[] = [];
    let legsSkipped = 0;

    for (const position of positions) {
      const ranked = [...position.legs].sort((a, b) => b.costBasisUsd - a.costBasisUsd);
      const taken = ranked.slice(0, this.#limits.maxLegsPerPosition);
      legsSkipped += ranked.length - taken.length;
      byPosition.set(position, taken);
      legs.push(...taken);
    }

    return { legs, byPosition, legsSkipped };
  }

  async #symbols(
    positions: readonly Position[],
    signal?: AbortSignal,
  ): Promise<Map<string, string | null>> {
    const mints = [...new Set(positions.map((position) => position.mint))];
    const out = new Map<string, string | null>();
    try {
      for (const [mint, meta] of await this.#metadata.resolve(mints, signal)) {
        out.set(mint, meta.symbol);
      }
    } catch (error) {
      // A display nicety must never fail a trace.
      this.#logger.debug({ err: error }, 'token symbols unavailable');
    }
    return out;
  }

  /**
   * The coverage block, built once for every path.
   *
   * There used to be two of these — one computed, one a literal in `#empty` —
   * and the literal reported `legsWithUnknownFees: 0` on a trace where no leg
   * was ever examined. A constant that reads as a measurement is the §7.4
   * failure turned inwards, and it cost a whole diagnostic pass. The fields
   * that only mean something once attribution runs are null until it does.
   */
  #coverage(
    scan: WalletScan,
    cost: { signaturesRead: number; transactionsFetched: number },
    measured: {
      losingPositions: number;
      poolsIncomplete: number;
      excluded: Record<string, number>;
      positionsAttributed: number | null;
      legsSkipped: number | null;
      legsWithUnknownFees: number | null;
      poolSwapsUnpriced: number | null;
    },
  ): TraceCoverage {
    return {
      lookbackDays: this.#limits.lookbackDays,
      venues: PARSED_VENUES,
      fromTs: scan.oldestTs,
      toTs: scan.newestTs,
      signaturesRead: cost.signaturesRead,
      transactionsFetched: cost.transactionsFetched,
      swapCensus: scan.census,
      foreignSwaps: scan.foreignSwaps,
      swapsUnpriced: scan.unpricedSwaps,
      priceSeries: this.#priceSeries?.() ?? null,
      parseSkips: scan.parseSkips,
      historyTruncated: scan.truncated,
      crawlStoppedAt: scan.stoppedAt,
      stoppedOnTimeBudget: scan.stoppedOnTime,
      transactionsUnread: scan.transactionsUnread,
      tokenSymbolsAvailable: this.#metadata.supported,
      ...measured,
    };
  }

  /** A trace that stopped before it had anything to attribute. */
  #empty(
    wallet: string,
    status: TraceStatus,
    scan: WalletScan,
    cost: { signaturesRead: number; transactionsFetched: number },
    startedAt: number,
    notes: string[],
    positionsClosed: number,
    excluded: Record<string, number> = {},
  ): TraceReport {
    return {
      wallet,
      generatedAt: nowSeconds(),
      status,
      totals: {
        attributedUsd: 0,
        unattributedUsd: 0,
        realisedLossUsd: 0,
        realisedPnlUsd: 0,
        positionsClosed,
        positionsInTheRed: 0,
        counterparties: 0,
        largestCounterpartyUsd: 0,
      },
      tokens: [],
      counterparties: [],
      coverage: this.#coverage(scan, cost, {
        losingPositions: 0,
        poolsIncomplete: 0,
        excluded,
        // Attribution never ran on this path. Null, not zero: see #coverage.
        positionsAttributed: null,
        legsSkipped: null,
        legsWithUnknownFees: null,
        poolSwapsUnpriced: null,
      }),
      notes,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function buildTotals(
  all: readonly Position[],
  analysed: readonly Position[],
  merged: AttributionResult,
  counterparties: readonly { attributedUsd: number }[],
): TraceTotals {
  const closed = all.filter((position) => position.status === 'closed');
  const complete = closed.filter((position) => position.basisQuality === 'complete');

  return {
    attributedUsd: merged.attributedUsd,
    unattributedUsd: merged.unattributedUsd,
    realisedLossUsd: analysed.reduce((sum, position) => sum + Math.abs(position.realisedPnlUsd), 0),
    realisedPnlUsd: complete.reduce((sum, position) => sum + position.realisedPnlUsd, 0),
    positionsClosed: closed.length,
    positionsInTheRed: complete.filter((position) => position.realisedPnlUsd < 0).length,
    counterparties: counterparties.length,
    largestCounterpartyUsd: counterparties[0]?.attributedUsd ?? 0,
  };
}

function buildTokens(
  analysed: readonly Position[],
  merged: AttributionResult,
  symbols: ReadonlyMap<string, string | null>,
): TraceToken[] {
  const byMint = new Map<string, { lossUsd: number; attributedUsd: number; positions: number }>();

  for (const position of analysed) {
    const entry = byMint.get(position.mint) ?? { lossUsd: 0, attributedUsd: 0, positions: 0 };
    entry.lossUsd += Math.abs(position.realisedPnlUsd);
    entry.positions += 1;
    byMint.set(position.mint, entry);
  }

  for (const row of merged.rows) {
    const entry = byMint.get(row.mint);
    if (entry !== undefined) entry.attributedUsd += row.attributedUsd;
  }

  return [...byMint.entries()]
    .map(([mint, entry]) => ({
      mint,
      symbol: symbols.get(mint) ?? null,
      lossUsd: entry.lossUsd,
      attributedUsd: entry.attributedUsd,
      positions: entry.positions,
    }))
    .sort((a, b) => b.lossUsd - a.lossUsd);
}

function toCounterparty(
  entry: ReturnType<typeof rollUpByCounterparty>[number],
  symbols: ReadonlyMap<string, string | null>,
): TraceCounterparty {
  return {
    wallet: entry.counterparty,
    attributedUsd: entry.attributedUsd,
    overlapCount: entry.rows.length,
    mints: entry.mints,
    windows: entry.rows.map((row) => ({
      mint: row.mint,
      symbol: symbols.get(row.mint) ?? null,
      poolId: row.poolId,
      venue: row.venue,
      ts: row.windowTs,
      startSlot: row.windowStartSlot.toString(),
      endSlot: row.windowEndSlot.toString(),
      attributedUsd: row.attributedUsd,
      share: row.share,
      buyLegSignature: row.buyLegSignature,
    })),
  };
}

function tallyExclusions(positions: readonly Position[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const position of positions) {
    if (isAttributable(position)) continue;
    const reason =
      position.status === 'open'
        ? 'still_open'
        : position.basisQuality !== 'complete'
          ? position.basisQuality
          : 'not_a_loss';
    tally[reason] = (tally[reason] ?? 0) + 1;
  }
  return tally;
}

/** Agreement for a count, so a note does not read "1 sells were read". */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Why the entry legs are missing, ranked by what this trace actually measured.
 *
 * The note this replaces named two causes in a fixed order and led with the
 * bot one — while printing `0 such swaps were seen`, its own evidence against
 * itself, in the same sentence. Worse, it never mentioned the lookback at all,
 * which is the likeliest cause by some distance: a wallet that bought before
 * the window and sold inside it produces exactly this shape, and the crawl
 * stopping at `lookback_cutoff` says so outright. Ordering by evidence is the
 * difference between a diagnosis and a list of things it could be.
 */
function missingBuyLegCauses(scan: WalletScan, lookbackDays: number, budget: number): string[] {
  const causes: string[] = [];

  if (scan.stoppedAt === 'lookback_cutoff') {
    const read = scan.cost.transactionsFetched;
    // What the same signature budget would buy at this wallet's own density.
    const affordableDays = read > 0 ? Math.floor((budget / read) * lookbackDays) : lookbackDays;
    causes.push(
      `The crawl stopped at the ${lookbackDays}-day lookback with history still behind it, so the simplest explanation is also the likeliest: the buys are older than the window. Nothing before ${new Date((scan.oldestTs ?? 0) * 1000).toISOString().slice(0, 10)} was read at all. This wallet spent ${read.toLocaleString('en-US')} of a ${budget.toLocaleString('en-US')} signature budget, which at the same density covers roughly ${affordableDays.toLocaleString('en-US')} days — raise TRACE_LOOKBACK_DAYS and run it again before concluding anything else.`,
    );
  } else if (scan.stoppedAt === 'signature_budget' || scan.stoppedAt === 'time_budget') {
    causes.push(
      `The crawl ran out of ${scan.stoppedAt === 'time_budget' ? 'time' : 'signature budget'} before it reached the ${lookbackDays}-day cutoff, so older history — including, most likely, the buys — was never read.`,
    );
  }

  if (scan.foreignSwaps > 0) {
    causes.push(
      `${scan.foreignSwaps} ${plural(scan.foreignSwaps, 'swap', 'swaps')} in this wallet's own transactions were executed by a different address. Both venues name the trader inside their own event rather than the fee payer, so entries placed through Axiom, Photon, BullX or Trojan land under the bot's address; if that count is large, it names the address worth tracing instead.`,
    );
  }

  causes.push(
    `The other possibility is a venue with no parser here. This build reads ${PARSED_VENUES.join(' and ')} and nothing else, so a buy filled on Raydium, Meteora or anywhere further afield is invisible to it — as are tokens that arrived by transfer rather than by purchase.`,
  );

  return causes;
}

/** Buy legs grouped by the pool whose history has to be crawled for them. */
function groupLegsByPool(legs: readonly PositionBuyLeg[]): Map<string, PositionBuyLeg[]> {
  const byPool = new Map<string, PositionBuyLeg[]>();
  for (const leg of legs) {
    const bucket = byPool.get(leg.poolId);
    if (bucket === undefined) byPool.set(leg.poolId, [leg]);
    else bucket.push(leg);
  }
  return byPool;
}
