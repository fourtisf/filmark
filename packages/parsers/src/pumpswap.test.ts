import { PUMPSWAP_PROGRAM_ID, SOL_DECIMALS, USDC_MINT, WSOL_MINT } from '@exitliquidity/core';
import { BinaryWriter } from '@exitliquidity/solana';
import { describe, expect, it } from 'vitest';
import { IX_BUY, IX_SELL } from './discriminators.js';
import { pumpSwapParser } from './pumpswap.js';
import {
  PUMPSWAP_EVENT_DISCRIMINATORS,
  TransactionBuilder,
  anchorEventData,
  encodePumpSwapEvent,
  fakePubkey,
} from './testing.js';

const TOKEN = fakePubkey(40);
const POOL = fakePubkey(41);
const USER = fakePubkey(42);
const USER_BASE_ATA = fakePubkey(43);
const USER_QUOTE_ATA = fakePubkey(44);
const TIMESTAMP = 1_735_689_600n;

interface TradeOptions {
  readonly isBuy?: boolean;
  readonly baseAmount?: bigint;
  readonly poolQuoteAmount?: bigint;
  readonly userQuoteAmount?: bigint;
  readonly baseMint?: string;
  readonly quoteMint?: string;
  readonly baseDecimals?: number;
  readonly quoteDecimals?: number;
  /** Skip the token balance entries, forcing the account-index fallback. */
  readonly withTokenBalances?: boolean;
  readonly emitEvent?: boolean;
  readonly trailingBytes?: number;
}

function buildTrade(options: TradeOptions = {}): TransactionBuilder {
  const {
    isBuy = true,
    baseAmount = 500_000_000n,
    poolQuoteAmount = 1_000_000_000n,
    userQuoteAmount = isBuy ? 1_003_000_000n : 997_000_000n,
    baseMint = TOKEN,
    quoteMint = WSOL_MINT,
    baseDecimals = 6,
    quoteDecimals = SOL_DECIMALS,
    withTokenBalances = true,
    emitEvent = true,
  } = options;

  const builder = new TransactionBuilder();

  if (withTokenBalances) {
    builder.tokenAccount(USER_BASE_ATA, baseMint, USER, baseDecimals);
    builder.tokenAccount(USER_QUOTE_ATA, quoteMint, USER, quoteDecimals);
  }

  const ix = builder.topLevel({
    programId: PUMPSWAP_PROGRAM_ID,
    accounts: [
      POOL,
      USER,
      fakePubkey(45), // global config
      baseMint,
      quoteMint,
      USER_BASE_ATA,
      USER_QUOTE_ATA,
    ],
    data: new BinaryWriter()
      .bytes(isBuy ? IX_BUY.bytes : IX_SELL.bytes)
      .u64(baseAmount)
      .u64(userQuoteAmount)
      .toBytes(),
  });

  if (emitEvent) {
    builder.inner(ix, {
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        isBuy ? PUMPSWAP_EVENT_DISCRIMINATORS.buy : PUMPSWAP_EVENT_DISCRIMINATORS.sell,
        encodePumpSwapEvent({
          timestamp: TIMESTAMP,
          baseAmount,
          poolQuoteAmount,
          userQuoteAmount,
          pool: POOL,
          user: USER,
          userBaseTokenAccount: USER_BASE_ATA,
          userQuoteTokenAccount: USER_QUOTE_ATA,
          ...(options.trailingBytes === undefined ? {} : { trailingBytes: options.trailingBytes }),
        }),
      ),
    });
  }

  return builder;
}

