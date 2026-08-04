import { randomUUID } from 'node:crypto';
import type { NormalisedSwap } from '@exitliquidity/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createClickHouseClient,
  ensureDatabase,
  quoteIdentifier,
  type ClickHouseClient,
} from './client.js';
import { runMigrations } from './migrations.js';
import { CheckpointRepository, MintRepository, SolUsdRepository } from './support-repositories.js';
import { SwapRepository } from './swap-repository.js';

/**
 * Exercises the schema against a real server.
 *
 * Skipped unless `CLICKHOUSE_TEST_URL` is set, because the unit suite has to
 * run without infrastructure. The DDL, the row encoding and the counting query
 * are only meaningfully checked here — a `UInt64` sent as a JSON number, or a
 * sort key that does not identify a row, both pass every mock.
 *
 *   docker compose up -d clickhouse
 *   CLICKHOUSE_TEST_URL=http://localhost:8123 pnpm test
 */
const url = process.env['CLICKHOUSE_TEST_URL'];
const describeIfClickHouse = url === undefined ? describe.skip : describe;

const MINT = 'IntegrationMint1111111111111111111111111111';
const BLOCK_TIME = 1_735_689_600;

function swap(overrides: Partial<NormalisedSwap> = {}): NormalisedSwap {
  return {
    signature: `sig-${randomUUID()}`,
    slot: 250_000_000n,
    blockTime: BLOCK_TIME,
    venue: 'pumpfun',
    poolId: 'curve',
    mint: MINT,
    wallet: 'wallet',
    side: 'buy',
    // Past 2^53: the reason amounts are sent as strings rather than numbers.
    baseAmount: 18_446_744_073_709_551_000n,
    baseDecimals: 6,
    quoteAmount: 9_007_199_254_740_993n,
    quoteFeeAmount: 1_234n,
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteDecimals: 9,
    usdValue: 123.45,
    usdPriceSource: 'pyth_1m',
    ixIndex: 0,
    innerIxIndex: -1,
    ingestSource: 'stream',
    ...overrides,
  };
}

