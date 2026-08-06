import { describe, expect, it } from 'vitest';
import { WSOL_MINT, type NormalisedSwap, type Side } from '@exitliquidity/core';
import type { TokenMetadataResolver } from './metadata.js';
import {
  censusOf,
  mergeIntervals,
  newPoolCrawlBudget,
  type ChainScanner,
  type PoolScan,
  type WalletScan,
} from './scan.js';
import type { IndexedWalletSource } from './index-source.js';
import { TraceService } from './trace.js';

const VICTIM = 'V1ct1mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT = 'M1ntAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL = 'Poo1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BASE_TS = 1_700_000_000;

let seq = 0;

interface SwapSpec {
  readonly wallet: string;
  readonly side: Side;
  /** Whole tokens at 6 decimals. */
  readonly base: number;
  readonly usd: number;
  /** Seconds after the base timestamp; slots run at 2.5 per second. */
  readonly offsetSec: number;
  readonly mint?: string;
  readonly poolId?: string;
}

function makeSwap(spec: SwapSpec): NormalisedSwap {
  seq += 1;
  return {
    signature: `sig${seq}`,
    slot: BigInt(100_000 + Math.round(spec.offsetSec * 2.5)),
    blockTime: BASE_TS + spec.offsetSec,
    venue: 'pumpswap',
    poolId: spec.poolId ?? POOL,
    mint: spec.mint ?? MINT,
    wallet: spec.wallet,
    side: spec.side,
    baseAmount: BigInt(Math.round(spec.base * 1e6)),
    baseDecimals: 6,
    quoteAmount: 1_000_000_000n,
    quoteFeeAmount: 0n,
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    usdValue: spec.usd,
    usdPriceSource: 'pyth_1m',
    ixIndex: 0,
    innerIxIndex: -1,
    ingestSource: 'backfill',
  };
}

const BUDGET = {
  lookbackDays: 90,
  maxSignatures: 1200,
  maxPoolSignaturePages: 20,
  maxPoolTransactions: 600,
  signaturePageSize: 1000,
};

/** Budgets handed to `scanPool`, in call order, so sharing can be asserted. */
const poolBudgets: { poolId: string; transactionsLeft: number }[] = [];

/** Deadlines the service handed each stage, so the split can be asserted. */
const deadlines: { stage: 'wallet' | 'pool'; at: number | undefined }[] = [];

interface ScanOverrides {
  readonly walletScan?: Partial<WalletScan>;
  readonly poolScan?: Partial<PoolScan>;
  /** Wall clock the wallet crawl burns, so a measured rate can be asserted. */
  readonly walletScanMs?: number;
}

function scannerFor(
  wallet: readonly NormalisedSwap[],
  pool: readonly NormalisedSwap[],
  overrides: ScanOverrides = {},
): ChainScanner {
  const stub = {
    budget: BUDGET,
    scanWallet: async (
      address: string,
      _signal?: AbortSignal,
      deadline?: number,
    ): Promise<WalletScan> => {
      deadlines.push({ stage: 'wallet', at: deadline });
      if (overrides.walletScanMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, overrides.walletScanMs));
      }
      return {
        wallet: address,
        swaps: wallet,
        census: censusOf(wallet),
        unpricedSwaps: 0,
        foreignSwaps: 0,
        parseSkips: {},
        // What the real scanner reports: the window it was budgeted for.
        windowDays: BUDGET.lookbackDays,
        oldestTs: BASE_TS,
        newestTs: BASE_TS + 3600,
        truncated: false,
        stoppedAt: 'end_of_history' as const,
        stoppedOnTime: false,
        transactionsUnread: 0,
        cost: { signaturesRead: wallet.length, transactionsFetched: wallet.length },
        ...overrides.walletScan,
      };
    },
    scanPool: async (
      poolId: string,
      _intervals: unknown,
      budget: { signaturePages: number; transactions: number },
      _signal?: AbortSignal,
      deadline?: number,
    ): Promise<PoolScan> => {
      poolBudgets.push({ poolId, transactionsLeft: budget.transactions });
      deadlines.push({ stage: 'pool', at: deadline });
      const swaps = pool.filter((swap) => swap.poolId === poolId);
      // Spend the allowance the way the real crawl does.
      budget.signaturePages -= 1;
      budget.transactions -= swaps.length;
      return {
        poolId,
        swaps,
        unpricedSwaps: 0,
        incomplete: false,
        cost: { signaturesRead: pool.length, transactionsFetched: swaps.length },
        ...overrides.poolScan,
      };
    },
  };
  return stub as unknown as ChainScanner;
}

