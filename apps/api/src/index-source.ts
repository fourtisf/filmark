import {
  daysToSeconds,
  describeError,
  nowSeconds,
  silentLogger,
  type Logger,
} from '@exitliquidity/core';
import type { SwapRepository, WalletCoverageRepository } from '@exitliquidity/clickhouse';
import { censusOf, type WalletScan } from './scan.js';

export interface IndexedWalletSource {
  /**
   * The wallet's swaps from the index, or null when the index cannot answer.
   *
   * Null is the important half. A wallet with no rows is either one that never
   * traded on a parsed venue or one nobody has backfilled, and serving the
   * first answer for the second case invents a finding — which is the whole
   * reason coverage is recorded separately from the rows themselves.
   */
  read(wallet: string, lookbackDays: number): Promise<WalletScan | null>;
}

export interface IndexSourceOptions {
  readonly swaps: SwapRepository;
  readonly coverage: WalletCoverageRepository;
  readonly logger?: Logger;
}

/**
 * Serves a trace from the swap index when the index has been told to cover it.
 *
 * A live crawl is one `getTransaction` per signature, and a wallet's year is
 * thousands of them against a per-second allowance — no arrangement of the
 * crawl makes that a web request. The index is the other shape of the same
 * work: paid once, by a backfill with no browser waiting on it, and read back
 * in a query. What this class adds is the honesty about which of the two
 * answered, because an index that quietly serves a narrower window than it was
 * asked for is worse than no index at all.
 */
export class ClickHouseWalletSource implements IndexedWalletSource {
  readonly #swaps: SwapRepository;
  readonly #coverage: WalletCoverageRepository;
  readonly #logger: Logger;

  constructor(options: IndexSourceOptions) {
    this.#swaps = options.swaps;
    this.#coverage = options.coverage;
    this.#logger = options.logger ?? silentLogger;
  }

  async read(wallet: string, lookbackDays: number): Promise<WalletScan | null> {
    const toTs = nowSeconds();
    const fromTs = toTs - daysToSeconds(lookbackDays);

    let covered;
    try {
      covered = await this.#coverage.get(wallet);
    } catch (error) {
      // The index being unreachable is not a reason to refuse a trace; the
      // chain is still there. Logged, then out of the way.
      this.#logger.warn(
        { wallet, err: describeError(error) },
        'could not read index coverage; falling back to a live crawl',
      );
      return null;
    }

    if (covered === null) return null;

    /*
     * The window has to be covered at both ends.
     *
     * `fromTs` is obvious — an index backfilled for 60 days cannot answer a
     * 365-day question. `toTs` is the one that bites quietly: a backfill run
     * yesterday knows nothing about today's trades, and serving it as current
     * would report a wallet as having stopped trading when it had not. The
     * staleness allowance is one lookback-day, so a daily re-backfill keeps a
     * wallet served and a forgotten one falls back to the chain by itself.
     */
    const staleness = daysToSeconds(1);
    if (covered.fromTs > fromTs || covered.toTs < toTs - staleness) return null;

    const swaps = await this.#swaps.walletSwaps(wallet, fromTs, toTs);

    return {
      wallet,
      swaps,
      census: censusOf(swaps),
      unpricedSwaps: swaps.filter((swap) => swap.usdValue === null).length,
      // The index stores what the wallet itself executed; a swap by another
      // address was never written under this wallet, so there is nothing to
      // count here and reporting a zero would be a measurement, not a guess.
      foreignSwaps: 0,
      parseSkips: {},
      oldestTs: swaps[0]?.blockTime ?? null,
      newestTs: swaps[swaps.length - 1]?.blockTime ?? null,
      truncated: false,
      // A backfill runs to its cutoff or it does not record coverage at all,
      // so anything served from here reached the end of its window.
      stoppedAt: 'lookback_cutoff',
      stoppedOnTime: false,
      transactionsUnread: 0,
      // No RPC was spent. Saying so is the point.
      cost: { signaturesRead: 0, transactionsFetched: 0 },
    };
  }
}
