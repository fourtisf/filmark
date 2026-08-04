import {
  PUMPSWAP_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID,
  SOL_DECIMALS,
  WSOL_MINT,
  createIngestMetrics,
  type IngestMetrics,
} from '@exitliquidity/core';
import { IX_BUY } from '@exitliquidity/parsers';
import {
  TRADE_EVENT_DISCRIMINATOR,
  TransactionBuilder,
  anchorEventData,
  encodePumpSwapEvent,
  encodeTradeEvent,
  fakePubkey,
} from '@exitliquidity/parsers/testing';
import { EVENT_PUMPSWAP_BUY } from '@exitliquidity/parsers';
import { NullOracle, SolUsdOracle, SolUsdSeries } from '@exitliquidity/pricing';
import { BinaryWriter, type RawTransaction } from '@exitliquidity/solana';
import { beforeEach, describe, expect, it } from 'vitest';
import { MintDecimalsResolver } from './decimals.js';
import { SwapPipeline } from './pipeline.js';

const MINT = fakePubkey(10);
const CURVE = fakePubkey(11);
const USER = fakePubkey(12);
const BLOCK_TIME = 1_735_689_600;

function pumpFunBuy(
  overrides: { blockTime?: number | null; solAmount?: bigint } = {},
): RawTransaction {
  const solAmount = overrides.solAmount ?? 2_000_000_000n;
  const builder = new TransactionBuilder().blockTime(
    overrides.blockTime === undefined ? BLOCK_TIME : overrides.blockTime,
  );

  const ix = builder.topLevel({
    programId: PUMP_FUN_PROGRAM_ID,
    accounts: [fakePubkey(1), fakePubkey(2), MINT, CURVE, fakePubkey(5), fakePubkey(6), USER],
    data: new BinaryWriter().bytes(IX_BUY.bytes).u64(1n).u64(solAmount).toBytes(),
  });
  builder.inner(ix, {
    programId: PUMP_FUN_PROGRAM_ID,
    accounts: [fakePubkey(90)],
    data: anchorEventData(
      TRADE_EVENT_DISCRIMINATOR,
      encodeTradeEvent({
        mint: MINT,
        solAmount,
        tokenAmount: 1_000_000_000n,
        isBuy: true,
        user: USER,
        timestamp: BigInt(BLOCK_TIME),
      }),
    ),
  });

  return builder.build();
}

