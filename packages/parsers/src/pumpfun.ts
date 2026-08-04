import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_TOKEN_DECIMALS,
  SOL_DECIMALS,
  WSOL_MINT,
  sanitiseBlockTime,
  type ParsedSwap,
  type Venue,
} from '@exitliquidity/core';
import {
  BinaryReader,
  bytesEqual,
  findChildEvent,
  instructionDiscriminator,
  type InstructionNode,
  type TxContext,
} from '@exitliquidity/solana';
import { EVENT_TRADE, IX_BUY, IX_SELL } from './discriminators.js';
import { EMPTY_RESULT, skip, type ParseResult, type ParseSkip, type SwapParser } from './parser.js';

const VENUE: Venue = 'pumpfun';

/**
 * Position of the bonding curve in the `buy`/`sell` account list.
 *
 * The leading accounts have held constant across every version of the program
 * while the trailing ones have moved more than once, so nothing past this index
 * is relied on. The mint and the trader come from the event instead, which is
 * authoritative about what settled.
 */
const ACCOUNT_BONDING_CURVE = 3;
const MIN_ACCOUNTS = ACCOUNT_BONDING_CURVE + 1;

/**
 * Bytes of `TradeEvent` this parser depends on.
 *
 * The struct has grown repeatedly (real reserves, fee recipients, creator
 * fees). Everything after `timestamp` is ignored, so a longer payload from a
 * newer program version parses fine and a shorter one is rejected outright
 * rather than read past its end.
 */
const TRADE_EVENT_MIN_BYTES = 32 + 8 + 8 + 1 + 32 + 8;

export interface PumpFunTradeEvent {
  readonly mint: string;
  /** SOL moving against the bonding curve, in lamports, excluding protocol fees. */
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  /** Unix seconds, as stamped by the program. */
  readonly timestamp: bigint;
}

/** Decodes the `TradeEvent` prefix. Throws `DecodeError` if the body is short. */
export function decodeTradeEvent(payload: Uint8Array): PumpFunTradeEvent {
  const reader = new BinaryReader(payload, 'pumpfun.TradeEvent');
  return {
    mint: reader.pubkey(),
    solAmount: reader.u64(),
    tokenAmount: reader.u64(),
    isBuy: reader.bool(),
    user: reader.pubkey(),
    timestamp: reader.i64(),
  };
}

/**
 * Pump.fun bonding curve parser.
 *
 * Reads the emitted `TradeEvent` rather than the instruction arguments,
 * because the arguments only describe what the trader asked for — a buy names
 * the tokens wanted and the maximum SOL it will spend, neither of which is
 * what happened. The event carries the settled amounts.
 */
export class PumpFunParser implements SwapParser {
  readonly venue = VENUE;
  readonly programId = PUMP_FUN_PROGRAM_ID;

  parse(ctx: TxContext): ParseResult {
    const nodes = ctx.nodesForProgram(this.programId);
    if (nodes.length === 0) return EMPTY_RESULT;

    const swaps: ParsedSwap[] = [];
    const skipped: ParseSkip[] = [];

    for (const node of nodes) {
      const outcome = this.#parseNode(ctx, node);
      if (outcome === null) continue;
      if ('reason' in outcome) skipped.push(outcome);
      else swaps.push(outcome);
    }

    return { swaps, skipped };
  }

  /** Returns a swap, a skip to count, or null when the node is not a trade at all. */
  #parseNode(ctx: TxContext, node: InstructionNode): ParsedSwap | ParseSkip | null {
    const discriminator = instructionDiscriminator(node);
    if (discriminator === null) return null;

    const isBuyIx = bytesEqual(discriminator, IX_BUY.bytes);
    const isSellIx = bytesEqual(discriminator, IX_SELL.bytes);
    if (!isBuyIx && !isSellIx) return null;

    if (node.accounts.length < MIN_ACCOUNTS) {
      return skip(
        VENUE,
        'accounts_missing',
        ctx,
        node,
        `expected at least ${MIN_ACCOUNTS} accounts, got ${node.accounts.length}`,
      );
    }

    const event = findChildEvent(node, EVENT_TRADE.bytes);
    if (event === null) {
      // A failed inner call, or a program version that stopped emitting the
      // event. Either way there is no settled amount to record.
      return skip(VENUE, 'event_missing', ctx, node);
    }
    if (event.payload.length < TRADE_EVENT_MIN_BYTES) {
      return skip(
        VENUE,
        'event_truncated',
        ctx,
        node,
        `TradeEvent body was ${event.payload.length} bytes, need ${TRADE_EVENT_MIN_BYTES}`,
      );
    }

    const trade = decodeTradeEvent(event.payload);

    if (trade.solAmount === 0n || trade.tokenAmount === 0n) {
      return skip(VENUE, 'empty_trade', ctx, node);
    }

    const bondingCurve = node.accounts[ACCOUNT_BONDING_CURVE];
    if (bondingCurve === undefined || bondingCurve === '') {
      return skip(VENUE, 'accounts_missing', ctx, node, 'bonding curve account did not resolve');
    }

    return {
      signature: ctx.signature,
      slot: ctx.slot,
      // The program stamps the event with the block's own clock, so it is a
      // usable block time when the stream has not supplied one yet.
      blockTime: ctx.blockTime ?? sanitiseBlockTime(trade.timestamp),
      venue: VENUE,
      poolId: bondingCurve,
      mint: trade.mint,
      wallet: trade.user,
      // `is_buy` is the program's own view of direction; the instruction
      // discriminator only says which entry point was called.
      side: trade.isBuy ? 'buy' : 'sell',
      baseAmount: trade.tokenAmount,
      baseDecimals: ctx.decimalsFor(trade.mint) ?? PUMP_FUN_TOKEN_DECIMALS,
      quoteAmount: trade.solAmount,
      // The bonding curve charges its fee outside `sol_amount`, and the fee
      // fields were added to the event later than the ones decoded here. Null
      // records that honestly; see docs/verification.md before P1 relies on it.
      quoteFeeAmount: null,
      // Bonding curve trades move native SOL, not a token account. WSOL's mint
      // is used as its identifier so one column can describe every venue.
      quoteMint: WSOL_MINT,
      quoteDecimals: SOL_DECIMALS,
      ixIndex: node.ixIndex,
      innerIxIndex: node.innerIxIndex,
    };
  }
}

export const pumpFunParser = new PumpFunParser();