const NO_METADATA = {
  supported: false,
  resolve: async () => new Map(),
} as unknown as TokenMetadataResolver;

function service(
  wallet: readonly NormalisedSwap[],
  pool: readonly NormalisedSwap[],
  overrides: ScanOverrides = {},
  priceSeries?: () => { fromTs: number; toTs: number; minutes: number } | null,
  index?: IndexedWalletSource,
): TraceService {
  return new TraceService({
    scanner: scannerFor(wallet, pool, overrides),
    metadata: NO_METADATA,
    limits: { lookbackDays: 90, maxPositions: 12, maxLegsPerPosition: 6 },
    ...(priceSeries === undefined ? {} : { priceSeries }),
    ...(index === undefined ? {} : { index }),
  });
}

/** An index that answers for one wallet and refuses for everything else. */
function indexWith(swaps: readonly NormalisedSwap[] | null): IndexedWalletSource {
  return {
    read: async (wallet) =>
      swaps === null
        ? null
        : {
            wallet,
            swaps,
            census: censusOf(swaps),
            unpricedSwaps: 0,
            foreignSwaps: 0,
            parseSkips: {},
            windowDays: 365,
            oldestTs: BASE_TS,
            newestTs: BASE_TS + 3600,
            truncated: false,
            stoppedAt: 'lookback_cutoff' as const,
            stoppedOnTime: false,
            transactionsUnread: 0,
            cost: { signaturesRead: 0, transactionsFetched: 0 },
          },
  };
}

