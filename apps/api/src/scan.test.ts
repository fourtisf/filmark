import { describe, expect, it } from 'vitest';
import { silentLogger } from '@exitliquidity/core';
import type { QuoteOracle } from '@exitliquidity/pricing';
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
