/**
 * The JSON a trace returns.
 *
 * Shaped for the console to render directly, and deliberately explicit about
 * what it does not know. Spec §7.1 forbids claiming proof and §7.4 forbids
 * fabricated figures, so `coverage` and `notes` are part of the payload rather
 * than something the front end is trusted to remember to say.
 *
 * Every number is USD unless the field says otherwise. Slots are strings: they
 * are `u64` on chain, and a JSON number is a double.
 */

export type TraceStatus =
  /** Counterparties were found. */
  | 'ok'
  /** No swaps on a parsed venue in the lookback window. */
  | 'no_swaps'
  /** Swaps, but nothing closed at a loss with a basis we can stand behind. */
  | 'no_losses'
  /**
   * Sells with no buys behind them. The read lost the entry legs.
   *
   * Distinct from `no_losses` because it is not a finding about the wallet at
   * all. A wallet cannot sell what it never bought, so a ledger of sales with
   * no purchases is arithmetically impossible rather than merely quiet, and
   * every figure derived from it is void. Reporting it as "nothing closed in
   * the red" states a result the data cannot support — §7.1.
   */
  | 'unreadable_history'
  /**
   * The swaps were read but none of them could be given a USD price.
   *
   * Also distinct from `no_losses`, and for the same reason. Cost basis is a
   * dollar figure; with no price series behind it every position comes out
   * `unpriced`, attribution drops all of them, and the trace lands on "nothing
   * closed in the red" — a statement about the wallet caused by an outage at
   * the oracle. The wallet is not the thing that failed here, and saying so is
   * the difference between a user retrying in ten minutes and one concluding
   * the product does not work.
   */
  | 'unpriced_history'
  /** Losses, but no window produced an eligible counterparty. */
  | 'no_attribution';

/**
 * Which half of the system answered.
 *
 * `live` crawled the chain on this request, bounded by the clock and by an RPC
 * allowance. `index` read swaps a backfill had already written, which costs no
 * RPC and covers the whole window rather than as much of it as a request had
 * time for. The figures mean the same thing either way; what they cost, and how
 * complete they are, does not — so the reader is told.
 */
export type TraceSource = 'live' | 'index';

export interface TraceWindowRef {
  readonly mint: string;
  readonly symbol: string | null;
  readonly poolId: string;
  readonly venue: string;
  /** Unix seconds of the buy leg this window was built around. */
  readonly ts: number;
  readonly startSlot: string;
  readonly endSlot: string;
  readonly attributedUsd: number;
  /** This counterparty's share of the window, in [0, 1]. */
  readonly share: number;
  readonly buyLegSignature: string;
}

export interface TraceCounterparty {
  readonly wallet: string;
  readonly attributedUsd: number;
  readonly overlapCount: number;
  readonly mints: readonly string[];
  readonly windows: readonly TraceWindowRef[];
}

export interface TraceToken {
  readonly mint: string;
  readonly symbol: string | null;
  /** Realised loss on this token, as a positive number. */
  readonly lossUsd: number;
  /** Of that loss, how much was attributed to a counterparty. */
  readonly attributedUsd: number;
  readonly positions: number;
}

/**
 * The figures. Null everywhere attribution never ran, never zero.
 *
 * The four below used to be hardcoded zeros on every path that stopped before
 * attribution — so a trace that refused to answer still reported
 * `attributedUsd: 0`, and the page printed `$0` beside it as though it were a
 * measurement. Worse on `no_losses`, where the positions HAD been accounted and
 * `realisedPnlUsd: 0` overwrote a real figure: a wallet that closed ten
 * profitable positions was shown a flat zero. That is §7.4 exactly — a constant
 * wearing the clothes of a finding — one block below where the same fault was
 * already fixed in `coverage`.
 */
export interface TraceTotals {
  /** Sum of every attribution row. The headline figure. Null if it never ran. */
  readonly attributedUsd: number | null;
  /** Loss whose windows produced nothing. Never folded into `attributedUsd`. */
  readonly unattributedUsd: number | null;
  /** Realised loss across the positions attribution ran on. */
  readonly realisedLossUsd: number | null;
  /** Counterparties found. Null when attribution never ran; 0 is a finding. */
  readonly counterparties: number | null;
  readonly largestCounterpartyUsd: number | null;
  /**
   * Realised PnL across every closed position with a complete basis.
   *
   * Measured on every path that got as far as accounting positions, because it
   * does not need attribution — only a basis. Null only when there were no
   * swaps to account at all.
   */
  readonly realisedPnlUsd: number | null;
  readonly positionsClosed: number;
  readonly positionsInTheRed: number | null;
}