describe('TraceService', () => {
  it('names the wallets that were selling into a losing buy', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 1000, usd: 1000, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 1000, usd: 250, offsetSec: 600 });

    // Two wallets reducing supply into the buy window, one twice the size.
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'big', side: 'sell', base: 600, usd: 600, offsetSec: 2 }),
      makeSwap({ wallet: 'small', side: 'sell', base: 300, usd: 300, offsetSec: 3 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);

    expect(report.status).toBe('ok');
    expect(report.totals.positionsClosed).toBe(1);
    expect(report.totals.realisedLossUsd).toBeCloseTo(750, 4);
    expect(report.counterparties.map((c) => c.wallet)).toEqual(['big', 'small']);

    // The whole loss is attributed, and split roughly by size.
    expect(report.totals.attributedUsd).toBeCloseTo(750, 4);
    expect(report.totals.unattributedUsd).toBeCloseTo(0, 6);
    expect(report.counterparties[0]!.attributedUsd).toBeGreaterThan(
      report.counterparties[1]!.attributedUsd,
    );
  });

  it('carries a checkable window on every counterparty', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    const window = report.counterparties[0]!.windows[0]!;

    expect(window.poolId).toBe(POOL);
    expect(window.mint).toBe(MINT);
    expect(window.venue).toBe('pumpswap');
    expect(window.ts).toBe(BASE_TS);
    expect(Number(window.startSlot)).toBeLessThanOrEqual(Number(window.endSlot));
    expect(window.buyLegSignature).toBe(buy.signature);
    expect(window.share).toBeGreaterThan(0);
  });

  it('reports no_swaps for a wallet with nothing on a parsed venue', async () => {
    const report = await service([], []).trace(VICTIM);
    expect(report.status).toBe('no_swaps');
    expect(report.counterparties).toHaveLength(0);
    // Null, not zero. Attribution never ran, so "$0 attributed" would be a
    // constant printed where a measurement belongs — the page renders "—".
    expect(report.totals.attributedUsd).toBeNull();
    expect(report.totals.realisedPnlUsd).toBeNull();
  });

  it('reports the PnL it measured on a wallet that simply did not lose', async () => {
    /*
     * The zero that was really a fabrication.
     *
     * `no_losses` runs after positions are accounted, so a realised figure
     * exists — and it was being overwritten with a hardcoded 0. A wallet that
     * closed a position at +$300 was shown a flat zero under a heading saying
     * nothing closed in the red, which is true, beside a number that was not.
     */
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 100, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 400, offsetSec: 60 });

    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);

    expect(report.status).toBe('no_losses');
    expect(report.totals.realisedPnlUsd).toBeCloseTo(300, 4);
    expect(report.totals.positionsClosed).toBe(1);
    expect(report.totals.positionsInTheRed).toBe(0);
    // Attribution still never ran, so these stay unknown.
    expect(report.totals.attributedUsd).toBeNull();
    expect(report.totals.counterparties).toBeNull();
  });

  it('reports no_losses when every closed position made money', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 100, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 400, offsetSec: 60 });

    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);
    expect(report.status).toBe('no_losses');
    expect(report.totals.positionsClosed).toBe(1);
  });

  it('reports the loss as unattributed when the window is empty', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });

    // Nobody else in the pool. Nothing may be attributed, and the $400 has to
    // still be visible rather than silently dropped.
    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);

    expect(report.status).toBe('no_attribution');
    expect(report.totals.attributedUsd).toBe(0);
    expect(report.totals.unattributedUsd).toBeCloseTo(400, 4);
    expect(report.notes.join(' ')).toContain('Nothing is attributed');
  });

  it('refuses to call sells-with-no-buys a result', async () => {
    // The live failure this exists to prevent. A real pump.fun trader came back
    // `no_losses` with twenty closed positions, every one `unknown_basis` and
    // not one still open — a shape only reachable if the read saw sells and no
    // buys. A wallet cannot sell what it never bought, so that is not a quiet
    // quarter, it is a read whose every figure is void. Reporting it as
    // "nothing closed in the red" states a finding the data cannot support.
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const report = await service([sell], [sell]).trace(VICTIM);

    expect(report.status).toBe('unreadable_history');
    expect(report.coverage.excluded['unknown_basis']).toBe(1);
    expect(report.coverage.swapCensus).toEqual({ 'pumpswap:sell': 1 });
    expect(report.notes.join(' ')).toContain('cannot sell what it never bought');
    expect(report.totals.realisedPnlUsd).toBe(0);
  });

  it('blames the lookback first when the crawl stopped at the lookback', async () => {
    /*
     * The live misdiagnosis. A wallet came back with 20 sells and 0 buys and
     * the note led with "placed by something the venue names as a different
     * trader (0 such swaps were seen)" — its own evidence against itself, in
     * the same sentence — while never mentioning that the crawl had stopped at
     * the 90-day cutoff with history still behind it. Buys older than the
     * window produce exactly this shape, and it is the cheapest thing to rule
     * out, so it goes first.
     */
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const report = await service([sell], [sell], {
      walletScan: { stoppedAt: 'lookback_cutoff', foreignSwaps: 0, oldestTs: BASE_TS },
    }).trace(VICTIM);

    expect(report.status).toBe('unreadable_history');
    expect(report.coverage.crawlStoppedAt).toBe('lookback_cutoff');
    expect(report.notes[1]).toContain('the buys are older than the window');
    expect(report.notes[1]).toContain('TRACE_LOOKBACK_DAYS');
    // The bot explanation is evidence-gated now, not printed regardless.
    expect(report.notes.join(' ')).not.toContain('Axiom');
  });

  it('will not recommend a window the clock cannot cover', async () => {
    /*
     * The signature ceiling on its own divides out to years on a quiet wallet
     * — one live trace suggested 2,887 days against a 6,000-signature budget,
     * which at any real RPC rate is a crawl of hours against a three-minute
     * timeout. Following it would return *less* history than the setting it
     * started from, cut short by the deadline. The reach has to be bounded by
     * the rate the scan actually achieved, not by the ceiling alone.
     */
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const slow = service([sell], [sell], {
      walletScan: {
        stoppedAt: 'lookback_cutoff',
        foreignSwaps: 0,
        // 900 transactions in 90 days, and the stub burns the whole clock.
        cost: { signaturesRead: 900, transactionsFetched: 900 },
      },
    });

    // A wallet crawl that has already spent its entire allowance cannot buy
    // another day of history, whatever the signature budget says.
    const report = await slow.trace(VICTIM, undefined, Date.now());

    expect(report.notes[1]).toContain('Widening the window is not free here');
    expect(report.notes[1]).toContain('SOLANA_RPC_MAX_RPS');
    expect(report.notes[1]).not.toContain('raise TRACE_LOOKBACK_DAYS to somewhere inside');
  });

  it('sizes the suggested window on the rate it measured, not the ceiling', async () => {
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const overrides = {
      walletScan: {
        stoppedAt: 'lookback_cutoff' as const,
        foreignSwaps: 0,
        // 90 transactions in 90 days: one a day, so days and transactions are
        // the same unit and the arithmetic is readable in the assertions.
        cost: { signaturesRead: 90, transactionsFetched: 90 },
      },
      walletScanMs: 100,
    };

    // The reach the note settled on, in days.
    const suggested = (note: string): number =>
      Number(/cover about ([\d,]+) days/.exec(note)?.[1]?.replace(/,/g, ''));

    // Unbounded clock: only the 1,200-signature ceiling applies.
    const unbounded = await service([sell], [sell], overrides).trace(VICTIM);
    expect(suggested(unbounded.notes[1] as string)).toBe(1200);

    // Half a second of trace, 60% of which is the wallet's: ~90 transactions
    // per 100ms over ~300ms is ~270, and a transaction is a day at this
    // density. Asserted as a band, because the stub's 100ms is a real timer.
    const bounded = await service([sell], [sell], overrides).trace(
      VICTIM,
      undefined,
      Date.now() + 500,
    );
    const days = suggested(bounded.notes[1] as string);
    expect(days).toBeGreaterThan(200);
    expect(days).toBeLessThan(320);
  });

  it('raises the bot explanation only when foreign swaps were actually seen', async () => {
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const report = await service([sell], [sell], {
      walletScan: { stoppedAt: 'end_of_history', foreignSwaps: 14 },
    }).trace(VICTIM);

    expect(report.notes.join(' ')).toContain('14 swaps in this wallet');
    expect(report.notes.join(' ')).toContain('Axiom');
    // Nothing was left unread, so the lookback is not a candidate at all.
    expect(report.notes.join(' ')).not.toContain('older than the window');
  });

  it('keeps the unparsed-venue explanation on every missing-buy path', async () => {
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });
    const report = await service([sell], [sell]).trace(VICTIM);
    expect(report.notes.join(' ')).toContain('venue with no parser here');
  });

  it('reports a crawl that read the address to its end as exactly that', async () => {
    const report = await service([], []).trace(VICTIM);
    expect(report.coverage.crawlStoppedAt).toBe('end_of_history');
    expect(report.coverage.historyTruncated).toBe(false);
  });

  it('still reports no_losses when buys were read and nothing lost', async () => {
    // The guard must not swallow the honest case: buys present, positions
    // closed, none of them in the red.
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 100, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 400, offsetSec: 60 });

    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);
    expect(report.status).toBe('no_losses');
  });

  it('leaves attribution-only figures null when attribution never ran', async () => {
    // A zero here is indistinguishable from a measurement. `legsWithUnknownFees:
    // 0` on a trace that examined no leg reads as "the fees were all known",
    // which sent a diagnosis down the wrong path for a whole pass.
    const report = await service([], []).trace(VICTIM);

    expect(report.status).toBe('no_swaps');
    expect(report.coverage.positionsAttributed).toBeNull();
    expect(report.coverage.legsSkipped).toBeNull();
    expect(report.coverage.legsWithUnknownFees).toBeNull();
    // Measured on every path, so these stay numbers.
    expect(report.coverage.losingPositions).toBe(0);
    expect(report.coverage.transactionsFetched).toBe(0);
  });

  it('measures those figures once attribution does run', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    expect(report.coverage.positionsAttributed).toBe(1);
    expect(report.coverage.legsSkipped).toBe(0);
    expect(report.coverage.legsWithUnknownFees).toBe(0);
  });

  it('always says that attribution measures overlap, not payment', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    expect(report.notes.join(' ')).toContain('overlap, not payment');
  });

  it('rolls losses up per token for the flow diagram', async () => {
    const other = 'M1ntBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const otherPool = 'Poo1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    const buyA = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 900, offsetSec: 0 });
    const sellA = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const buyB = makeSwap({
      wallet: VICTIM,
      side: 'buy',
      base: 100,
      usd: 300,
      offsetSec: 1000,
      mint: other,
      poolId: otherPool,
    });
    const sellB = makeSwap({
      wallet: VICTIM,
      side: 'sell',
      base: 100,
      usd: 100,
      offsetSec: 1300,
      mint: other,
      poolId: otherPool,
    });

    const pool = [
      buyA,
      sellA,
      buyB,
      sellB,
      makeSwap({ wallet: 'x', side: 'sell', base: 900, usd: 900, offsetSec: 1 }),
      makeSwap({
        wallet: 'x',
        side: 'sell',
        base: 300,
        usd: 300,
        offsetSec: 1001,
        mint: other,
        poolId: otherPool,
      }),
    ];

    const report = await service([buyA, sellA, buyB, sellB], pool).trace(VICTIM);

    expect(report.tokens.map((t) => t.mint)).toEqual([MINT, other]);
    expect(report.tokens[0]!.lossUsd).toBeCloseTo(800, 4);
    expect(report.tokens[1]!.lossUsd).toBeCloseTo(200, 4);
    expect(report.tokens[0]!.symbol).toBeNull();
  });

  it('draws every pool crawl from one shared budget', async () => {
    const other = 'M1ntCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const otherPool = 'Poo1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

    const buyA = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 900, offsetSec: 0 });
    const sellA = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const buyB = makeSwap({
      wallet: VICTIM,
      side: 'buy',
      base: 100,
      usd: 900,
      offsetSec: 1000,
      mint: other,
      poolId: otherPool,
    });
    const sellB = makeSwap({
      wallet: VICTIM,
      side: 'sell',
      base: 100,
      usd: 100,
      offsetSec: 1300,
      mint: other,
      poolId: otherPool,
    });

    const pool = [
      buyA,
      sellA,
      buyB,
      sellB,
      makeSwap({ wallet: 'x', side: 'sell', base: 900, usd: 900, offsetSec: 1 }),
      makeSwap({
        wallet: 'y',
        side: 'sell',
        base: 900,
        usd: 900,
        offsetSec: 1001,
        mint: other,
        poolId: otherPool,
      }),
    ];

    poolBudgets.length = 0;
    await service([buyA, sellA, buyB, sellB], pool).trace(VICTIM);

    expect(poolBudgets).toHaveLength(2);
    // The second pool must see less than the first left it. Granting each pool
    // the full ceiling is what turns a configured 600 into 600 × positions.
    expect(poolBudgets[1]!.transactionsLeft).toBeLessThan(poolBudgets[0]!.transactionsLeft);
    expect(poolBudgets[0]!.transactionsLeft).toBe(BUDGET.maxPoolTransactions);
  });

  it('discloses that a bonding-curve fee is missing from the basis', async () => {
    const buy = {
      ...makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 }),
      quoteFeeAmount: null,
    };
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool).trace(VICTIM);
    expect(report.coverage.legsWithUnknownFees).toBe(1);
    expect(report.notes.join(' ')).toContain('does not report its fee');
  });

  it('refuses to call a price outage "nothing closed in the red"', async () => {
    // The second shape of the same failure as sells-with-no-buys. With no
    // SOL/USD series every leg is unpriced, every position is dropped by
    // `isAttributable`, and the trace lands on `no_losses` — a claim about the
    // wallet manufactured by an outage at the oracle. §7.1 forbids that.
    const buy = { ...makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 0, offsetSec: 0 }) };
    const sell = {
      ...makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 0, offsetSec: 300 }),
    };
    const unpriced = [
      { ...buy, usdValue: null, usdPriceSource: 'none' as const },
      { ...sell, usdValue: null, usdPriceSource: 'none' as const },
    ];

    const report = await service(unpriced, unpriced, {
      walletScan: { unpricedSwaps: 2 },
    }).trace(VICTIM);

    expect(report.status).toBe('unpriced_history');
    expect(report.coverage.swapsUnpriced).toBe(2);
    expect(report.notes.join(' ')).toContain('failure at the SOL/USD feed');
    // The positions were still read; it is the valuation that is missing.
    expect(report.totals.positionsClosed).toBe(1);
    expect(report.totals.realisedPnlUsd).toBe(0);
  });

  it('discloses a partial price outage without refusing the trace', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool, {
      walletScan: { unpricedSwaps: 1 },
    }).trace(VICTIM);

    expect(report.status).toBe('ok');
    expect(report.coverage.swapsUnpriced).toBe(1);
    expect(report.notes.join(' ')).toContain('no SOL/USD price within the staleness bound');
  });

  it('reports the price series it actually holds', async () => {
    const report = await service([], [], {}, () => ({
      fromTs: 1_700_000_000,
      toTs: 1_700_003_600,
      minutes: 60,
    })).trace(VICTIM);

    expect(report.coverage.priceSeries).toEqual({
      fromTs: 1_700_000_000,
      toTs: 1_700_003_600,
      minutes: 60,
    });
  });

  it('says when the clock, not a ceiling, ended the crawl', async () => {
    // A call ceiling is a configured limit doing its job. A clock that ran out
    // means the endpoint is slower than the budget assumes, and the two want
    // opposite fixes — so they must not read the same on the page.
    const report = await service([], [], {
      walletScan: { stoppedOnTime: true, truncated: true, transactionsUnread: 340 },
    }).trace(VICTIM);

    expect(report.coverage.stoppedOnTimeBudget).toBe(true);
    expect(report.coverage.transactionsUnread).toBe(340);
    expect(report.notes.join(' ')).toContain('ran out of time before it ran out of budget');
    expect(report.notes.join(' ')).toContain('340 transactions unread');
  });

  it('leaves the wallet crawl time to spare for the pool crawls', async () => {
    // One deadline spent entirely on stage one reads a wallet perfectly and
    // attributes nothing, which is the less useful half to keep.
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    deadlines.length = 0;
    const at = Date.now() + 100_000;
    await service([buy, sell], pool).trace(VICTIM, undefined, at);

    const walletDeadline = deadlines.find((entry) => entry.stage === 'wallet')?.at;
    const poolDeadline = deadlines.find((entry) => entry.stage === 'pool')?.at;
    expect(walletDeadline).toBeDefined();
    expect(walletDeadline as number).toBeLessThan(at);
    expect(poolDeadline).toBe(at);
  });

  it('answers from the index without spending a single RPC call', async () => {
    /*
     * The whole reason the index exists. A live crawl is one `getTransaction`
     * per signature, and a wallet's year is thousands of them against a
     * per-second allowance — no arrangement of that fits in a web request. The
     * figures must come out identical; only what they cost changes.
     */
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    // The scanner is handed nothing, so anything found came from the index.
    const report = await service([], pool, {}, undefined, indexWith([buy, sell])).trace(VICTIM);

    expect(report.coverage.source).toBe('index');
    expect(report.status).toBe('ok');
    expect(report.totals.realisedLossUsd).toBeCloseTo(400, 4);
    expect(report.notes.join(' ')).toContain('Answered from the swap index');
  });

  it('falls back to the chain when the index cannot cover the wallet', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });

    // An index that refuses must be silent, not fatal: the chain is still there.
    const report = await service([buy, sell], [buy, sell], {}, undefined, indexWith(null)).trace(
      VICTIM,
    );

    expect(report.coverage.source).toBe('live');
    expect(report.totals.positionsClosed).toBe(1);
    expect(report.notes.join(' ')).not.toContain('Answered from the swap index');
  });

  it('reports a live source when no index is wired in at all', async () => {
    const report = await service([], []).trace(VICTIM);
    expect(report.coverage.source).toBe('live');
  });

  it('does not let a broken index take the trace down with it', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const exploding: IndexedWalletSource = {
      read: () => Promise.reject(new Error('clickhouse is down')),
    };

    const report = await service([buy, sell], [buy, sell], {}, undefined, exploding).trace(VICTIM);

    expect(report.coverage.source).toBe('live');
    expect(report.totals.positionsClosed).toBe(1);
  });

  it('counts unpriced pool swaps against the windows they weakened', async () => {
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 500, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 300 });
    const pool = [
      buy,
      sell,
      makeSwap({ wallet: 'x', side: 'sell', base: 500, usd: 500, offsetSec: 1 }),
    ];

    const report = await service([buy, sell], pool, { poolScan: { unpricedSwaps: 4 } }).trace(
      VICTIM,
    );

    expect(report.coverage.poolSwapsUnpriced).toBe(4);
    expect(report.notes.join(' ')).toContain('had no USD price');
  });
});

