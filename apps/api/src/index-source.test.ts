import { describe, expect, it } from 'vitest';
import { daysToSeconds, nowSeconds, type NormalisedSwap } from '@exitliquidity/core';
import type {
  SwapRepository,
  WalletCoverage,
  WalletCoverageRepository,
} from '@exitliquidity/clickhouse';
import { ClickHouseWalletSource } from './index-source.js';

const WALLET = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const MINT = 'So11111111111111111111111111111111111111112';

function swap(overrides: Partial<NormalisedSwap> = {}): NormalisedSwap {
  return {
    signature: 'sig',
    slot: 1n,
    blockTime: nowSeconds(),
    venue: 'pumpfun',
    side: 'buy',
    wallet: WALLET,
    poolId: 'pool',
    mint: MINT,
    baseAmount: 1,
    quoteAmount: 1,
    usdValue: 10,
    feeLamports: 0n,
    ixIndex: 0,
    innerIxIndex: null,
    ...overrides,
  } as NormalisedSwap;
}

/** Records the range it was asked for, so the window can be asserted directly. */
function repositories(options: {
  coverage: WalletCoverage | null;
  swaps?: readonly NormalisedSwap[];
}): {
  source: ClickHouseWalletSource;
  asked: { fromSec: number; toSec: number }[];
} {
  const asked: { fromSec: number; toSec: number }[] = [];

  const swaps = {
    walletSwaps: async (_wallet: string, fromSec: number, toSec: number) => {
      asked.push({ fromSec, toSec });
      return options.swaps ?? [];
    },
  } as unknown as SwapRepository;

  const coverage = {
    get: async () => options.coverage,
  } as unknown as WalletCoverageRepository;

  return { source: new ClickHouseWalletSource({ swaps, coverage }), asked };
}

describe('ClickHouseWalletSource', () => {
  it('reads the whole covered window, not the narrower one the crawl was budgeted for', async () => {
    /*
     * The bug this pins.
     *
     * `lookbackDays` exists because a live crawl pays one getTransaction per
     * signature and has a request to fit inside. A ClickHouse read costs the
     * same single query at any depth, so applying that budget to the index
     * discards history a backfill already paid for — and discards it at the
     * older end, which is exactly where the buy legs are. The wallet then comes
     * back as sells with no buys and the trace correctly refuses to answer,
     * while the index was holding the buys the whole time.
     */
    const now = nowSeconds();
    const { source, asked } = repositories({
      coverage: {
        wallet: WALLET,
        fromTs: now - daysToSeconds(365),
        toTs: now,
        swaps: 163,
        pricesReady: true,
        updatedAt: now,
      },
      swaps: [swap()],
    });

    const scan = await source.read(WALLET, 90);

    expect(scan).not.toBeNull();
    expect(asked).toHaveLength(1);
    const window = (now - (asked[0]?.fromSec ?? 0)) / daysToSeconds(1);
    expect(window).toBeGreaterThan(360);
    // And the report has to say 365, not the 90 it was configured for.
    expect(scan?.windowDays).toBeGreaterThan(360);
  });

  it('does not claim a wider window than it read when coverage is the narrower of the two', async () => {
    const now = nowSeconds();
    const { source, asked } = repositories({
      coverage: {
        wallet: WALLET,
        fromTs: now - daysToSeconds(90),
        toTs: now,
        swaps: 2,
        pricesReady: true,
        updatedAt: now,
      },
      swaps: [swap()],
    });

    const scan = await source.read(WALLET, 90);

    expect(scan?.windowDays).toBeLessThanOrEqual(91);
    expect((now - (asked[0]?.fromSec ?? 0)) / daysToSeconds(1)).toBeLessThan(91);
  });

  it('refuses when no backfill has covered the wallet at all', async () => {
    const { source, asked } = repositories({ coverage: null });
    expect(await source.read(WALLET, 90)).toBeNull();
    // And it must not have gone looking for rows it had no promise about: an
    // empty result there is indistinguishable from a wallet that never traded.
    expect(asked).toHaveLength(0);
  });

  it('refuses when the index does not reach as far back as the trace asks', async () => {
    const now = nowSeconds();
    const { source } = repositories({
      coverage: {
        wallet: WALLET,
        fromTs: now - daysToSeconds(60),
        toTs: now,
        swaps: 2,
        pricesReady: true,
        updatedAt: now,
      },
    });

    expect(await source.read(WALLET, 365)).toBeNull();
  });

  it('refuses a backfill too stale to know about recent trades', async () => {
    const now = nowSeconds();
    const { source } = repositories({
      coverage: {
        wallet: WALLET,
        fromTs: now - daysToSeconds(365),
        toTs: now - daysToSeconds(9),
        swaps: 2,
        pricesReady: true,
        updatedAt: now - daysToSeconds(9),
      },
    });

    expect(await source.read(WALLET, 90)).toBeNull();
  });

  it('falls back to the chain rather than failing when the index is unreachable', async () => {
    const swaps = { walletSwaps: async () => [] } as unknown as SwapRepository;
    const coverage = {
      get: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as WalletCoverageRepository;

    const source = new ClickHouseWalletSource({ swaps, coverage });
    expect(await source.read(WALLET, 90)).toBeNull();
  });

  it('reports no RPC spend, because none happened', async () => {
    const now = nowSeconds();
    const { source } = repositories({
      coverage: {
        wallet: WALLET,
        fromTs: now - daysToSeconds(365),
        toTs: now,
        swaps: 1,
        pricesReady: false,
        updatedAt: now,
      },
      swaps: [swap({ usdValue: null })],
    });

    const scan = await source.read(WALLET, 90);

    expect(scan?.cost).toEqual({ signaturesRead: 0, transactionsFetched: 0 });
    expect(scan?.unpricedSwaps).toBe(1);
    expect(scan?.stoppedOnTime).toBe(false);
    expect(scan?.transactionsUnread).toBe(0);
  });
});
