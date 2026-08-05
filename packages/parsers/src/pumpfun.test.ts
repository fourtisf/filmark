import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_TOKEN_DECIMALS,
  SOL_DECIMALS,
  WSOL_MINT,
} from '@exitliquidity/core';
import { BinaryWriter } from '@exitliquidity/solana';
import { describe, expect, it } from 'vitest';
import { IX_BUY, IX_SELL } from './discriminators.js';
import { pumpFunParser } from './pumpfun.js';
import {
  TRADE_EVENT_DISCRIMINATOR,
  TransactionBuilder,
  anchorEventData,
  encodeTradeEvent,
  fakePubkey,
} from './testing.js';

const MINT = fakePubkey(10);
const CURVE = fakePubkey(11);
const USER = fakePubkey(12);
const TIMESTAMP = 1_735_689_600n;

interface TradeOptions {
  readonly isBuy?: boolean;
  readonly solAmount?: bigint;
  readonly tokenAmount?: bigint;
  readonly mint?: string;
  readonly user?: string;
  readonly trailingBytes?: number;
  readonly emitEvent?: boolean;
  readonly accounts?: readonly string[];
  readonly blockTime?: number | null;
}

/** A pump.fun buy/sell with its `TradeEvent` emitted as the program does. */
function buildTrade(options: TradeOptions = {}): TransactionBuilder {
  const {
    isBuy = true,
    solAmount = 1_500_000_000n,
    tokenAmount = 42_000_000_000n,
    mint = MINT,
    user = USER,
    emitEvent = true,
    blockTime = 1_735_689_600,
  } = options;

  const accounts = options.accounts ?? [
    fakePubkey(1), // global
    fakePubkey(2), // fee recipient
    mint,
    CURVE,
    fakePubkey(5), // associated bonding curve
    fakePubkey(6), // associated user
    user,
  ];

  const builder = new TransactionBuilder().blockTime(blockTime);
  const ix = builder.topLevel({
    programId: PUMP_FUN_PROGRAM_ID,
    accounts,
    data: new BinaryWriter()
      .bytes(isBuy ? IX_BUY.bytes : IX_SELL.bytes)
      .u64(tokenAmount)
      .u64(solAmount)
      .toBytes(),
  });

  if (emitEvent) {
    builder.inner(ix, {
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        TRADE_EVENT_DISCRIMINATOR,
        encodeTradeEvent({
          mint,
          solAmount,
          tokenAmount,
          isBuy,
          user,
          timestamp: TIMESTAMP,
          ...(options.trailingBytes === undefined ? {} : { trailingBytes: options.trailingBytes }),
        }),
      ),
    });
  }

  return builder;
}