describe('newPoolCrawlBudget', () => {
  it('opens one allowance for the whole trace, not one per pool', () => {
    const budget = newPoolCrawlBudget({
      lookbackDays: 90,
      maxSignatures: 1200,
      maxPoolSignaturePages: 20,
      maxPoolTransactions: 600,
      signaturePageSize: 1000,
    });

    expect(budget).toEqual({ signaturePages: 20, transactions: 600 });

    // Spending it is what makes it shared: a second pool sees what the first
    // left behind. Granting each pool the full figure multiplies the configured
    // ceiling by the number of losing positions, which is how a three-minute
    // timeout meets a ten-minute crawl.
    budget.signaturePages -= 20;
    budget.transactions -= 600;
    expect(budget).toEqual({ signaturePages: 0, transactions: 0 });
  });
});

describe('mergeIntervals', () => {
  it('collapses overlapping ranges', () => {
    expect(
      mergeIntervals([
        { fromTs: 100, toTs: 200 },
        { fromTs: 150, toTs: 250 },
        { fromTs: 400, toTs: 500 },
      ]),
    ).toEqual([
      { fromTs: 100, toTs: 250 },
      { fromTs: 400, toTs: 500 },
    ]);
  });

  it('keeps a range fully inside another from shrinking it', () => {
    expect(
      mergeIntervals([
        { fromTs: 100, toTs: 900 },
        { fromTs: 200, toTs: 300 },
      ]),
    ).toEqual([{ fromTs: 100, toTs: 900 }]);
  });

  it('handles an empty list', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('TraceService partial basis loss', () => {
  /*
   * The hole in the sells-with-no-buys guard.
   *
   * That guard sums the census across the whole wallet, so a single buy
   * anywhere switches it off. A read that lost the entry legs for many mints
   * and kept one on another therefore walked straight past it — every unbacked
   * position was dropped by `isAttributable`, and the trace answered "nothing
   * closed in the red" over a read that was just as broken as the one the guard
   * exists to refuse.
   */
  it('refuses to say nothing was lost when most entry legs were never read', async () => {
    const swaps: NormalisedSwap[] = [];

    // One mint read properly, and closed flat so it contributes no loss.
    swaps.push(
      makeSwap({
        wallet: VICTIM,
        side: 'buy',
        base: 100,
        usd: 100,
        offsetSec: 0,
        mint: 'GOOD',
        poolId: 'poolGOOD',
      }),
    );
    swaps.push(
      makeSwap({
        wallet: VICTIM,
        side: 'sell',
        base: 100,
        usd: 100,
        offsetSec: 60,
        mint: 'GOOD',
        poolId: 'poolGOOD',
      }),
    );

    // Five more whose buys sat outside the window: exits with no entry.
    for (let i = 0; i < 5; i += 1) {
      swaps.push(
        makeSwap({
          wallet: VICTIM,
          side: 'sell',
          base: 100,
          usd: 40,
          offsetSec: 120 + i,
          mint: `LOST${i}`,
          poolId: `poolLOST${i}`,
        }),
      );
    }

    const report = await service(swaps, swaps).trace(VICTIM);

    // The old behaviour was 'no_losses' — "Nothing closed in the red."
    expect(report.status).toBe('unreadable_history');
    expect(report.coverage.excluded.unknown_basis).toBe(5);
    expect(report.notes.join(' ')).toContain('found no matching entry for');
  });

  it('still says nothing was lost when every basis really was read', async () => {
    // The honest case has to keep working, or the guard just moved the lie.
    const buy = makeSwap({ wallet: VICTIM, side: 'buy', base: 100, usd: 100, offsetSec: 0 });
    const sell = makeSwap({ wallet: VICTIM, side: 'sell', base: 100, usd: 100, offsetSec: 60 });

    const report = await service([buy, sell], [buy, sell]).trace(VICTIM);

    expect(report.status).toBe('no_losses');
  });

  it('says which part of the wallet it stands behind when it does find a loss', async () => {
    const swaps: NormalisedSwap[] = [
      makeSwap({ wallet: VICTIM, side: 'buy', base: 1000, usd: 1000, offsetSec: 0 }),
      makeSwap({ wallet: VICTIM, side: 'sell', base: 1000, usd: 250, offsetSec: 600 }),
      // An exit with no entry, on another mint.
      makeSwap({
        wallet: VICTIM,
        side: 'sell',
        base: 50,
        usd: 20,
        offsetSec: 700,
        mint: 'LOST',
        poolId: 'poolLOST',
      }),
    ];

    const report = await service(swaps, swaps).trace(VICTIM);

    expect(report.coverage.excluded.unknown_basis).toBe(1);
    expect(report.notes.join(' ')).toContain('excluded from every figure below');
  });
});
