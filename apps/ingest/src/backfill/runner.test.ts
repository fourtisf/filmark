import { AbortedError, createIngestMetrics, MetricsRegistry } from '@exitliquidity/core';
import type { SignatureInfo, SolanaRpcClient } from '@exitliquidity/solana';
import { describe, expect, it } from 'vitest';
import type { SwapPipeline } from '../pipeline.js';
import type { SwapWriter } from '../writer.js';
import { BackfillRunner } from './runner.js';

/**
 * The runner had no tests, which is how `--max` came to cap nothing and a single
 * Ctrl+C came to be reported as hundreds of failed fetches. Both are pinned here
 * against a stub RPC, so neither can come back without a red suite.
 */

const NOW = Math.floor(Date.now() / 1000);

function signatures(count: number, ageStepSec = 1): SignatureInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `sig${String(i).padStart(4, '0')}`,
    slot: 1000 + i,
    blockTime: NOW - i * ageStepSec,
    err: null,
  }));
}

interface Harness {
  runner: BackfillRunner;
  fetched: () => string[];
}

function harness(
  pages: SignatureInfo[][],
  onFetch?: (signature: string, index: number) => void,
): Harness {
  const fetched: string[] = [];
  let page = 0;

  const rpc = {
    getSignaturesForAddress: async (): Promise<SignatureInfo[]> => pages[page++] ?? [],
    getTransaction: async (signature: string): Promise<unknown> => {
      onFetch?.(signature, fetched.length);
      fetched.push(signature);
      // The minimum `fromRpcTransaction` accepts — the runner adapts every
      // response before handing it to the pipeline, so an empty object is not
      // enough and would fail for reasons unrelated to what is under test.
      return {
        slot: 1,
        blockTime: NOW,
        transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } },
        meta: { err: null },
      };
    },
  } as unknown as SolanaRpcClient;

  const pipeline = {
    process: async () => ({ swaps: [], skips: [] }),
  } as unknown as SwapPipeline;

  const writer = {
    add: async () => undefined,
    flush: async () => undefined,
  } as unknown as SwapWriter;

  const runner = new BackfillRunner({
    rpc,
    pipeline,
    writer,
    metrics: createIngestMetrics(new MetricsRegistry()),
    pageSize: 1000,
    transactionBatch: 20,
  });

  return { runner, fetched: () => fetched };
}

describe('BackfillRunner --max', () => {
  it('fetches exactly the cap, not a whole page', async () => {
    // The regression: maxTransactions was consulted only at the bottom of the
    // page loop, after every signature on the page had already been fetched.
    // `--max 5` against a 600-signature page issued 600 getTransaction calls.
    const { runner, fetched } = harness([signatures(600)]);

    const result = await runner.run({ address: 'mint', fromSec: NOW - 86_400, maxTransactions: 5 });

    expect(fetched()).toHaveLength(5);
    expect(result.transactionsFetched).toBe(5);
  });

  it('applies the cap on the cutoff path too', async () => {
    // Signatures one hour apart, so the cutoff lands mid-page and the crawl
    // exits through the `break pages` branch rather than the loop bottom.
    const { runner, fetched } = harness([signatures(50, 3600)]);

    await runner.run({ address: 'mint', fromSec: NOW - 10 * 3600, maxTransactions: 3 });

    expect(fetched()).toHaveLength(3);
  });

  it('is unbounded when no cap is given', async () => {
    const { runner, fetched } = harness([signatures(40)]);

    await runner.run({ address: 'mint', fromSec: NOW - 86_400 });

    expect(fetched()).toHaveLength(40);
  });
});

describe('BackfillRunner shutdown', () => {
  it('raises one abort rather than one failure per remaining signature', async () => {
    // Before: the worker caught AbortedError, counted it as an unfetchable
    // transaction, logged a warning and returned null — so the map drained the
    // rest of the page instantly, one bogus line each.
    const controller = new AbortController();
    const { runner, fetched } = harness([signatures(400)], (_sig, index) => {
      if (index === 10) controller.abort();
    });

    const error = await runner
      .run({ address: 'mint', fromSec: NOW - 86_400 }, controller.signal)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AbortedError);
    // Whatever was already in flight may finish; the rest must never start.
    expect(fetched().length).toBeLessThan(100);
  });

  it('does not report an interrupted run as a successful one', async () => {
    const controller = new AbortController();
    const { runner } = harness([signatures(200)], (_sig, index) => {
      if (index === 5) controller.abort();
    });

    await expect(
      runner.run({ address: 'mint', fromSec: NOW - 86_400 }, controller.signal),
    ).rejects.toBeInstanceOf(AbortedError);
  });
});
