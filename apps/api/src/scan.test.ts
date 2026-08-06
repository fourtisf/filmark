import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { PUMP_FUN_PROGRAM_ID, silentLogger } from '@exitliquidity/core';
import { IX_BUY } from '@exitliquidity/parsers';
import {
  TRADE_EVENT_DISCRIMINATOR,
  TransactionBuilder,
  anchorEventData,
  encodeTradeEvent,
  fakePubkey,
} from '@exitliquidity/parsers/testing';
import type { QuoteOracle } from '@exitliquidity/pricing';
import type { RawInstruction, RawTransaction } from '@exitliquidity/solana';
import type { SignatureInfo, SolanaRpcClient } from '@exitliquidity/solana';
import { ChainScanner, type ScanBudget } from './scan.js';

const WALLET = 'V1ct1mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DAY = 86_400;

const BUDGET: ScanBudget = {
  lookbackDays: 365,
  maxSignatures: 6000,
  maxPoolSignaturePages: 20,
  maxPoolTransactions: 600,
  signaturePageSize: 1000,
};

/**
 * Signatures newest first, one a day back from now, as the RPC returns them.
 *
 * `shiftSec` moves the whole series off the day boundary, so a cutoff computed
 * from the scanner's own clock cannot land exactly on an entry and make the
 * count depend on which side of a second the test ran.
 */
function history(count: number, now: number, shiftSec = 0): SignatureInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `sig${i}`,
    slot: 1_000_000 - i,
    blockTime: now - i * DAY - shiftSec,
    err: null,
  }));
}

interface RpcStub {
  readonly rpc: SolanaRpcClient;
  readonly fetched: () => string[];
  /** Signatures per `getTransactions` call, which is what carries the overlap. */
  readonly windows: () => number[];
}

function rpcWith(signatures: SignatureInfo[], perCallMs = 0): RpcStub {
  const fetched: string[] = [];
  const windows: number[] = [];
  const stub = {
    transactionBatchSize: 10,
    transactionWindowSize: 30,
    getSignaturesForAddress: async (
      _address: string,
      options: { limit?: number; before?: string },
    ): Promise<SignatureInfo[]> => {
      const start =
        options.before === undefined
          ? 0
          : signatures.findIndex((entry) => entry.signature === options.before) + 1;
      return signatures.slice(start, start + (options.limit ?? 1000));
    },
    getTransactions: async (batch: readonly string[]): Promise<null[]> => {
      windows.push(batch.length);
      if (perCallMs > 0) await new Promise((resolve) => setTimeout(resolve, perCallMs));
      fetched.push(...batch);
      // Null is "pruned or unavailable", which every parser path skips. The
      // crawl's accounting is what is under test, not the decoding.
      return batch.map(() => null);
    },
    getMintDecimals: async (): Promise<null[]> => [],
  };
  return {
    rpc: stub as unknown as SolanaRpcClient,
    fetched: () => fetched,
    windows: () => windows,
  };
}

const NO_PRICES: QuoteOracle = { price: () => ({ price: null, reason: 'no_price_in_range' }) };

function scannerFor(rpc: SolanaRpcClient, budget: ScanBudget = BUDGET): ChainScanner {
  return new ChainScanner({ rpc, oracle: () => NO_PRICES, budget, logger: silentLogger });
}

/**
 * One pump.fun buy, encoded the way the program emits it.
 *
 * The stub above answers every `getTransaction` with null, which is enough for
 * the crawl's own accounting and reaches no further: nothing parses, so nothing
 * is normalised and the price warm-up is never called. Anything about pricing
 * needs a transaction that actually decodes, so this builds one rather than
 * reaching past the parser with a mock.
 */
function pumpFunBuy(blockTime: number, trader: string): RawTransaction {
  const mint = fakePubkey(8);
  const builder = new TransactionBuilder().blockTime(blockTime);
  const accounts = [fakePubkey(2), fakePubkey(3), mint, fakePubkey(4), trader];

  const ix = builder.topLevel({
    programId: PUMP_FUN_PROGRAM_ID,
    accounts,
    data: IX_BUY.bytes,
  });
  builder.inner(ix, {
    programId: PUMP_FUN_PROGRAM_ID,
    accounts: [],
    data: anchorEventData(
      TRADE_EVENT_DISCRIMINATOR,
      encodeTradeEvent({
        mint,
        solAmount: 1_000_000_000n,
        tokenAmount: 1_000_000n,
        isBuy: true,
        user: trader,
        timestamp: BigInt(blockTime),
      }),
    ),
  });

  return builder.build();
}

