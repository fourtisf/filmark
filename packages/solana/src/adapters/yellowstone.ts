import bs58 from 'bs58';
import { DataIntegrityError, parseUnsignedBigInt } from '@exitliquidity/core';
import type {
  RawInnerInstructionGroup,
  RawInstruction,
  RawTokenBalance,
  RawTransaction,
} from '../types.js';

/**
 * Structural mirrors of the Yellowstone protobuf messages.
 *
 * Declared here rather than imported so this package does not depend on the
 * gRPC client: the adapter is pure data shaping, and the ingest app owns the
 * transport.
 */
export interface YellowstoneCompiledInstruction {
  programIdIndex: number;
  accounts: Uint8Array;
  data: Uint8Array;
}

export interface YellowstoneInnerInstruction extends YellowstoneCompiledInstruction {
  stackHeight?: number | undefined;
}

export interface YellowstoneTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number } | undefined;
}

export interface YellowstoneTransactionInfo {
  signature: Uint8Array;
  isVote: boolean;
  transaction:
    | {
        signatures: Uint8Array[];
        message:
          | {
              accountKeys: Uint8Array[];
              instructions: YellowstoneCompiledInstruction[];
            }
          | undefined;
      }
    | undefined;
  meta:
    | {
        err: { err: Uint8Array } | undefined;
        innerInstructions: { index: number; instructions: YellowstoneInnerInstruction[] }[];
        logMessages: string[];
        preTokenBalances: YellowstoneTokenBalance[];
        postTokenBalances: YellowstoneTokenBalance[];
        loadedWritableAddresses: Uint8Array[];
        loadedReadonlyAddresses: Uint8Array[];
      }
    | undefined;
}

export interface FromYellowstoneOptions {
  /**
   * Block time for the slot, resolved separately.
   *
   * Transaction updates carry no block time — Yellowstone only exposes it on
   * block-meta updates — so the consumer joins it in. Null keeps the row
   * honest until it can be filled.
   */
  readonly blockTime: number | null;
}

/** Converts a Yellowstone transaction update into the neutral shape. */
export function fromYellowstoneTransaction(
  info: YellowstoneTransactionInfo,
  slot: string | bigint,
  options: FromYellowstoneOptions,
): RawTransaction {
  const message = info.transaction?.message;
  if (message === undefined) {
    throw new DataIntegrityError('Yellowstone transaction update has no message', {
      context: { signature: encodeSignature(info.signature) },
    });
  }
  const meta = info.meta;

  return {
    signature: encodeSignature(info.signature),
    slot: typeof slot === 'bigint' ? slot : parseUnsignedBigInt(slot, 'slot'),
    blockTime: options.blockTime,
    isVote: info.isVote,
    failed: meta?.err != null,
    accountKeys: message.accountKeys.map(encodePubkey),
    loadedWritableAddresses: (meta?.loadedWritableAddresses ?? []).map(encodePubkey),
    loadedReadonlyAddresses: (meta?.loadedReadonlyAddresses ?? []).map(encodePubkey),
    instructions: message.instructions.map(toRawInstruction),
    innerInstructions: (meta?.innerInstructions ?? []).map(toRawInnerGroup),
    preTokenBalances: (meta?.preTokenBalances ?? []).map(toRawTokenBalance),
    postTokenBalances: (meta?.postTokenBalances ?? []).map(toRawTokenBalance),
    logMessages: meta?.logMessages ?? [],
  };
}

function toRawInstruction(instruction: YellowstoneCompiledInstruction): RawInstruction {
  return {
    programIdIndex: instruction.programIdIndex,
    accountIndexes: Array.from(instruction.accounts),
    data: instruction.data,
    stackHeight: undefined,
  };
}

function toRawInnerGroup(group: {
  index: number;
  instructions: YellowstoneInnerInstruction[];
}): RawInnerInstructionGroup {
  return {
    index: group.index,
    instructions: group.instructions.map((instruction) => ({
      programIdIndex: instruction.programIdIndex,
      accountIndexes: Array.from(instruction.accounts),
      data: instruction.data,
      stackHeight: instruction.stackHeight,
    })),
  };
}

function toRawTokenBalance(balance: YellowstoneTokenBalance): RawTokenBalance {
  const amount = balance.uiTokenAmount?.amount ?? '0';
  return {
    accountIndex: balance.accountIndex,
    mint: balance.mint,
    // Yellowstone uses an empty string where JSON-RPC omits the field.
    owner: balance.owner === '' ? null : balance.owner,
    decimals: balance.uiTokenAmount?.decimals ?? 0,
    amount: /^\d+$/.test(amount) ? BigInt(amount) : 0n,
  };
}

function encodeSignature(signature: Uint8Array): string {
  return bs58.encode(signature);
}

function encodePubkey(pubkey: Uint8Array): string {
  return bs58.encode(pubkey);
}