export interface TraceCoverage {
  /** Whether the chain was crawled for this trace, or the index read. */
  readonly source: TraceSource;
  readonly lookbackDays: number;
  /** Venues with a parser. Anything traded elsewhere is invisible to this. */
  readonly venues: readonly string[];
  readonly fromTs: number | null;
  readonly toTs: number | null;
  readonly signaturesRead: number;
  readonly transactionsFetched: number;
  /**
   * The wallet's own swaps, counted by venue and direction — `{"pumpfun:buy": 4}`.
   *
   * The first thing to look at when a result seems wrong. Sells with no buys
   * means the read lost half the trades, not that the wallet only ever sold,
   * and every downstream figure is meaningless until that is resolved.
   */
  readonly swapCensus: Readonly<Record<string, number>>;
  /**
   * Swaps found in the wallet's transactions that another wallet executed.
   *
   * High here with an empty census is the signature of a wallet that trades
   * through a bot: the transactions are signed by this address, but the venue's
   * event names a different trader, and only the event is authoritative.
   */
  readonly foreignSwaps: number;
  /**
   * The wallet's own swaps that got no USD price.
   *
   * Read beside `swapCensus`: equal counts mean nothing in this trace has a
   * dollar figure behind it, and every "no loss" below is an artefact of that
   * rather than a measurement.
   */
  readonly swapsUnpriced: number;
  /** Pool swaps in the netting windows with no price. Null when netting never ran. */
  readonly poolSwapsUnpriced: number | null;
  /**
   * The SOL/USD minute series the service actually holds, or null when it holds
   * none. A trace whose window sits outside this range cannot be priced.
   */
  readonly priceSeries: {
    readonly fromTs: number;
    readonly toTs: number;
    readonly minutes: number;
  } | null;
  /** True when the signature budget ran out before the lookback window did. */
  readonly historyTruncated: boolean;
  /**
   * Why the wallet crawl stopped. Only `end_of_history` means nothing was left.
   *
   * `lookback_cutoff` is the one that reads as success and is not: the crawl
   * did what it was told and stopped at `lookbackDays`, and everything older
   * than that is invisible to the trace. A wallet that bought outside the
   * window and sold inside it therefore comes back as sells with no buys, which
   * looks exactly like a broken read. It is the first thing to check before
   * blaming a parser or a bot.
   */
  readonly crawlStoppedAt:
    'end_of_history' | 'lookback_cutoff' | 'signature_budget' | 'time_budget';
  /**
   * True when the trace's *time* budget, not a call ceiling, ended the crawl.
   *
   * The two are different diagnoses. A call ceiling is a configured limit doing
   * its job; a clock that ran out means the RPC endpoint is answering slower
   * than the budget assumed, and raising the ceilings would make it worse.
   */
  readonly stoppedOnTimeBudget: boolean;
  /** Signatures reached but never fetched, because the clock ran out first. */
  readonly transactionsUnread: number;
  /**
   * True when this trace queued a full read of the wallet, out of band.
   *
   * A live crawl is one `getTransaction` per signature inside a web request,
   * and for an active wallet's year that arithmetic does not close at any
   * setting. When a trace was shaped by a budget rather than by the wallet, the
   * finding is turned into a request for a backfill — which has no browser
   * waiting on it — and the next trace is answered from the index.
   *
   * Only true when the request was actually recorded. The page tells the
   * visitor to come back, and a promise nobody wrote down would be a claim the
   * data does not support (§7.1).
   */
  readonly deepReadRequested: boolean;
  /** Losing positions found. Always measured. */
  readonly losingPositions: number;
  /**
   * How many of them attribution ran on. Null when it never ran.
   *
   * Null rather than zero, and the same for the two fields below, because a
   * zero here is indistinguishable from a measurement. A trace that stopped
   * before attribution reported `legsWithUnknownFees: 0`, which reads as "the
   * fees were all known" and is really "no leg was ever examined" — a
   * constant wearing the clothes of a finding. That cost a whole investigation
   * pass, which is precisely the §7.4 failure applied to our own diagnostics.
   */
  readonly positionsAttributed: number | null;
  /** Buy legs skipped because the per-position leg cap was reached. */
  readonly legsSkipped: number | null;
  /** Pools whose history could not be crawled far enough to net every window. */
  readonly poolsIncomplete: number;
  /** Positions excluded, by the reason they were excluded. */
  readonly excluded: Readonly<Record<string, number>>;
  /**
   * Venue instructions that matched a parser but produced no swap, by venue
   * and reason — `{"pumpfun:event_missing": 3}`.
   *
   * The competing explanation for a missing trade. Without it, a swap the
   * parser refused and a swap that belonged to another wallet look identical
   * from the outside: both are simply absent.
   */
  readonly parseSkips: Readonly<Record<string, number>>;
  /** Buy legs whose venue reports no fee. Null when no leg was examined. */
  readonly legsWithUnknownFees: number | null;
  readonly tokenSymbolsAvailable: boolean;
}

export interface TraceReport {
  readonly wallet: string;
  /** Unix seconds the trace was computed. */
  readonly generatedAt: number;
  readonly status: TraceStatus;
  readonly totals: TraceTotals;
  readonly tokens: readonly TraceToken[];
  readonly counterparties: readonly TraceCounterparty[];
  readonly coverage: TraceCoverage;
  /**
   * Caveats that apply to this specific trace, in plain English.
   *
   * Rendered verbatim. A figure that needs a qualifier and does not carry one
   * is the failure §7.1 describes: certainty the measurement does not have.
   */
  readonly notes: readonly string[];
  /** Milliseconds the scan took. Useful when a trace feels slow. */
  readonly elapsedMs: number;
}