/** Re-encodes a fixture into the `getTransaction` JSON the scanner reads. */
function asRpcResponse(raw: RawTransaction): unknown {
  const encode = (ix: RawInstruction): unknown => ({
    programIdIndex: ix.programIdIndex,
    accounts: [...ix.accountIndexes],
    data: bs58.encode(ix.data),
    stackHeight: ix.stackHeight ?? null,
  });

  return {
    slot: Number(raw.slot),
    blockTime: raw.blockTime,
    transaction: {
      signatures: [raw.signature],
      message: { accountKeys: [...raw.accountKeys], instructions: raw.instructions.map(encode) },
    },
    meta: {
      err: null,
      innerInstructions: raw.innerInstructions.map((group) => ({
        index: group.index,
        instructions: group.instructions.map(encode),
      })),
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
}

describe('ChainScanner.scanWallet', () => {
  it('reports the window it read, not the window it was asked for', async () => {
    /*
     * The fault this exists for. Signatures are cheap and transactions are not,
     * so a crawl routinely reaches the cutoff and then runs out of clock part
     * way through fetching them. Taking the span from every signature seen
     * reported a year of coverage over a read that stopped weeks in — a
     * configured intention presented as a measurement, in the block whose whole
     * job is to say what the trace did not cover.
     */
    const now = Math.floor(Date.now() / 1000);
    const { rpc } = rpcWith(history(300, now), 6);

    // A deadline that expires after a few batches of ten.
    const scan = await scannerFor(rpc).scanWallet(WALLET, undefined, Date.now() + 40);

    expect(scan.stoppedOnTime).toBe(true);
    expect(scan.transactionsUnread).toBeGreaterThan(0);
    expect(scan.stoppedAt).toBe('time_budget');

    // One signature a day, so days read and transactions read are the same
    // number. The window must match what was fetched, not the 300 crawled.
    const daysRead = Math.round(((scan.newestTs as number) - (scan.oldestTs as number)) / DAY) + 1;
    expect(daysRead).toBe(scan.cost.transactionsFetched);
    expect(daysRead).toBeLessThan(300);
  });

  it('spans everything when nothing was left unread', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { rpc } = rpcWith(history(40, now));

    const scan = await scannerFor(rpc).scanWallet(WALLET);

    expect(scan.stoppedOnTime).toBe(false);
    expect(scan.transactionsUnread).toBe(0);
    expect(scan.cost.transactionsFetched).toBe(40);
    expect(scan.newestTs).toBe(now);
    expect(scan.oldestTs).toBe(now - 39 * DAY);
  });

  it('names the lookback cutoff as the reason it stopped', async () => {
    // History older than the window, so the crawl stops on the date rather than
    // on a budget — the one stop that means older history exists by design.
    const now = Math.floor(Date.now() / 1000);
    const { rpc } = rpcWith(history(500, now, DAY / 2));

    const scan = await scannerFor(rpc, { ...BUDGET, lookbackDays: 30 }).scanWallet(WALLET);

    expect(scan.stoppedAt).toBe('lookback_cutoff');
    expect(scan.truncated).toBe(false);
    expect(scan.cost.transactionsFetched).toBe(30);
  });

  it('names the signature ceiling when that is what ran out', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { rpc } = rpcWith(history(500, now));

    const scan = await scannerFor(rpc, {
      ...BUDGET,
      maxSignatures: 20,
      signaturePageSize: 10,
    }).scanWallet(WALLET);

    expect(scan.stoppedAt).toBe('signature_budget');
    expect(scan.truncated).toBe(true);
  });

  it('reads the address to its end when it is shorter than every budget', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { rpc } = rpcWith(history(5, now));

    const scan = await scannerFor(rpc, { ...BUDGET, signaturePageSize: 5 }).scanWallet(WALLET);

    expect(scan.stoppedAt).toBe('end_of_history');
    expect(scan.truncated).toBe(false);
  });

  it('hands the client a window wide enough for it to overlap inside', async () => {
    /*
     * The regression this exists for. `getTransactions` runs three JSON-RPC
     * batches at a time, but this caller chunked to the *batch* width — so
     * every call contained exactly one batch, the overlap had nothing to
     * overlap with, and the crawl waited out every round trip. Throughput sat
     * at a third of the configured rate with no counter saying why.
     */
    const now = Math.floor(Date.now() / 1000);
    const { rpc, windows } = rpcWith(history(75, now));

    await scannerFor(rpc).scanWallet(WALLET);

    // 75 signatures at a window of 30: 30, 30, 15 — not eight calls of ten.
    expect(windows()).toEqual([30, 30, 15]);
  });

  it('fetches the newest transactions first, so a cut-short read is recent', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { rpc, fetched } = rpcWith(history(100, now), 6);

    await scannerFor(rpc).scanWallet(WALLET, undefined, Date.now() + 30);

    // Newest first is what makes dropping the tail equivalent to a shorter
    // lookback rather than to a hole in the middle of the history.
    expect(fetched()[0]).toBe('sig0');
  });
});

