import { StorageError, createIngestMetrics, type NormalisedSwap } from '@exitliquidity/core';
import type { SkipRow, SwapRepository } from '@exitliquidity/clickhouse';
import { describe, expect, it, vi } from 'vitest';
import { SwapWriter } from './writer.js';

function swap(signature: string): NormalisedSwap {
  return {
    signature,
    slot: 1n,
    blockTime: 1_735_689_600,
    venue: 'pumpfun',
    poolId: 'curve',
    mint: 'mint',
    wallet: 'wallet',
    side: 'buy',
    baseAmount: 1n,
    baseDecimals: 6,
    quoteAmount: 2n,
    quoteFeeAmount: null,
    quoteMint: 'wsol',
    quoteDecimals: 9,
    usdValue: 1,
    usdPriceSource: 'pyth_1m',
    ixIndex: 0,
    innerIxIndex: -1,
    ingestSource: 'stream',
  };
}

interface FakeRepository extends SwapRepository {
  readonly batches: NormalisedSwap[][];
  readonly skipBatches: SkipRow[][];
}

function fakeRepository(
  behaviour: { failTimes?: number; failSkips?: boolean } = {},
): FakeRepository {
  const batches: NormalisedSwap[][] = [];
  const skipBatches: SkipRow[][] = [];
  let failures = behaviour.failTimes ?? 0;

  return {
    batches,
    skipBatches,
    async insert(swaps) {
      if (failures > 0) {
        failures -= 1;
        throw new StorageError('clickhouse unavailable');
      }
      batches.push([...swaps]);
    },
    async insertSkips(skips) {
      if (behaviour.failSkips === true) throw new StorageError('skip table unavailable');
      skipBatches.push([...skips]);
    },
  } as FakeRepository;
}

describe('SwapWriter', () => {
  it('holds rows until the batch is full', async () => {
    const repository = fakeRepository();
    const writer = new SwapWriter({
      repository,
      metrics: createIngestMetrics(),
      maxRows: 3,
      maxDelayMs: 60_000,
    });

    await writer.add([swap('a'), swap('b')]);
    expect(repository.batches).toHaveLength(0);
    expect(writer.pending).toBe(2);

    await writer.add([swap('c')]);
    await writer.flush();
    expect(repository.batches).toEqual([[swap('a'), swap('b'), swap('c')]]);
  });

  it('flushes on a timer when the batch never fills', async () => {
    vi.useFakeTimers();
    try {
      const repository = fakeRepository();
      const writer = new SwapWriter({
        repository,
        metrics: createIngestMetrics(),
        maxRows: 100,
        maxDelayMs: 500,
      });

      await writer.add([swap('a')]);
      expect(repository.batches).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(500);
      expect(repository.batches).toEqual([[swap('a')]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks the caller once the buffer hits its ceiling', async () => {
    // Backpressure, not unbounded memory: a stalled ClickHouse has to slow the
    // stream down rather than be absorbed by it.
    const repository = fakeRepository();
    const writer = new SwapWriter({
      repository,
      metrics: createIngestMetrics(),
      maxRows: 100,
      maxDelayMs: 60_000,
      maxPendingRows: 2,
    });

    await writer.add([swap('a'), swap('b')]);
    expect(repository.batches).toHaveLength(1);
    expect(writer.pending).toBe(0);
  });

  it('retries a failing insert and reports the rows written', async () => {
    const metrics = createIngestMetrics();
    const repository = fakeRepository({ failTimes: 2 });
    const writer = new SwapWriter({ repository, metrics, maxAttempts: 5 });

    await writer.add([swap('a')]);
    await writer.flush();

    expect(repository.batches).toEqual([[swap('a')]]);
    expect(metrics.rowsWritten.get()).toBe(1);
    expect(metrics.errors.get({ stage: 'write' })).toBe(2);
  });

  it('surfaces a failure once retries are exhausted', async () => {
    const metrics = createIngestMetrics();
    const writer = new SwapWriter({
      repository: fakeRepository({ failTimes: 99 }),
      metrics,
      maxAttempts: 2,
    });

    await writer.add([swap('a')]);
    await expect(writer.flush()).rejects.toThrow(StorageError);
    expect(metrics.errors.get({ stage: 'write_failed' })).toBe(1);
  });

  it('does not let a failed skip insert take down the swap insert', async () => {
    // Diagnostics are best-effort; losing them must never cost a real row.
    const repository = fakeRepository({ failSkips: true });
    const writer = new SwapWriter({ repository, metrics: createIngestMetrics() });

    const skip: SkipRow = {
      slot: '1',
      signature: 'sig',
      venue: 'pumpfun',
      reason: 'event_missing',
      ix_index: 0,
      inner_ix_index: -1,
      detail: '',
    };

    await writer.add([swap('a')], [skip]);
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(repository.batches).toEqual([[swap('a')]]);
  });

  it('flushes everything buffered on close and then refuses writes', async () => {
    const repository = fakeRepository();
    const writer = new SwapWriter({
      repository,
      metrics: createIngestMetrics(),
      maxRows: 100,
      maxDelayMs: 60_000,
    });

    await writer.add([swap('a')]);
    await writer.close();

    expect(repository.batches).toEqual([[swap('a')]]);
    await expect(writer.add([swap('b')])).rejects.toThrow(/closed/);
  });

  it('does not interleave batches when two flushes race', async () => {
    const repository = fakeRepository();
    const writer = new SwapWriter({ repository, metrics: createIngestMetrics(), maxRows: 100 });

    await writer.add([swap('a')]);
    await Promise.all([writer.flush(), writer.flush(), writer.flush()]);

    expect(repository.batches).toEqual([[swap('a')]]);
  });

  it('is a no-op when there is nothing buffered', async () => {
    const repository = fakeRepository();
    const writer = new SwapWriter({ repository, metrics: createIngestMetrics() });

    await writer.flush();
    expect(repository.batches).toEqual([]);
  });
});
