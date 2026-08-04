import { DataIntegrityError } from '@exitliquidity/core';
import type { InstructionNode, RawInstruction, RawTokenBalance, RawTransaction } from './types.js';

interface MutableNode extends Omit<InstructionNode, 'parent' | 'children'> {
  parent: InstructionNode | null;
  children: InstructionNode[];
}

/**
 * A decoded transaction with its accounts resolved and its call tree built.
 *
 * Parsers are handed one of these and nothing else, which keeps them free of
 * both provider quirks and RPC access.
 */
export class TxContext {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTime: number | null;
  readonly nodes: readonly InstructionNode[];

  readonly #accountKeys: readonly string[];
  readonly #decimalsByMint: ReadonlyMap<string, number>;
  readonly #ownerByAccountIndex: ReadonlyMap<number, string>;
  readonly #mintByAccountIndex: ReadonlyMap<number, string>;

  private constructor(raw: RawTransaction) {
    this.signature = raw.signature;
    this.slot = raw.slot;
    this.blockTime = raw.blockTime;

    // Loaded addresses are appended in this exact order by the runtime:
    // static keys, then writable lookups, then readonly lookups. Getting the
    // order wrong shifts every account in a versioned transaction.
    this.#accountKeys = [
      ...raw.accountKeys,
      ...raw.loadedWritableAddresses,
      ...raw.loadedReadonlyAddresses,
    ];

    const decimals = new Map<string, number>();
    const owners = new Map<number, string>();
    const mints = new Map<number, string>();
    for (const balance of [...raw.preTokenBalances, ...raw.postTokenBalances]) {
      decimals.set(balance.mint, balance.decimals);
      mints.set(balance.accountIndex, balance.mint);
      if (balance.owner !== null) owners.set(balance.accountIndex, balance.owner);
    }
    this.#decimalsByMint = decimals;
    this.#ownerByAccountIndex = owners;
    this.#mintByAccountIndex = mints;

    this.nodes = buildInstructionTree(raw, this.#accountKeys);
  }

  static from(raw: RawTransaction): TxContext {
    return new TxContext(raw);
  }

  get accountKeys(): readonly string[] {
    return this.#accountKeys;
  }

  /** Resolved account key at `index`, or null when the index is out of range. */
  accountAt(index: number): string | null {
    return this.#accountKeys[index] ?? null;
  }

  /**
   * Decimals for `mint`, read from the transaction's own token balances.
   *
   * Returns null when the mint has no balance entry — which happens when the
   * only account touched was created in the same transaction. The pipeline
   * falls back to its cache and then to RPC rather than assuming a value.
   */
  decimalsFor(mint: string): number | null {
    return this.#decimalsByMint.get(mint) ?? null;
  }

  /** Every mint this transaction touched, from its token balance entries. */
  mints(): readonly string[] {
    return [...this.#decimalsByMint.keys()];
  }

  /** Wallet that owns the token account at `index`, when the source recorded it. */
  ownerOfTokenAccount(index: number): string | null {
    return this.#ownerByAccountIndex.get(index) ?? null;
  }

  /** Mint held by the token account at `index`, when the source recorded it. */
  mintOfTokenAccount(index: number): string | null {
    return this.#mintByAccountIndex.get(index) ?? null;
  }

  /** All nodes invoking `programId`, top-level and CPI alike, in execution order. */
  nodesForProgram(programId: string): InstructionNode[] {
    return this.nodes.filter((node) => node.programId === programId);
  }
}

/**
 * Rebuilds the invocation tree from the flat inner-instruction list.
 *
 * The runtime emits inner instructions in execution order, tagged with the
 * depth they ran at. A node at height `h` is a child of the most recent node
 * at height `h - 1`; that is the whole algorithm.
 *
 * Validators before v1.14.6 omit `stackHeight`. There, every inner instruction
 * is attributed to its top-level parent — flatter than reality, but never
 * wrong about *which* top-level instruction it belongs to.
 */
function buildInstructionTree(
  raw: RawTransaction,
  accountKeys: readonly string[],
): readonly InstructionNode[] {
  const innerByIndex = new Map<number, readonly RawInstruction[]>();
  for (const group of raw.innerInstructions) {
    innerByIndex.set(group.index, group.instructions);
  }

  const all: InstructionNode[] = [];

  raw.instructions.forEach((instruction, ixIndex) => {
    const top = makeNode(instruction, accountKeys, ixIndex, -1, 1);
    all.push(top);

    // byHeight[h - 1] is the most recent node seen at depth h.
    const byHeight: MutableNode[] = [top];

    (innerByIndex.get(ixIndex) ?? []).forEach((inner, innerIxIndex) => {
      const height = Math.max(2, inner.stackHeight ?? 2);
      const node = makeNode(inner, accountKeys, ixIndex, innerIxIndex, height);

      // A jump of more than one level means the runtime skipped a depth, which
      // it cannot do; fall back to the deepest known ancestor.
      const parent = byHeight[height - 2] ?? byHeight[byHeight.length - 1] ?? top;
      parent.children.push(node);
      node.parent = parent;

      byHeight.length = height - 1;
      byHeight[height - 1] = node;
      all.push(node);
    });
  });

  return all;
}

function makeNode(
  instruction: RawInstruction,
  accountKeys: readonly string[],
  ixIndex: number,
  innerIxIndex: number,
  stackHeight: number,
): MutableNode {
  const programId = accountKeys[instruction.programIdIndex];
  if (programId === undefined) {
    throw new DataIntegrityError(
      `program id index ${instruction.programIdIndex} is outside the ${accountKeys.length}-key account list`,
      { context: { ixIndex, innerIxIndex, programIdIndex: instruction.programIdIndex } },
    );
  }

  // An out-of-range account index means the loaded-address tables did not
  // resolve. Keeping a placeholder rather than throwing lets unrelated
  // instructions in the same transaction still parse.
  const accounts = instruction.accountIndexes.map((index) => accountKeys[index] ?? '');

  return {
    programId,
    accounts,
    data: instruction.data,
    ixIndex,
    innerIxIndex,
    stackHeight,
    parent: null,
    children: [],
  };
}

/** Sums the raw balance change for `mint` across a wallet's token accounts. */
export function netTokenChange(
  pre: readonly RawTokenBalance[],
  post: readonly RawTokenBalance[],
  mint: string,
  owner: string,
): bigint {
  const sum = (balances: readonly RawTokenBalance[]): bigint =>
    balances
      .filter((b) => b.mint === mint && b.owner === owner)
      .reduce((total, b) => total + b.amount, 0n);
  return sum(post) - sum(pre);
}