describe('ChainScanner price warm-up', () => {
  /* The venue event names the trader, and the scan keeps only that wallet's own
     swaps — so the address traced here has to be the one inside the fixture. */
  const TRADER = fakePubkey(7);

  /**
   * A crawl whose transactions decode, so pricing is actually reached.
   *
   * `perCallMs` is deliberately zero here: the wait under test is the one after
   * the chain has answered, and mixing the two would leave a failure ambiguous
   * about which budget it proved.
   */
  function priceableCrawl(
    now: number,
    warm: (fromTs: number, toTs: number, signal?: AbortSignal) => Promise<void>,
  ): ChainScanner {
    const signatures = history(1, now);
    const stub = {
      transactionBatchSize: 10,
      transactionWindowSize: 30,
      getSignaturesForAddress: async (
        _address: string,
        options: { before?: string },
      ): Promise<SignatureInfo[]> => (options.before === undefined ? signatures : []),
      getTransactions: async (batch: readonly string[]): Promise<unknown[]> =>
        batch.map(() => asRpcResponse(pumpFunBuy(now, TRADER))),
      getMintDecimals: async (mints: readonly string[]): Promise<(number | null)[]> =>
        mints.map(() => 6),
    };

    return new ChainScanner({
      rpc: stub as unknown as SolanaRpcClient,
      oracle: () => NO_PRICES,
      budget: BUDGET,
      warm,
      logger: silentLogger,
    });
  }

  it('stops waiting on the price feed when the crawl’s clock runs out', async () => {
    /*
     * The one wait in a trace that had no budget behind it.
     *
     * Every RPC ceiling here has a field on the report saying what it cost, and
     * this fetch had neither — it runs *after* the chain has answered, against
     * a shared public service that meters over a window and replies
     * `Retry-After: 58`. A trace could read its wallet in seconds and then sit
     * in Benchmarks' backoff until the request timed out, and the only thing
     * the coverage block had to offer was a slow-looking RPC endpoint.
     */
    const now = Math.floor(Date.now() / 1000);
    let released: (() => void) | undefined;
    const stuck = new Promise<void>((resolve) => {
      released = resolve;
    });

    const scanner = priceableCrawl(now, () => stuck);
    const started = Date.now();
    const scan = await scanner.scanWallet(TRADER, undefined, Date.now() + 60);

    expect(scan.pricesCutShort).toBe(true);
    // Answered on the deadline rather than on the feed, and the swap is still
    // there — unpriced, which the report already knows how to explain.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(scan.swaps).toHaveLength(1);
    expect(scan.unpricedSwaps).toBe(1);

    released?.();
  });

  it('waits for a feed that answers, and says so', async () => {
    const now = Math.floor(Date.now() / 1000);
    const seen: { fromTs: number; toTs: number }[] = [];

    const scan = await priceableCrawl(now, async (fromTs, toTs) => {
      seen.push({ fromTs, toTs });
    }).scanWallet(TRADER, undefined, Date.now() + 10_000);

    expect(scan.pricesCutShort).toBe(false);
    expect(seen).toEqual([{ fromTs: now, toTs: now }]);
  });

  it('lets a failed warm-up travel rather than reading it as a slow feed', async () => {
    const now = Math.floor(Date.now() / 1000);
    const scanner = priceableCrawl(now, () => Promise.reject(new Error('benchmarks refused')));

    await expect(scanner.scanWallet(TRADER, undefined, Date.now() + 10_000)).rejects.toThrow(
      'benchmarks refused',
    );
  });
});
