import bs58 from 'bs58';
import { ANCHOR_CPI_EVENT_TAG } from '@exitliquidity/core';
import {
  BinaryWriter,
  TxContext,
  type RawInstruction,
  type RawTokenBalance,
  type RawTransaction,
} from '@exitliquidity/solana';
import { EVENT_PUMPSWAP_BUY, EVENT_PUMPSWAP_SELL, EVENT_TRADE } from './discriminators.js';

/**
 * Byte-exact transaction fixtures.
 *
 * The parsers read raw Anchor payloads, so testing them against hand-written
 * objects would test nothing. These helpers encode the same layouts the
 * programs emit, which means a decoder that drifts from the layout fails here
 * rather than in production against a real token.
 *
 * Shipped from `src` rather than a test folder so the ingest app's own tests
 * can build transactions without duplicating the encoders.
 */

/** Deterministic 32-byte pubkeys. Distinct seeds give distinct keys. */
export function fakePubkey(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 31 + i * 7 + 1) & 0xff;
  // A non-zero leading byte keeps the base58 form a full-length address.
  bytes[0] = ((seed % 254) + 1) & 0xff;
  return bs58.encode(bytes);
}

/** Wraps an event body the way Anchor's `emit_cpi!` does. */
export function anchorEventData(discriminator: Uint8Array, payload: Uint8Array): Uint8Array {
  return new BinaryWriter()
    .bytes(ANCHOR_CPI_EVENT_TAG)
    .bytes(discriminator)
    .bytes(payload)
    .toBytes();
}

export interface TradeEventFields {
  readonly mint: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  readonly timestamp: bigint;
  /** Bytes appended after the fields the parser reads, as newer versions do. */
  readonly trailingBytes?: number;
}

export function encodeTradeEvent(fields: TradeEventFields): Uint8Array {
  const writer = new BinaryWriter()
    .pubkey(fields.mint)
    .u64(fields.solAmount)
    .u64(fields.tokenAmount)
    .bool(fields.isBuy)
    .pubkey(fields.user)
    .i64(fields.timestamp)
    // virtual_sol_reserves and virtual_token_reserves: present in every
    // version, never read by the parser.
    .u64(0n)
    .u64(0n);
  if (fields.trailingBytes !== undefined) writer.zeros(fields.trailingBytes);
  return writer.toBytes();
}

export interface PumpSwapEventFields {
  readonly timestamp: bigint;
  readonly baseAmount: bigint;
  readonly poolQuoteAmount: bigint;
  readonly userQuoteAmount: bigint;
  readonly pool: string;
  readonly user: string;
  readonly userBaseTokenAccount: string;
  readonly userQuoteTokenAccount: string;
  readonly trailingBytes?: number;
}

export function encodePumpSwapEvent(fields: PumpSwapEventFields): Uint8Array {
  const writer = new BinaryWriter()
    .i64(fields.timestamp)
    .u64(fields.baseAmount)
    .u64(0n) // max_quote_amount_in / min_quote_amount_out
    .u64(0n) // user_base_token_reserves
    .u64(0n) // user_quote_token_reserves
    .u64(0n) // pool_base_token_reserves
    .u64(0n) // pool_quote_token_reserves
    .u64(fields.poolQuoteAmount)
    .u64(0n) // lp_fee_basis_points
    .u64(0n) // lp_fee
    .u64(0n) // protocol_fee_basis_points
    .u64(0n) // protocol_fee
    .u64(0n) // quote_amount_in_with_lp_fee / quote_amount_out_without_lp_fee
    .u64(fields.userQuoteAmount)
    .pubkey(fields.pool)
    .pubkey(fields.user)
    .pubkey(fields.userBaseTokenAccount)
    .pubkey(fields.userQuoteTokenAccount)
    .pubkey(fakePubkey(200)) // protocol_fee_recipient
    .pubkey(fakePubkey(201)); // protocol_fee_recipient_token_account
  if (fields.trailingBytes !== undefined) writer.zeros(fields.trailingBytes);
  return writer.toBytes();
}

export const PUMPSWAP_EVENT_DISCRIMINATORS = {
  buy: EVENT_PUMPSWAP_BUY.bytes,
  sell: EVENT_PUMPSWAP_SELL.bytes,
} as const;

export const TRADE_EVENT_DISCRIMINATOR = EVENT_TRADE.bytes;

export interface InstructionSpec {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
  /** Omit for a top-level instruction; 2 or more for a CPI. */
  readonly stackHeight?: number;
}

/**
 * Assembles a `RawTransaction` from instructions written in terms of pubkeys.
 *
 * Account indices, the key table and the inner-instruction grouping are all
 * derived, so a fixture describes what happened rather than how the runtime
 * encodes it.
 */
export class TransactionBuilder {
  readonly #keys: string[] = [];
  readonly #top: { instruction: RawInstruction; inner: RawInstruction[] }[] = [];
  readonly #preBalances: RawTokenBalance[] = [];
  readonly #postBalances: RawTokenBalance[] = [];
  #signature = fakePubkey(1);
  #slot = 250_000_000n;
  #blockTime: number | null = 1_735_689_600;
  #failed = false;

  signature(value: string): this {
    this.#signature = value;
    return this;
  }

  slot(value: bigint): this {
    this.#slot = value;
    return this;
  }

  blockTime(value: number | null): this {
    this.#blockTime = value;
    return this;
  }

  failed(value = true): this {
    this.#failed = value;
    return this;
  }

  /** Adds a top-level instruction and returns its index. */
  topLevel(spec: InstructionSpec): number {
    this.#top.push({ instruction: this.#compile(spec, 1), inner: [] });
    return this.#top.length - 1;
  }

  /** Adds a CPI under the top-level instruction at `parentIndex`. */
  inner(parentIndex: number, spec: InstructionSpec): this {
    const group = this.#top[parentIndex];
    if (group === undefined) throw new RangeError(`no top-level instruction ${parentIndex}`);
    group.inner.push(this.#compile(spec, spec.stackHeight ?? 2));
    return this;
  }

  /**
   * Registers a token account so `TxContext` can resolve its mint and decimals,
   * exactly as a real transaction's balance entries do.
   */
  tokenAccount(account: string, mint: string, owner: string, decimals: number, amount = 0n): this {
    const accountIndex = this.#keyIndex(account);
    const balance: RawTokenBalance = { accountIndex, mint, owner, decimals, amount };
    this.#preBalances.push(balance);
    this.#postBalances.push(balance);
    return this;
  }

  build(): RawTransaction {
    return {
      signature: this.#signature,
      slot: this.#slot,
      blockTime: this.#blockTime,
      isVote: false,
      failed: this.#failed,
      accountKeys: [...this.#keys],
      loadedWritableAddresses: [],
      loadedReadonlyAddresses: [],
      instructions: this.#top.map((group) => group.instruction),
      innerInstructions: this.#top
        .map((group, index) => ({ index, instructions: group.inner }))
        .filter((group) => group.instructions.length > 0),
      preTokenBalances: this.#preBalances,
      postTokenBalances: this.#postBalances,
      logMessages: [],
    };
  }

  context(): TxContext {
    return TxContext.from(this.build());
  }

  #compile(spec: InstructionSpec, stackHeight: number): RawInstruction {
    return {
      programIdIndex: this.#keyIndex(spec.programId),
      accountIndexes: spec.accounts.map((account) => this.#keyIndex(account)),
      data: spec.data,
      stackHeight,
    };
  }

  #keyIndex(key: string): number {
    const existing = this.#keys.indexOf(key);
    if (existing !== -1) return existing;
    this.#keys.push(key);
    return this.#keys.length - 1;
  }
}