describeIfClickHouse('ClickHouse schema', () => {
  const database = `exitliquidity_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let client: ClickHouseClient;
  let swaps: SwapRepository;

  beforeAll(async () => {
    const options = {
      url: url as string,
      database,
      username: process.env['CLICKHOUSE_TEST_USER'] ?? 'default',
      password: process.env['CLICKHOUSE_TEST_PASSWORD'] ?? '',
    };
    await ensureDatabase(options);
    client = createClickHouseClient(options);
    await runMigrations(client);
    swaps = new SwapRepository(client);
  }, 60_000);

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${quoteIdentifier(database)}` });
    await client.close();
  });

  it('is idempotent: re-running the migrations changes nothing', async () => {
    const second = await runMigrations(client);
    expect(second.every((m) => m.status === 'already-applied')).toBe(true);
  });

  it('round-trips a swap without losing precision on a large amount', async () => {
    const row = swap();
    await swaps.insert([row]);

    const result = await client.query({
      query: `
        SELECT base_amount, quote_amount, quote_fee_amount, usd_value, side
        FROM swaps WHERE signature = {signature:String}
      `,
      query_params: { signature: row.signature },
      format: 'JSONEachRow',
    });
    const [stored] = await result.json<{
      base_amount: string;
      quote_amount: string;
      quote_fee_amount: string | null;
      usd_value: number | null;
      side: string;
    }>();

    expect(stored?.base_amount).toBe(row.baseAmount.toString());
    expect(stored?.quote_amount).toBe(row.quoteAmount.toString());
    expect(stored?.quote_fee_amount).toBe('1234');
    expect(stored?.usd_value).toBeCloseTo(123.45);
    expect(stored?.side).toBe('buy');
  });

  it('stores a null fee and a null price as null, not zero', async () => {
    const row = swap({ quoteFeeAmount: null, usdValue: null, usdPriceSource: 'none' });
    await swaps.insert([row]);

    const result = await client.query({
      query: 'SELECT quote_fee_amount, usd_value FROM swaps WHERE signature = {signature:String}',
      query_params: { signature: row.signature },
      format: 'JSONEachRow',
    });
    const [stored] = await result.json<{
      quote_fee_amount: string | null;
      usd_value: number | null;
    }>();

    expect(stored?.quote_fee_amount).toBeNull();
    expect(stored?.usd_value).toBeNull();
  });

  it('counts distinct swaps even before parts have merged', async () => {
    // The same swap arriving from stream and from backfill must count once.
    // Plain count() would count twice until a merge happened, which would make
    // the P0 acceptance test depend on background timing.
    const duplicated = swap({ signature: `dup-${randomUUID()}` });
    await swaps.insert([duplicated]);
    await swaps.insert([{ ...duplicated, ingestSource: 'backfill' }]);

    const counted = await swaps.countByMint({
      mint: MINT,
      fromSec: BLOCK_TIME - 60,
      toSec: BLOCK_TIME + 60,
    });

    const direct = await client.query({
      query: 'SELECT count() AS rows FROM swaps WHERE signature = {signature:String}',
      query_params: { signature: duplicated.signature },
      format: 'JSONEachRow',
    });
    const [raw] = await direct.json<{ rows: string }>();

    expect(Number(raw?.rows)).toBe(2);
    expect(counted.swaps).toBeLessThan(counted.transactions + 1);
    expect(counted.byVenue['pumpfun']).toBe(counted.swaps);
  });

  it('distinguishes swaps in the same transaction by instruction index', async () => {
    const signature = `multi-${randomUUID()}`;
    await swaps.insert([
      swap({ signature, ixIndex: 0, innerIxIndex: -1 }),
      swap({ signature, ixIndex: 1, innerIxIndex: 3 }),
    ]);

    const result = await client.query({
      query: 'SELECT count() AS rows FROM swaps WHERE signature = {signature:String}',
      query_params: { signature },
      format: 'JSONEachRow',
    });
    const [stored] = await result.json<{ rows: string }>();
    expect(Number(stored?.rows)).toBe(2);
  });

  it('reports an empty window as empty rather than dated 1970', async () => {
    const counted = await swaps.countByMint({ mint: 'NoSuchMint', fromSec: 0, toSec: 1 });

    expect(counted.swaps).toBe(0);
    expect(counted.firstBlockTime).toBeNull();
    expect(counted.lastBlockTime).toBeNull();
    expect(counted.byVenue).toEqual({});
  });

  it('reads back the latest checkpoint, not a superseded one', async () => {
    const checkpoints = new CheckpointRepository(client);
    await checkpoints.set('test:stream', 100n);
    await checkpoints.set('test:stream', 250_000_000n);

    expect((await checkpoints.get('test:stream'))?.slot).toBe(250_000_000n);
    expect(await checkpoints.get('test:missing')).toBeNull();
  });

  it('stores and reloads the SOL/USD series by minute', async () => {
    const solUsd = new SolUsdRepository(client);
    await solUsd.insertCandles(
      [
        { minuteTs: BLOCK_TIME, open: 200, high: 201, low: 199, close: 200.5 },
        { minuteTs: BLOCK_TIME + 60, open: 200.5, high: 202, low: 200, close: 201 },
      ],
      'pyth_benchmarks',
    );

    const loaded = await solUsd.loadRange(BLOCK_TIME, BLOCK_TIME + 60);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.close).toBeCloseTo(200.5);

    const covered = await solUsd.coveredMinutes(BLOCK_TIME, BLOCK_TIME + 120);
    expect(covered.has(BLOCK_TIME)).toBe(true);
    expect(covered.has(BLOCK_TIME + 120)).toBe(false);
  });

  it('caches mint decimals', async () => {
    const mints = new MintRepository(client);
    await mints.upsertMany([{ mint: MINT, decimals: 6 }]);

    const found = await mints.getMany([MINT, 'UnknownMint']);
    expect(found.get(MINT)).toBe(6);
    expect(found.has('UnknownMint')).toBe(false);
  });

  it('records parse skips and summarises them by reason', async () => {
    await swaps.insertSkips([
      {
        slot: '1',
        signature: 'skip-sig',
        venue: 'pumpfun',
        reason: 'event_missing',
        ix_index: 0,
        inner_ix_index: -1,
        detail: 'no event',
      },
    ]);

    const now = Math.floor(Date.now() / 1000);
    const summary = await swaps.skipSummary(now - 300, now + 300);
    expect(summary.some((entry) => entry.reason === 'event_missing')).toBe(true);
  });
});
