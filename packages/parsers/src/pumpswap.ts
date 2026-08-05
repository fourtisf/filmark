import {
  PUMPSWAP_PROGRAM_ID,
  isQuoteAsset,
  quoteAsset,
  sanitiseBlockTime,
  type ParsedSwap,
  type Side,
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
import { EVENT_PUMPSWAP_BUY, EVENT_PUMPSWAP_SELL, IX_BUY, IX_SELL } from './discriminators.js';
import {
  EMPTY_RESULT,
  describeChildren,
  skip,
  type ParseResult,
  type ParseSkip,
  type SwapParser,
} from './parser.js';

const VENUE: Venue = 'pumpswap';

/**
 * Positions of the two mints in the `buy`/`sell` account list.
 *
 * Used only as a fallback. The primary path resolves both mints from the
 * transaction's own token balances via the token-account pubkeys carried in
 * the event, which survives account-layout changes that these indices do not.
 */
const ACCOUNT_BASE_MINT = 3;
const ACCOUNT_QUOTE_MINT = 4;

/**
 * `BuyEvent` and `SellEvent` share a layout: fourteen u64/i64 fields followed
 * by six pubkeys. Trailing fields added by later program versions are ignored.
 */
const NUMERIC_FIELDS = 14;
const PUBKEY_FIELDS = 6;
const EVENT_MIN_BYTES = NUMERIC_FIELDS * 8 + PUBKEY_FIELDS * 32;

export interface PumpSwapTradeEvent {
  readonly timestamp: bigint;
  /** Base tokens out on a buy, in on a sell. */
  readonly baseAmount: bigint;
  /** Quote moving against the pool, fees excluded. */
  readonly poolQuoteAmount: bigint;
  /** Quote debited from (buy) or credited to (sell) the trader, fees included. */
  readonly userQuoteAmount: bigint;
  readonly pool: string;
  readonly user: string;
  readonly userBaseTokenAccount: string;
  readonly userQuoteTokenAccount: string;
}

/**
 * Decodes a PumpSwap trade event.
 *
 * Both directions share field positions; only the names differ in the IDL
 * (`base_amount_out`/`quote_amount_in` versus `base_amount_in`/
 * `quote_amount_out`), so one decoder covers both.
 */
export function decodePumpSwapEvent(payload: Uint8Array): PumpSwapTradeEvent {
  const reader = new BinaryReader(payload, 'pumpswap.TradeEvent');

  const timestamp = reader.i64();
  const baseAmount = reader.u64();
  reader.skip(8); // max_quote_amount_in / min_quote_amount_out — the user's limit, not the fill
  reader.skip(8); // user_base_token_reserves
  reader.skip(8); // user_quote_token_reserves
  reader.skip(8); // pool_base_token_reserves
  reader.skip(8); // pool_quote_token_reserves
  const poolQuoteAmount = reader.u64();
  reader.skip(8); // lp_fee_basis_points
  reader.skip(8); // lp_fee
  reader.skip(8); // protocol_fee_basis_points
  reader.skip(8); // protocol_fee
  reader.skip(8); // quote_amount_in_with_lp_fee / quote_amount_out_without_lp_fee
  const userQuoteAmount = reader.u64();

  return {
    timestamp,
    baseAmount,
    poolQuoteAmount,
    userQuoteAmount,
    pool: reader.pubkey(),
    user: reader.pubkey(),
    userBaseTokenAccount: reader.pubkey(),
    userQuoteTokenAccount: reader.pubkey(),
  };
}

interface ResolvedPair {
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly baseDecimals: number | null;
  readonly quoteDecimals: number | null;
  /** True when the pool's base asset is the quote currency, so the sides swap. */
  readonly inverted: boolean;
}

/**
 * PumpSwap AMM parser.
 *
 * Migrated pump.fun tokens keep trading here after the bonding curve
 * completes, so a wallet's history is split across both programs and both have
 * to land in the same table for position accounting to see one position.
 */
export class PumpSwapParser implements SwapParser {
  readonly venue = VENUE;
  readonly programId = PUMPSWAP_PROGRAM_ID;

  parse(ctx: TxContext): ParseResult {
    const nodes = ctx.nodesForProgram(this.programId);
    if (nodes.length === 0) return EMPTY_RESULT;

    const swaps: ParsedSwap[] = [];
    const skipped: ParseSkip[] = [];

    for (const node of nodes) {
      // The boundary belongs here, not around the whole parser. `registry.ts`
      // catches a throw from `parse`, but by then the swaps already collected
      // for this transaction are gone with it — a router batching three fills
      // loses all three because the fourth had a byte out of place.
      let outcome: ParsedSwap | ParseSkip | null;
      try {
        outcome = this.#parseNode(ctx, node);
      } catch (error) {
        skipped.push(
          skip(
            VENUE,
            'decode_error',
            ctx,
            node,
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }
      if (outcome === null) continue;
      if ('reason' in outcome) skipped.push(outcome);
      else swaps.push(outcome);
    }

    return { swaps, skipped };
  }

  #parseNode(ctx: TxContext, node: InstructionNode): ParsedSwap | ParseSkip | null {
    const discriminator = instructionDiscriminator(node);
    if (discriminator === null) return null;

    const isBuy = bytesEqual(discriminator, IX_BUY.bytes);
    const isSell = bytesEqual(discriminator, IX_SELL.bytes);
    if (!isBuy && !isSell) return null;

    const eventDiscriminator = isBuy ? EVENT_PUMPSWAP_BUY.bytes : EVENT_PUMPSWAP_SELL.bytes;
    const event = findChildEvent(node, eventDiscriminator);
    if (event === null) return skip(VENUE, 'event_missing', ctx, node, describeChildren(node));
    if (event.payload.length < EVENT_MIN_BYTES) {
      return skip(
        VENUE,
        'event_truncated',
        ctx,
        node,
        `event body was ${event.payload.length} bytes, need ${EVENT_MIN_BYTES}`,
      );
    }

    const trade = decodePumpSwapEvent(event.payload);
    if (trade.baseAmount === 0n || trade.poolQuoteAmount === 0n) {
      return skip(VENUE, 'empty_trade', ctx, node);
    }

    const pair = this.#resolvePair(ctx, node, trade);
    if (pair === null) {
      return skip(
        VENUE,
        'pair_unresolved',
        ctx,
        node,
        'neither side of the pool is a known quote asset',
      );
    }

    // Fees are the gap between what the pool saw and what the trader paid or
    // received. Deriving it this way captures every fee the program charges,
    // including ones added to the event struct after this was written.
    const fee = isBuy
      ? trade.userQuoteAmount - trade.poolQuoteAmount
      : trade.poolQuoteAmount - trade.userQuoteAmount;

    // `inverted` means the pool's base asset is the currency and its quote
    // asset is the token, so buying "base" is really selling the token.
    const side: Side = pair.inverted ? (isBuy ? 'sell' : 'buy') : isBuy ? 'buy' : 'sell';

    return {
      signature: ctx.signature,
      slot: ctx.slot,
      blockTime: ctx.blockTime ?? sanitiseBlockTime(trade.timestamp),
      venue: VENUE,
      poolId: trade.pool,
      mint: pair.inverted ? pair.quoteMint : pair.baseMint,
      wallet: trade.user,
      side,
      baseAmount: pair.inverted ? trade.poolQuoteAmount : trade.baseAmount,
      baseDecimals: pair.inverted ? pair.quoteDecimals : pair.baseDecimals,
      quoteAmount: pair.inverted ? trade.baseAmount : trade.poolQuoteAmount,
      // On an inverted pool the fee is denominated in the token, not the
      // currency, so it is not comparable and is recorded as unknown.
      quoteFeeAmount: pair.inverted ? null : fee >= 0n ? fee : null,
      quoteMint: pair.inverted ? pair.baseMint : pair.quoteMint,
      quoteDecimals: pair.inverted ? pair.baseDecimals : pair.quoteDecimals,
      ixIndex: node.ixIndex,
      innerIxIndex: node.innerIxIndex,
    };
  }

  /**
   * Works out which mint is the traded asset and which is the currency.
   *
   * The event names the trader's two token accounts, and the transaction's own
   * balance entries say what each of those accounts holds. That gives both
   * mints and both decimal counts without an RPC round trip and without
   * depending on where the mints sit in the account list.
   */
  #resolvePair(
    ctx: TxContext,
    node: InstructionNode,
    trade: PumpSwapTradeEvent,
  ): ResolvedPair | null {
    const baseMint =
      mintOfAccount(ctx, trade.userBaseTokenAccount) ?? accountAt(node, ACCOUNT_BASE_MINT);
    const quoteMint =
      mintOfAccount(ctx, trade.userQuoteTokenAccount) ?? accountAt(node, ACCOUNT_QUOTE_MINT);

    if (baseMint === null || quoteMint === null || baseMint === quoteMint) return null;

    const baseIsCurrency = isQuoteAsset(baseMint);
    const quoteIsCurrency = isQuoteAsset(quoteMint);

    // A pool of two currencies (SOL/USDC) is a real pool but not a position in
    // anything, and a pool of two unknown mints cannot be priced. Neither
    // belongs in an attribution table.
    if (baseIsCurrency === quoteIsCurrency) return null;

    return {
      baseMint,
      quoteMint,
      baseDecimals: ctx.decimalsFor(baseMint) ?? quoteAsset(baseMint)?.decimals ?? null,
      quoteDecimals: ctx.decimalsFor(quoteMint) ?? quoteAsset(quoteMint)?.decimals ?? null,
      inverted: baseIsCurrency,
    };
  }
}

function accountAt(node: InstructionNode, index: number): string | null {
  const account = node.accounts[index];
  return account === undefined || account === '' ? null : account;
}

/** Maps a token account pubkey to the mint it holds, using this transaction's balances. */
function mintOfAccount(ctx: TxContext, tokenAccount: string): string | null {
  const index = ctx.accountKeys.indexOf(tokenAccount);
  if (index === -1) return null;
  return ctx.mintOfTokenAccount(index);
}

export const pumpSwapParser = new PumpSwapParser();
