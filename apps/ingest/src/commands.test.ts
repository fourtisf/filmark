import { describe, expect, it } from 'vitest';
import { loadConfig, silentLogger } from '@exitliquidity/core';
import type { WalletCoverage } from '@exitliquidity/clickhouse';
import { runBackfill } from './commands.js';
import type { BackfillRequest, BackfillResult, BackfillRunner } from './backfill/runner.js';
import type { Services } from './services.js';

const WALLET = '3dG3bmDE6uDDRAqmLZTqHcmBDsCLAuP2HeDXmRyzN7vi';

function result(overrides: Partial<BackfillResult> = {}): BackfillResult {
  return {
    address: WALLET,
    signaturesScanned: 100,
    signaturesSkippedFailed: 0,
    transactionsFetched: 100,
    transactionsMissing: 0,
    swapsWritten: 12,
    parseSkips: 0,
    oldestBlockTime: 1_781_537_052,
    newestBlockTime: 1_781_862_521,
    coveredWindow: true,
    ...overrides,
  };
}

interface Harness {
  readonly services: Services;
  readonly runner: BackfillRunner;
  readonly recorded: WalletCoverage[];
  readonly flushes: number[];
  readonly priced: { fromSec: number; toSec: number }[];
}

function harness(
  options: {
    crawl?: BackfillResult;
    priceFailure?: Error;
    env?: Record<string, string>;
  } = {},
): Harness {
  const recorded: WalletCoverage[] = [];
  const priced: { fromSec: number; toSec: number }[] = [];
  const flushes: number[] = [];
  let order = 0;

  const services = {
    config: loadConfig({ ...options.env }),
    logger: silentLogger,
    prices: {
      ensureRange: async (fromSec: number, toSec: number) => {
        if (options.priceFailure !== undefined) throw options.priceFailure;
        priced.push({ fromSec, toSec });
        return { requestedMinutes: 0, alreadyStored: 0, fetched: 0, stillMissing: 0 };
      },
    },
    writer: {
      flush: async () => {
        flushes.push((order += 1));
      },
    },
    walletCoverage: {
      record: async (coverage: WalletCoverage) => {
        // Ordered after the flush, so a coverage row never promises rows that
        // are still sitting in the writer's buffer.
        expect(flushes.length).toBeGreaterThan(0);
        recorded.push(coverage);
      },
    },
  } as unknown as Services;

  const runner = {
    run: async (_request: BackfillRequest) => options.crawl ?? result(),
  } as unknown as BackfillRunner;

  return { services, runner, recorded, flushes, priced };
}

describe('runBackfill', () => {
  it('records the coverage row a later trace is answered from', async () => {
    /*
     * The whole point of a backfill, and the half the queue used to skip.
     *
     * `ClickHouseWalletSource` refuses to serve any wallet without this row,
     * because rows-with-no-coverage cannot be told apart from a wallet nobody
     * has crawled. A worker that writes swaps and no coverage therefore does a
     * perfect job that changes nothing anybody can see.
     */
    const h = harness();

    const out = await runBackfill(
      h.services,
      h.runner,
      { address: WALLET },
      new AbortController().signal,
    );

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.wallet).toBe(WALLET);
    expect(h.recorded[0]?.swaps).toBe(12);
    expect(h.recorded[0]?.pricesReady).toBe(true);
    expect(out.pricesReady).toBe(true);
  });

  it('records nothing when the crawl did not reach its cutoff', async () => {
    // A run cut short covers less than its window claims, and the coverage row
    // is a promise about the window — not about the rows that happened to land.
    const h = harness({ crawl: result({ coveredWindow: false }) });

    await runBackfill(h.services, h.runner, { address: WALLET }, new AbortController().signal);

    expect(h.recorded).toHaveLength(0);
  });

  it('crawls anyway when the price feed refuses, and says the prices are not ready', async () => {
    const h = harness({ priceFailure: new Error('429 Too Many Requests') });

    const out = await runBackfill(
      h.services,
      h.runner,
      { address: WALLET },
      new AbortController().signal,
    );

    // Swaps are the part nobody can reconstruct later; prices replace in place
    // on a re-run. So the crawl still happened and the coverage still says so.
    expect(out.swapsWritten).toBe(12);
    expect(out.pricesReady).toBe(false);
    expect(h.recorded[0]?.pricesReady).toBe(false);
  });

  it('skips the price fill entirely when asked to', async () => {
    const h = harness();

    const out = await runBackfill(
      h.services,
      h.runner,
      { address: WALLET, withPrices: false },
      new AbortController().signal,
    );

    expect(h.priced).toHaveLength(0);
    // Nothing was attempted, so nothing may be claimed about the prices.
    expect(out.pricesReady).toBe(false);
    expect(h.recorded[0]?.pricesReady).toBe(false);
  });

  it('fills prices across the window it is about to crawl', async () => {
    const h = harness({ env: { BACKFILL_DEFAULT_DAYS: '365' } });

    await runBackfill(h.services, h.runner, { address: WALLET }, new AbortController().signal);

    expect(h.priced).toHaveLength(1);
    const window = h.priced[0] as { toSec: number; fromSec: number };
    const days = (window.toSec - window.fromSec) / 86_400;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
  });
});