describe('PumpFunParser', () => {
  it('normalises a buy into a single swap row', () => {
    const { swaps, skipped } = pumpFunParser.parse(buildTrade({ isBuy: true }).context());

    expect(skipped).toEqual([]);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({
      venue: 'pumpfun',
      side: 'buy',
      mint: MINT,
      wallet: USER,
      poolId: CURVE,
      baseAmount: 42_000_000_000n,
      baseDecimals: PUMP_FUN_TOKEN_DECIMALS,
      quoteAmount: 1_500_000_000n,
      quoteMint: WSOL_MINT,
      quoteDecimals: SOL_DECIMALS,
      ixIndex: 0,
      innerIxIndex: -1,
    });
  });

  it('takes direction from the event, not the instruction that was called', () => {
    // A `sell` entry point emitting `is_buy = true` should be recorded as a
    // buy: the event describes what settled.
    const builder = new TransactionBuilder();
    const ix = builder.topLevel({
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(1), fakePubkey(2), MINT, CURVE, fakePubkey(5), fakePubkey(6), USER],
      data: new BinaryWriter().bytes(IX_SELL.bytes).u64(1n).u64(1n).toBytes(),
    });
    builder.inner(ix, {
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(
        TRADE_EVENT_DISCRIMINATOR,
        encodeTradeEvent({
          mint: MINT,
          solAmount: 10n,
          tokenAmount: 20n,
          isBuy: true,
          user: USER,
          timestamp: TIMESTAMP,
        }),
      ),
    });

    expect(pumpFunParser.parse(builder.context()).swaps[0]?.side).toBe('buy');
  });

  it('records fees as unknown rather than zero', () => {
    const swap = pumpFunParser.parse(buildTrade().context()).swaps[0];
    expect(swap?.quoteFeeAmount).toBeNull();
  });

  it('parses a longer event body from a newer program version', () => {
    const { swaps, skipped } = pumpFunParser.parse(buildTrade({ trailingBytes: 96 }).context());
    expect(skipped).toEqual([]);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]?.quoteAmount).toBe(1_500_000_000n);
  });

  it('skips, rather than throws, when the event body is truncated', () => {
    const builder = new TransactionBuilder();
    const ix = builder.topLevel({
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(1), fakePubkey(2), MINT, CURVE],
      data: new BinaryWriter().bytes(IX_BUY.bytes).toBytes(),
    });
    builder.inner(ix, {
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(TRADE_EVENT_DISCRIMINATOR, new Uint8Array(40)),
    });

    const { swaps, skipped } = pumpFunParser.parse(builder.context());
    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('event_truncated');
  });

  it('skips an invocation that emitted no event', () => {
    const { swaps, skipped } = pumpFunParser.parse(buildTrade({ emitEvent: false }).context());
    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('event_missing');
  });

  it('skips when the account list is too short to name the bonding curve', () => {
    const { swaps, skipped } = pumpFunParser.parse(
      buildTrade({ accounts: [fakePubkey(1), fakePubkey(2), MINT] }).context(),
    );
    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('accounts_missing');
  });

  it('skips a zero-amount trade', () => {
    const { swaps, skipped } = pumpFunParser.parse(buildTrade({ tokenAmount: 0n }).context());
    expect(swaps).toEqual([]);
    expect(skipped[0]?.reason).toBe('empty_trade');
  });

  it('ignores instructions that are not buys or sells', () => {
    const builder = new TransactionBuilder();
    builder.topLevel({
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(1), fakePubkey(2), MINT, CURVE],
      data: new BinaryWriter().bytes(Uint8Array.of(24, 30, 200, 40, 5, 28, 7, 119)).toBytes(),
    });

    expect(pumpFunParser.parse(builder.context())).toEqual({ swaps: [], skipped: [] });
  });

  it('falls back to the event clock when the stream supplied no block time', () => {
    const swap = pumpFunParser.parse(buildTrade({ blockTime: null }).context()).swaps[0];
    expect(swap?.blockTime).toBe(Number(TIMESTAMP));
  });

  it('prefers decimals from the transaction over the pump.fun default', () => {
    const builder = buildTrade();
    builder.tokenAccount(fakePubkey(77), MINT, USER, 9);

    expect(pumpFunParser.parse(builder.context()).swaps[0]?.baseDecimals).toBe(9);
  });

  it('pairs each buy in a batched transaction with its own event', () => {
    // A router calling pump.fun twice must not have its events crossed. Sizes
    // differ so a mispairing changes the output rather than hiding in it.
    const secondMint = fakePubkey(20);
    const secondUser = fakePubkey(21);
    const secondCurve = fakePubkey(22);
    const builder = new TransactionBuilder();
    const router = fakePubkey(30);

    const outer = builder.topLevel({
      programId: router,
      accounts: [fakePubkey(31)],
      data: Uint8Array.of(1),
    });

    for (const [mint, curve, user, sol, tokens] of [
      [MINT, CURVE, USER, 1_000_000_000n, 10_000_000n],
      [secondMint, secondCurve, secondUser, 2_000_000_000n, 20_000_000n],
    ] as const) {
      builder.inner(outer, {
        programId: PUMP_FUN_PROGRAM_ID,
        accounts: [fakePubkey(1), fakePubkey(2), mint, curve, fakePubkey(5), fakePubkey(6), user],
        data: new BinaryWriter().bytes(IX_BUY.bytes).u64(tokens).u64(sol).toBytes(),
        stackHeight: 2,
      });
      builder.inner(outer, {
        programId: PUMP_FUN_PROGRAM_ID,
        accounts: [fakePubkey(90)],
        data: anchorEventData(
          TRADE_EVENT_DISCRIMINATOR,
          encodeTradeEvent({
            mint,
            solAmount: sol,
            tokenAmount: tokens,
            isBuy: true,
            user,
            timestamp: TIMESTAMP,
          }),
        ),
        stackHeight: 3,
      });
    }

    const { swaps } = pumpFunParser.parse(builder.context());
    expect(swaps).toHaveLength(2);
    expect(swaps.map((s) => [s.mint, s.quoteAmount, s.wallet])).toEqual([
      [MINT, 1_000_000_000n, USER],
      [secondMint, 2_000_000_000n, secondUser],
    ]);
  });
  it("keeps a transaction's other swaps when one node will not decode", () => {
    // A router batches fills; if the layout has drifted, one of them throws
    // inside the decoder. The error boundary used to sit around the whole
    // parser in registry.ts, so the throw discarded every swap already
    // collected for that transaction — three good fills lost because a fourth
    // had a byte out of place. Here the first trade's `is_buy` is neither 0
    // nor 1, which is exactly what a shifted field looks like.
    const goodMint = fakePubkey(70);
    const goodUser = fakePubkey(71);

    const builder = new TransactionBuilder().blockTime(1_735_689_600);

    const badIx = builder.topLevel({
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(1), fakePubkey(2), MINT, CURVE, fakePubkey(5), fakePubkey(6), USER],
      data: new BinaryWriter().bytes(IX_BUY.bytes).u64(1n).u64(1n).toBytes(),
    });

    // 32-byte mint, then two u64s, puts the bool at offset 48.
    const corrupt = encodeTradeEvent({
      mint: MINT,
      solAmount: 1_000_000_000n,
      tokenAmount: 1_000_000n,
      isBuy: true,
      user: USER,
      timestamp: TIMESTAMP,
    });
    corrupt[48] = 2;

    builder.inner(badIx, {
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(90)],
      data: anchorEventData(TRADE_EVENT_DISCRIMINATOR, corrupt),
    });

    const goodIx = builder.topLevel({
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [
        fakePubkey(1),
        fakePubkey(2),
        goodMint,
        CURVE,
        fakePubkey(5),
        fakePubkey(6),
        goodUser,
      ],
      data: new BinaryWriter().bytes(IX_SELL.bytes).u64(5n).u64(5n).toBytes(),
    });
    builder.inner(goodIx, {
      programId: PUMP_FUN_PROGRAM_ID,
      accounts: [fakePubkey(91)],
      data: anchorEventData(
        TRADE_EVENT_DISCRIMINATOR,
        encodeTradeEvent({
          mint: goodMint,
          solAmount: 3_000_000_000n,
          tokenAmount: 7_000_000n,
          isBuy: false,
          user: goodUser,
          timestamp: TIMESTAMP,
        }),
      ),
    });

    const { swaps, skipped } = pumpFunParser.parse(builder.context());

    expect(swaps).toHaveLength(1);
    expect(swaps[0]?.mint).toBe(goodMint);
    expect(swaps[0]?.wallet).toBe(goodUser);
    expect(swaps[0]?.side).toBe('sell');

    // The failure is counted, not silent: a rising decode_error is how a
    // drifted layout announces itself.
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('decode_error');
    expect(skipped[0]?.detail).toContain('invalid bool byte 2');
  });
});
