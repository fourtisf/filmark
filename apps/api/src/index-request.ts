import { describeError, silentLogger, type Logger } from '@exitliquidity/core';
import type { WalletIndexRequestRepository } from '@exitliquidity/clickhouse';
import type { TraceReport } from './report.js';

/**
 * Why a wallet was asked for, from a fixed set so a full queue is diagnosable.
 *
 * Not free text: `reason` is a `LowCardinality(String)` and the point of it is
 * to answer "why is this queue long" with a `GROUP BY`, which an open-ended
 * string cannot do.
 */
export type IndexRequestReason =
  'cut_short_by_clock' | 'cut_short_by_budget' | 'sells_without_buys' | 'no_prices';

export interface WalletIndexRequester {
  /**
   * Asks for this wallet to be read properly, out of band.
   *
   * Resolves to true only when the request was actually recorded, because the
   * page tells the visitor about it and a promise nobody wrote down is exactly
   * the invented finding §7.1 forbids. Never rejects: a trace that was computed
   * successfully must not fail on the bookkeeping that follows it.
   */
  request(report: TraceReport): Promise<boolean>;
}

export interface IndexRequestOptions {
  readonly repository: WalletIndexRequestRepository;
  /** Days of history to ask for. A backfill has no request to fit inside. */
  readonly days: number;
  /**
   * Longest the visitor waits on the bookkeeping insert.
   *
   * Small on purpose. The trace is already computed and about to be returned;
   * trading a working answer for a row in a queue table is the wrong way round.
   */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 1_000;

/**
 * Decides whether a finished trace is one the chain could not answer properly.
 *
 * The live crawl is one `getTransaction` per signature against a per-second
 * allowance, inside a web request. For a wallet with a year of activity that
 * arithmetic does not close, and no amount of tuning changes it — the crawl
 * comes back cut short, or worse, reaches a cutoff sitting between a wallet's
 * buys and its sells and produces a history that cannot have happened.
 *
 * The answer is not a faster crawl. It is to pay for that wallet's history once,
 * out of band where nothing is waiting, and serve it from the index afterwards.
 * This is how a trace asks for that: it reads what the trace it just produced
 * actually reported, and if the answer was shaped by a budget rather than by the
 * wallet, it says so in a table a worker reads.
 */
export function indexRequestReason(report: TraceReport): IndexRequestReason | null {
  // Already served from the index, so asking again would be asking for what was
  // just used. Keeping it current is the worker's business, not a visitor's.
  if (report.coverage.source === 'index') return null;

  if (report.status === 'unreadable_history') return 'sells_without_buys';
  if (report.status === 'unpriced_history') return 'no_prices';
  if (report.coverage.stoppedOnTimeBudget) return 'cut_short_by_clock';
  if (report.coverage.crawlStoppedAt === 'signature_budget') return 'cut_short_by_budget';

  /*
   * `lookback_cutoff` and `end_of_history` are deliberately not here.
   *
   * They are the two stop reasons that are not a budget running out: the crawl
   * read everything it was asked for and stopped where it was told to, or ran
   * out of wallet. Queueing those would queue every healthy wallet on the site,
   * which is how a queue stops meaning anything.
   */
  return null;
}

export class ClickHouseIndexRequester implements WalletIndexRequester {
  readonly #repository: WalletIndexRequestRepository;
  readonly #days: number;
  readonly #timeoutMs: number;
  readonly #logger: Logger;

  constructor(options: IndexRequestOptions) {
    this.#repository = options.repository;
    this.#days = options.days;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger ?? silentLogger;
  }

  async request(report: TraceReport): Promise<boolean> {
    const reason = indexRequestReason(report);
    if (reason === null) return false;

    const timeout = new Promise<false>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, this.#timeoutMs).unref();
    });

    const insert = this.#repository
      .request({ wallet: report.wallet, days: this.#days, reason })
      .then(() => {
        this.#logger.info(
          { wallet: report.wallet, reason, days: this.#days },
          'queued a deep read of this wallet; the next trace of it is answered from the index',
        );
        return true;
      })
      .catch((error: unknown) => {
        this.#logger.warn(
          { wallet: report.wallet, reason, err: describeError(error) },
          'could not queue a deep read of this wallet',
        );
        return false;
      });

    return Promise.race([insert, timeout]);
  }
}