describe('SwapPipeline', () => {
  let metrics: IngestMetrics;
  let series: SolUsdSeries;

  beforeEach(() => {
    metrics = createIngestMetrics();
    series = new SolUsdSeries(300);
    series.load([{ minuteTs: BLOCK_TIME, open: 200, high: 200, low: 200, close: 200 }]);
  });

  function pipeline(overrides: { minSwapUsd?: number; priced?: boolean } = {}): SwapPipeline {
    return new SwapPipeline({
      decimals: new MintDecimalsResolver(),
      oracle: overrides.priced === false ? new NullOracle() : new SolUsdOracle(series),
      metrics,
      ...(overrides.minSwapUsd === undefined ? {} : { minSwapUsd: overrides.minSwapUsd }),
    });
  }

  it('produces a fully normalised row from a raw transaction', async () => {
    const { swaps, skips } = await pipeline().process(pumpFunBuy(), 'stream');

    expect(skips).toEqual([]);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toEqual({
      signature: expect.any(String),
      slot: 250_000_000n,
      blockTime: BLOCK_TIME,
      venue: 'pumpfun',
      poolId: CURVE,
      mint: MINT,
      wallet: USER,
      side: 'buy',
      baseAmount: 1_000_000_000n,
      baseDecimals: 6,
      quoteAmount: 2_000_000_000n,
      quoteFeeAmount: null,
      quoteMint: WSOL_MINT,
      quoteDecimals: SOL_DECIMALS,
      // 2 SOL at $200.
      usdValue: 400,
      usdPriceSource: 'pyth_1m',
      ixIndex: 0,
      innerIxIndex: -1,
      ingestSource: 'stream',
    });
  });

  it('drops a failed transaction, since it moved no tokens', async () => {
    const raw = { ...pumpFunBuy(), failed: true };
    const { swaps } = await pipeline().process(raw, 'stream');

    expect(swaps).toEqual([]);
    expect(metrics.dropped.get({ reason: 'failed_transaction', source: 'stream' })).toBe(1);
  });

  it('drops a vote transaction', async () => {
    const raw = { ...pumpFunBuy(), isVote: true };
    expect((await pipeline().process(raw, 'stream')).swaps).toEqual([]);
    expect(metrics.dropped.get({ reason: 'vote_transaction', source: 'stream' })).toBe(1);
  });

  it('writes the row unpriced rather than skipping it when no price is available', async () => {
    // A swap with no USD figure is still a swap and still counts towards the
    // P0 acceptance test. Only the dollar column is unknown.
    const { swaps } = await pipeline({ priced: false }).process(pumpFunBuy(), 'backfill');

    expect(swaps).toHaveLength(1);
    expect(swaps[0]?.usdValue).toBeNull();
    expect(swaps[0]?.usdPriceSource).toBe('none');
    expect(metrics.unpriced.get({ reason: 'no_price_in_range', venue: 'pumpfun' })).toBe(1);
  });

  it('applies a minimum USD size only where a size is known', async () => {
    const filtered = pipeline({ minSwapUsd: 1000 });

    expect((await filtered.process(pumpFunBuy(), 'stream')).swaps).toHaveLength(0);
    expect(
      metrics.dropped.get({ reason: 'below_min_usd', source: 'stream', venue: 'pumpfun' }),
    ).toBe(1);

    const unpricedPipeline = new SwapPipeline({
      decimals: new MintDecimalsResolver(),
      oracle: new NullOracle(),
      metrics,
      minSwapUsd: 1000,
    });
    expect((await unpricedPipeline.process(pumpFunBuy(), 'stream')).swaps).toHaveLength(1);
  });

  it('records a parse skip instead of failing the transaction', async () => {
    // A pump.fun buy with no event: the instruction matched, nothing settled.
    const builder = new TransactionBuilder().blockTime(BLOCK_TIME);
    builder.topLevel({
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(1), fakePubkey(2), MINT, CURVE],
      data: new BinaryWriter().bytes(IX_BUY.bytes).toBytes(),
    });

    const { swaps, skips } = await pipeline().process(builder.build(), 'stream');

    expect(swaps).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ venue: 'pumpfun', reason: 'event_missing' });
    expect(metrics.parseFailures.get({ venue: 'pumpfun', reason: 'event_missing' })).toBe(1);
  });

  it('falls back to the event clock when the source supplied no block time', async () => {
    const { swaps } = await pipeline().process(pumpFunBuy({ blockTime: null }), 'stream');
    expect(swaps[0]?.blockTime).toBe(BLOCK_TIME);
  });

  it('resolves decimals a transaction did not declare', async () => {
    // A PumpSwap trade whose token account balances are absent, so the base
    // mint's decimals have to come from the resolver.
    const token = fakePubkey(50);
    const pool = fakePubkey(51);
    const baseAta = fakePubkey(52);
    const quoteAta = fakePubkey(53);

    const builder = new TransactionBuilder().blockTime(BLOCK_TIME);
    const ix = builder.topLevel({
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [pool, USER, fakePubkey(54), token, WSOL_MINT, baseAta, quoteAta],
      data: new BinaryWriter().bytes(IX_BUY.bytes).toBytes(),
    });
    builder.inner(ix, {
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        EVENT_PUMPSWAP_BUY.bytes,
        encodePumpSwapEvent({
          timestamp: BigInt(BLOCK_TIME),
          baseAmount: 5_000_000n,
          poolQuoteAmount: 1_000_000_000n,
          userQuoteAmount: 1_005_000_000n,
          pool,
          user: USER,
          userBaseTokenAccount: baseAta,
          userQuoteTokenAccount: quoteAta,
        }),
      ),
    });

    const decimals = new MintDecimalsResolver();
    decimals.remember(token, 8);

    const withCache = new SwapPipeline({ decimals, oracle: new SolUsdOracle(series), metrics });
    const { swaps } = await withCache.process(builder.build(), 'backfill');

    expect(swaps[0]?.baseDecimals).toBe(8);
    expect(swaps[0]?.quoteFeeAmount).toBe(5_000_000n);
  });

  it('drops a swap whose base decimals cannot be resolved anywhere', async () => {
    const token = fakePubkey(60);
    const pool = fakePubkey(61);
    const baseAta = fakePubkey(62);
    const quoteAta = fakePubkey(63);

    const builder = new TransactionBuilder().blockTime(BLOCK_TIME);
    const ix = builder.topLevel({
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [pool, USER, fakePubkey(64), token, WSOL_MINT, baseAta, quoteAta],
      data: new BinaryWriter().bytes(IX_BUY.bytes).toBytes(),
    });
    builder.inner(ix, {
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        EVENT_PUMPSWAP_BUY.bytes,
        encodePumpSwapEvent({
          timestamp: BigInt(BLOCK_TIME),
          baseAmount: 1n,
          poolQuoteAmount: 1n,
          userQuoteAmount: 1n,
          pool,
          user: USER,
          userBaseTokenAccount: baseAta,
          userQuoteTokenAccount: quoteAta,
        }),
      ),
    });

    // No RPC, no cache: a wrong exponent is a thousand-fold error downstream,
    // so the row is dropped rather than guessed at.
    const { swaps } = await pipeline().process(builder.build(), 'backfill');

    expect(swaps).toEqual([]);
    expect(
      metrics.dropped.get({
        reason: 'unknown_base_decimals',
        source: 'backfill',
        venue: 'pumpswap',
      }),
    ).toBe(1);
  });

  it('counts transactions and swaps by source', async () => {
    const p = pipeline();
    await p.process(pumpFunBuy(), 'stream');
    await p.process(pumpFunBuy(), 'backfill');

    expect(metrics.transactions.get({ source: 'stream' })).toBe(1);
    expect(metrics.transactions.get({ source: 'backfill' })).toBe(1);
    expect(metrics.swaps.get({ venue: 'pumpfun', source: 'stream' })).toBe(1);
    expect(metrics.lastSlot.get({ source: 'stream' })).toBe(250_000_000);
  });
});
