import bs58 from 'bs58';
import { DataIntegrityError } from '@exitliquidity/core';
import type {
  RawInnerInstructionGroup,
  RawInstruction,
  RawTokenBalance,
  RawTransaction,
} from '../types.js';

/**
 * The `getTransaction` response under `encoding: "json"`.
 *
 * `jsonParsed` is deliberately not used: it rewrites instruction data into
 * per-program shapes that change without notice, and drops the raw bytes the
 * Anchor decoders need. `base64` would mean deserialising the message
 * ourselves for no gain.
 */
export interface RpcTransactionResponse {
  slot: number;
  blockTime: number | null;
  version?: 'legacy' | number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: RpcCompiledInstruction[];
    };
  };
  meta: RpcTransactionMeta | null;
}

export interface RpcCompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  /** Base58-encoded instruction data. */
  data: string;
  stackHeight?: number | null;
}

export interface RpcTransactionMeta {
  err: unknown;
  innerInstructions?: { index: number; instructions: RpcCompiledInstruction[] }[] | null;
  logMessages?: string[] | null;
  preTokenBalances?: RpcTokenBalance[] | null;
  postTokenBalances?: RpcTokenBalance[] | null;
  loadedAddresses?: { writable: string[]; readonly: string[] } | null;
}

export interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string; decimals: number };
}

/** Converts a JSON-RPC `getTransaction` result into the neutral shape. */
export function fromRpcTransaction(response: RpcTransactionResponse): RawTransaction {
  const signature = response.transaction.signatures[0];
  if (signature === undefined) {
    throw new DataIntegrityError('RPC transaction has no signature');
  }

  const meta = response.meta;

  return {
    signature,
    slot: BigInt(response.slot),
    blockTime: response.blockTime,
    // `getSignaturesForAddress` never returns vote transactions, so anything
    // arriving through this path is a real one.
    isVote: false,
    failed: meta?.err != null,
    accountKeys: response.transaction.message.accountKeys,
    loadedWritableAddresses: meta?.loadedAddresses?.writable ?? [],
    loadedReadonlyAddresses: meta?.loadedAddresses?.readonly ?? [],
    instructions: response.transaction.message.instructions.map(toRawInstruction),
    innerInstructions: (meta?.innerInstructions ?? []).map(toRawInnerGroup),
    preTokenBalances: (meta?.preTokenBalances ?? []).map(toRawTokenBalance),
    postTokenBalances: (meta?.postTokenBalances ?? []).map(toRawTokenBalance),
    logMessages: meta?.logMessages ?? [],
  };
}

function toRawInstruction(instruction: RpcCompiledInstruction): RawInstruction {
  return {
    programIdIndex: instruction.programIdIndex,
    accountIndexes: instruction.accounts,
    data: bs58.decode(instruction.data),
    stackHeight: instruction.stackHeight ?? undefined,
  };
}

function toRawInnerGroup(group: {
  index: number;
  instructions: RpcCompiledInstruction[];
}): RawInnerInstructionGroup {
  return {
    index: group.index,
    instructions: group.instructions.map(toRawInstruction),
  };
}

function toRawTokenBalance(balance: RpcTokenBalance): RawTokenBalance {
  const amount = balance.uiTokenAmount.amount;
  return {
    accountIndex: balance.accountIndex,
    mint: balance.mint,
    owner: balance.owner ?? null,
    decimals: balance.uiTokenAmount.decimals,
    amount: /^\d+$/.test(amount) ? BigInt(amount) : 0n,
  };
}
