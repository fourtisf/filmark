import { describe, expect, it, vi } from 'vitest';
import type { WalletIndexRequestRepository } from '@exitliquidity/clickhouse';
import { ClickHouseIndexRequester, indexRequestReason } from './index-request.js';
import type { TraceCoverage, TraceReport, TraceStatus } from './report.js';

const WALLET = '3dG3bmDE6uDDRAqmLZTqHcmBDsCLAuP2HeDXmRyzN7vi';

function report(status: TraceStatus, coverage: Partial<TraceCoverage> = {}): TraceReport {
  return {
    wallet: WALLET,
    generatedAt: 0,
    status,
    totals: {
      attributedUsd: 0,
      unattributedUsd: 0,
      realisedLossUsd: 0,
      realisedPnlUsd: 0,
      positionsClosed: 0,
      positionsInTheRed: 0,
      counterparties: 0,
      largestCounterpartyUsd: 0,
    },
    tokens: [],
    counterparties: [],
    coverage: {
      source: 'live',
      lookbackDays: 90,
      venues: ['pumpfun', 'pumpswap'],
      fromTs: null,
      toTs: null,
      signaturesRead: 0,
      transactionsFetched: 0,
      swapCensus: {},
      foreignSwaps: 0,
      swapsUnpriced: 0,
      priceSeries: null,
      pricesCutShort: false,
      parseSkips: {},
      historyTruncated: false,
      crawlStoppedAt: 'end_of_history',
      stoppedOnTimeBudget: false,
      transactionsUnread: 0,
      deepReadRequested: false,
      deepReadNeeded: false,
      losingPositions: 0,
      positionsAttributed: null,
      legsSkipped: null,
      poolsIncomplete: 0,
      excluded: {},
      legsWithUnknownFees: null,
      tokenSymbolsAvailable: false,
      ...coverage,
    },
    notes: [],
    elapsedMs: 0,
  };
}

describe('indexRequestReason', () => {
  it('queues the wallet on screen: sells with no buys', () => {
    expect(indexRequestReason(report('unreadable_history'))).toBe('sells_without_buys');
  });

  it('queues a trace the clock cut short, even when it produced an answer', () => {
    /*
     * The one that matters most and looks least broken.
     *
     * A trace that ran out of clock still returns counterparties — just fewer
     * than exist, computed from whichever end of the history it managed to
     * read. Nothing about that output says "incomplete" to a visitor, so it is
     * exactly the case where queueing a proper read has to be automatic.
     */
    expect(
      indexRequestReason(
        report('ok', { stoppedOnTimeBudget: true, crawlStoppedAt: 'time_budget' }),
      ),
    ).toBe('cut_short_by_clock');
  });

  it('queues a trace that ran out of signature budget', () => {
    expect(indexRequestReason(report('ok', { crawlStoppedAt: 'signature_budget' }))).toBe(
      'cut_short_by_budget',
    );
  });

  it('queues a trace with no prices, because that is a feed outage not a finding', () => {
    expect(indexRequestReason(report('unpriced_history'))).toBe('no_prices');
  });

  it('does not queue a wallet the crawl read to the end of', () => {
    // `end_of_history` means the wallet ran out, not the budget. Nothing a
    // backfill could add.
    expect(indexRequestReason(report('no_losses'))).toBeNull();
    expect(indexRequestReason(report('ok'))).toBeNull();
  });

  it('does not queue a crawl that stopped where it was told to', () => {
    /*
     * `lookback_cutoff` is the stop reason that is not a budget running out.
     * Queueing it would queue every healthy wallet on the site — which is how
     * a queue stops meaning anything, and how one visitor's trace becomes
     * everyone else's slow one.
     */
    expect(indexRequestReason(report('ok', { crawlStoppedAt: 'lookback_cutoff' }))).toBeNull();
  });

  it('does not queue what the index already answered', () => {
    // Every request would otherwise ask for the thing it was just served,
    // forever. Keeping the index current belongs to the worker.
    expect(indexRequestReason(report('unreadable_history', { source: 'index' }))).toBeNull();
  });
});

describe('ClickHouseIndexRequester', () => {
  it('records the wallet, the window and why', async () => {
    const asked: unknown[] = [];
    const repository = {
      request: async (request: unknown) => {
        asked.push(request);
      },
    } as unknown as WalletIndexRequestRepository;

    const requester = new ClickHouseIndexRequester({ repository, days: 365 });

    expect(await requester.request(report('unreadable_history'))).toBe(true);
    expect(asked).toEqual([{ wallet: WALLET, days: 365, reason: 'sells_without_buys' }]);
  });

  it('answers false rather than throwing when the store refuses', async () => {
    // A trace that was computed successfully must not fail on the bookkeeping
    // that follows it — and the page must not claim a queue place it never got.
    const repository = {
      request: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as WalletIndexRequestRepository;

    const requester = new ClickHouseIndexRequester({ repository, days: 365 });

    expect(await requester.request(report('unreadable_history'))).toBe(false);
  });

  it('gives up on a store that hangs, instead of holding the response open', async () => {
    vi.useFakeTimers();
    try {
      const repository = {
        // A store that accepts the insert and never answers, which is what a
        // saturated ClickHouse looks like from here.
        request: () =>
          new Promise<void>(() => {
            /* never settles */
          }),
      } as unknown as WalletIndexRequestRepository;

      const requester = new ClickHouseIndexRequester({ repository, days: 365, timeoutMs: 50 });
      const pending = requester.request(report('unreadable_history'));
      await vi.advanceTimersByTimeAsync(60);

      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch the store at all for a trace that needs no deep read', async () => {
    let called = false;
    const repository = {
      request: async () => {
        called = true;
      },
    } as unknown as WalletIndexRequestRepository;

    const requester = new ClickHouseIndexRequester({ repository, days: 365 });

    expect(await requester.request(report('ok'))).toBe(false);
    expect(called).toBe(false);
  });
});