describe('PumpSwapParser', () => {
  it('normalises a buy, recording the pool leg and the fee separately', () => {
    const { swaps, skipped } = pumpSwapParser.parse(buildTrade({ isBuy: true }).context());

    expect(skipped).toEqual([]);
    expect(swaps[0]).toMatchObject({
      venue: 'pumpswap',
      side: 'buy',
      mint: TOKEN,
      wallet: USER,
      poolId: POOL,
      baseAmount: 500_000_000n,
      baseDecimals: 6,
      quoteAmount: 1_000_000_000n,
      quoteMint: WSOL_MINT,
      quoteDecimals: SOL_DECIMALS,
    });
    // The trader paid 1.003 SOL for a 1.0 SOL pool leg.
    expect(swaps[0]?.quoteFeeAmount).toBe(3_000_000n);
  });

  it('records a sell fee as the shortfall against the pool leg', () => {
    const swap = pumpSwapParser.parse(buildTrade({ isBuy: false }).context()).swaps[0];

    expect(swap?.side).toBe('sell');
    expect(swap?.quoteAmount).toBe(1_000_000_000n);
    expect(swap?.quoteFeeAmount).toBe(3_000_000n);
  });

  it('resolves both mints from token balances without reading account positions', () => {
    // Same trade, but the instruction's mint accounts are wrong. The token
    // balance entries the event points at should still give the right pair.
    const builder = new TransactionBuilder();
    builder.tokenAccount(USER_BASE_ATA, TOKEN, USER, 6);
    builder.tokenAccount(USER_QUOTE_ATA, WSOL_MINT, USER, SOL_DECIMALS);

    const ix = builder.topLevel({
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [POOL, USER, fakePubkey(45), fakePubkey(98), fakePubkey(99)],
      data: new BinaryWriter().bytes(IX_BUY.bytes).toBytes(),
    });
    builder.inner(ix, {
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        PUMPSWAP_EVENT_DISCRIMINATORS.buy,
        encodePumpSwapEvent({
          timestamp: TIMESTAMP,
          baseAmount: 1n,
          poolQuoteAmount: 2n,
          userQuoteAmount: 2n,
          pool: POOL,
          user: USER,
          userBaseTokenAccount: USER_BASE_ATA,
          userQuoteTokenAccount: USER_QUOTE_ATA,
        }),
      ),
    });

    expect(pumpSwapParser.parse(builder.context()).swaps[0]).toMatchObject({
      mint: TOKEN,
      quoteMint: WSOL_MINT,
    });
  });

  it('falls back to the account list when the transaction has no token balances', () => {
    const swap = pumpSwapParser.parse(buildTrade({ withTokenBalances: false }).context()).swaps[0];

    expect(swap?.mint).toBe(TOKEN);
    expect(swap?.quoteMint).toBe(WSOL_MINT);
    // Decimals are unknown at parse time; the pipeline resolves them.
    expect(swap?.baseDecimals).toBeNull();
    expect(swap?.quoteDecimals).toBe(SOL_DECIMALS);
  });

  it('flips an inverted pool so mint is always the traded asset', () => {
    // Pool created with SOL as its base and the token as its quote. Buying the
    // pool's base means receiving SOL, which is a sell of the token.
    const swap = pumpSwapParser.parse(
      buildTrade({
        isBuy: true,
        baseMint: WSOL_MINT,
        quoteMint: TOKEN,
        baseDecimals: SOL_DECIMALS,
        quoteDecimals: 6,
        baseAmount: 1_000_000_000n,
        poolQuoteAmount: 500_000_000n,
        userQuoteAmount: 500_000_000n,
      }).context(),
    ).swaps[0];

    expect(swap).toMatchObject({
      side: 'sell',
      mint: TOKEN,
      quoteMint: WSOL_MINT,
      baseAmount: 500_000_000n,
      baseDecimals: 6,
      quoteAmount: 1_000_000_000n,
      quoteDecimals: SOL_DECIMALS,
    });
    // Fees on an inverted pool are denominated in the token, so they are not
    // comparable to a quote-denominated fee and stay unknown.
    expect(swap?.quoteFeeAmount).toBeNull();
  });

  it('handles a USDC-quoted pool', () => {
    const swap = pumpSwapParser.parse(
      buildTrade({ quoteMint: USDC_MINT, quoteDecimals: 6 }).context(),
    ).swaps[0];

    expect(swap?.quoteMint).toBe(USDC_MINT);
    expect(swap?.quoteDecimals).toBe(6);
  });

  it('skips a pool with no recognisable quote asset', () => {
    const { swaps, skipped } = pumpSwapParser.parse(
      buildTrade({ quoteMint: fakePubkey(60), quoteDecimals: 6 }).context(),
    );

    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('pair_unresolved');
  });

  it('skips a pool of two currencies, which is not a position in anything', () => {
    const { swaps, skipped } = pumpSwapParser.parse(
      buildTrade({ baseMint: USDC_MINT, baseDecimals: 6 }).context(),
    );

    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('pair_unresolved');
  });

  it('parses a longer event body from a newer program version', () => {
    const { swaps, skipped } = pumpSwapParser.parse(buildTrade({ trailingBytes: 64 }).context());
    expect(skipped).toEqual([]);
    expect(swaps[0]?.quoteAmount).toBe(1_000_000_000n);
  });

  it('skips an invocation that emitted no event', () => {
    const { swaps, skipped } = pumpSwapParser.parse(buildTrade({ emitEvent: false }).context());
    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('event_missing');
  });

  it('does not pair a buy instruction with a sell event', () => {
    // Both directions share the `global:buy`/`global:sell` discriminators, so
    // the event type is the only thing that confirms which one ran.
    const builder = new TransactionBuilder();
    builder.tokenAccount(USER_BASE_ATA, TOKEN, USER, 6);
    builder.tokenAccount(USER_QUOTE_ATA, WSOL_MINT, USER, SOL_DECIMALS);

    const ix = builder.topLevel({
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [POOL, USER, fakePubkey(45), TOKEN, WSOL_MINT],
      data: new BinaryWriter().bytes(IX_BUY.bytes).toBytes(),
    });
    builder.inner(ix, {
      programId: PUMPSWAP_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        PUMPSWAP_EVENT_DISCRIMINATORS.sell,
        encodePumpSwapEvent({
          timestamp: TIMESTAMP,
          baseAmount: 1n,
          poolQuoteAmount: 2n,
          userQuoteAmount: 2n,
          pool: POOL,
          user: USER,
          userBaseTokenAccount: USER_BASE_ATA,
          userQuoteTokenAccount: USER_QUOTE_ATA,
        }),
      ),
    });

    const { swaps, skipped } = pumpSwapParser.parse(builder.context());
    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('event_missing');
  });
});
