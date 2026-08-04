/**
 * A provider-neutral transaction shape.
 *
 * Yellowstone and JSON-RPC disagree about almost everything — base58 versus
 * bytes, `number[]` versus `Uint8Array`, where loaded addresses live — so both
 * are flattened into this before any parser sees them. Adding Raydium or
 * Meteora later means writing a parser, not another decoding path.
 */

export interface RawInstruction {
  /** Index into the resolved account key list. */
  readonly programIdIndex: number;
  /** Indices into the resolved account key list, in instruction order. */
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
  /**
   * Invocation depth: 1 for a top-level instruction, 2 for its direct CPI, and
   * so on. Undefined on transactions from validators older than v1.14.6.
   */
  readonly stackHeight: number | undefined;
}

export interface RawInnerInstructionGroup {
  /** Index of the top-level instruction these ran under. */
  readonly index: number;
  readonly instructions: readonly RawInstruction[];
}

export interface RawTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  /** Owner of the token account. Absent on very old transactions. */
  readonly owner: string | null;
  readonly decimals: number;
  /** Balance in raw units at this point in the transaction. */
  readonly amount: bigint;
}

export interface RawTransaction {
  /** Base58 transaction signature. */
  readonly signature: string;
  readonly slot: bigint;
  /** Unix seconds, or null when the source did not supply one. */
  readonly blockTime: number | null;
  readonly isVote: boolean;
  /** True when the transaction failed. Failed transactions move no tokens. */
  readonly failed: boolean;
  /** Static account keys, base58, in message order. */
  readonly accountKeys: readonly string[];
  /** Address-lookup-table writable addresses, appended after the static keys. */
  readonly loadedWritableAddresses: readonly string[];
  /** Address-lookup-table readonly addresses, appended after the writable ones. */
  readonly loadedReadonlyAddresses: readonly string[];
  readonly instructions: readonly RawInstruction[];
  readonly innerInstructions: readonly RawInnerInstructionGroup[];
  readonly preTokenBalances: readonly RawTokenBalance[];
  readonly postTokenBalances: readonly RawTokenBalance[];
  readonly logMessages: readonly string[];
}

/**
 * One instruction, with its account keys resolved and its place in the call
 * tree known.
 *
 * `parent`/`children` are what let a parser ask "which event did *this*
 * invocation emit" instead of guessing from ordering — which matters the
 * moment a router batches several swaps into one transaction.
 */
export interface InstructionNode {
  readonly programId: string;
  /** Resolved base58 account keys, in instruction order. */
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
  /** Index of the top-level instruction this belongs to. */
  readonly ixIndex: number;
  /** Position within that instruction's inner list, or -1 if it is the top-level one. */
  readonly innerIxIndex: number;
  readonly stackHeight: number;
  readonly parent: InstructionNode | null;
  readonly children: readonly InstructionNode[];
}
