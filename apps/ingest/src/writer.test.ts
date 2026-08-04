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

function skipRow(signature: string): SkipRow {
  return {
    slot: '1',
    signature,
    venue: 'pumpfun',
    reason: 'event_missing',
    ix_index: 0,
    inner_ix_index: -1,
    detail: 'node had no children',
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

  it('flushes a batch that is nothing but parse skips', async () => {
    // The defect this pins: every flush-arming path measured #swaps only, so a
    // batch of pure skips armed no timer and hit no ceiling. On a run where
    // every instruction failed to parse, `swaps` was empty because nothing
    // parsed and `ingest_skips` was empty because nothing flushed — the table
    // that exists to explain the shortfall explained nothing.
    vi.useFakeTimers();
    try {
      const repository = fakeRepository();
      const writer = new SwapWriter({
        repository,
        metrics: createIngestMetrics(),
        maxRows: 5000,
        maxDelayMs: 100,
      });

      await writer.add([], [skipRow('sig-a')]);
      expect(writer.pending).toBe(1);

      await vi.advanceTimersByTimeAsync(150);

      expect(repository.skipBatches).toEqual([[skipRow('sig-a')]]);
      expect(writer.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaches the batch ceiling on skips alone', async () => {
    const repository = fakeRepository();
    const writer = new SwapWriter({
      repository,
      metrics: createIngestMetrics(),
      maxRows: 3,
      maxPendingRows: 3,
    });

    await writer.add([], [skipRow('a'), skipRow('b'), skipRow('c')]);

    expect(repository.skipBatches.flat()).toHaveLength(3);
  });

  it('still writes buffered rows when an earlier batch failed', async () => {
    // close() awaited #inFlight, which was already rejected, so it threw before
    // the buffer swap — abandoning rows added since the failing batch started,
    // rows that were perfectly writable.
    const repository = fakeRepository({ failTimes: 1 });
    const writer = new SwapWriter({
      repository,
      metrics: createIngestMetrics(),
      maxRows: 2,
      maxAttempts: 1,
    });

    await writer.add([swap('a'), swap('b')]); // starts a background flush that fails
    await writer.add([swap('c')]);
    await writer.close().catch(() => undefined);

    expect(repository.batches).toEqual([[swap('c')]]);
    expect(writer.pending).toBe(0);
  });

  it('reports a failed write so the checkpoint can be held back', async () => {
    const repository = fakeRepository({ failTimes: 1 });
    const writer = new SwapWriter({
      repository,
      metrics: createIngestMetrics(),
      maxAttempts: 1,
    });

    await writer.add([swap('a')]);
    await writer.flush().catch(() => undefined);
    expect(writer.lastWriteFailed).toBe(true);

    await writer.add([swap('b')]);
    await writer.flush();
    expect(writer.lastWriteFailed).toBe(false);
  });
});
