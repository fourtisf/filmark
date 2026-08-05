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
  /** Losses, but no window produced an eligible counterparty. */
  | 'no_attribution';

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

export interface TraceTotals {
  /** Sum of every attribution row. The headline figure. */
  readonly attributedUsd: number;
  /** Loss whose windows produced nothing. Never folded into `attributedUsd`. */
  readonly unattributedUsd: number;
  /** Realised loss across the positions attribution ran on. */
  readonly realisedLossUsd: number;
  /** Realised PnL across every closed position with a complete basis. */
  readonly realisedPnlUsd: number;
  readonly positionsClosed: number;
  readonly positionsInTheRed: number;
  readonly counterparties: number;
  readonly largestCounterpartyUsd: number;
}

export interface TraceCoverage {
  readonly lookbackDays: number;
  /** Venues with a parser. Anything traded elsewhere is invisible to this. */
  readonly venues: readonly string[];
  readonly fromTs: number | null;
  readonly toTs: number | null;
  readonly signaturesRead: number;
  readonly transactionsFetched: number;
  /** True when the signature budget ran out before the lookback window did. */
  readonly historyTruncated: boolean;
  /** Losing positions found, and how many attribution actually ran on. */
  readonly losingPositions: number;
  readonly positionsAttributed: number;
  /** Buy legs skipped because the per-position leg cap was reached. */
  readonly legsSkipped: number;
  /** Pools whose history could not be crawled far enough to net every window. */
  readonly poolsIncomplete: number;
  /** Positions excluded, by the reason they were excluded. */
  readonly excluded: Readonly<Record<string, number>>;
  /** Buy legs whose venue reports no fee, so their basis is understated. */
  readonly legsWithUnknownFees: number;
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
