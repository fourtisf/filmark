import { DataIntegrityError } from '@exitliquidity/core';
import { describe, expect, it } from 'vitest';
import { TxContext } from './context.js';
import type { RawInstruction, RawTransaction } from './types.js';

const KEYS = ['prog0', 'prog1', 'acc0', 'acc1', 'acc2'];

function ix(programIdIndex: number, stackHeight?: number, accounts: number[] = []): RawInstruction {
  return { programIdIndex, accountIndexes: accounts, data: Uint8Array.of(1), stackHeight };
}

function tx(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    signature: 'sig',
    slot: 1n,
    blockTime: 100,
    isVote: false,
    failed: false,
    accountKeys: KEYS,
    loadedWritableAddresses: [],
    loadedReadonlyAddresses: [],
    instructions: [],
    innerInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    logMessages: [],
    ...overrides,
  };
}

describe('TxContext account resolution', () => {
  it('appends loaded addresses after the static keys, writable first', () => {
    // The runtime concatenates in this exact order. Any other order shifts
    // every account index in a versioned transaction.
    const ctx = TxContext.from(
      tx({
        accountKeys: ['static0', 'static1'],
        loadedWritableAddresses: ['writable0'],
        loadedReadonlyAddresses: ['readonly0'],
      }),
    );

    expect(ctx.accountKeys).toEqual(['static0', 'static1', 'writable0', 'readonly0']);
    expect(ctx.accountAt(2)).toBe('writable0');
    expect(ctx.accountAt(3)).toBe('readonly0');
    expect(ctx.accountAt(4)).toBeNull();
  });

  it('rejects a transaction whose program id index is out of range', () => {
    expect(() => TxContext.from(tx({ instructions: [ix(99)] }))).toThrow(DataIntegrityError);
  });

  it('keeps a placeholder for an account index that did not resolve', () => {
    // One unresolvable account must not stop the rest of the transaction from
    // parsing, so it becomes an empty string that callers can test for.
    const ctx = TxContext.from(tx({ instructions: [ix(0, 1, [2, 99])] }));
    expect(ctx.nodes[0]?.accounts).toEqual(['acc0', '']);
  });
});

describe('TxContext instruction tree', () => {
  it('nests inner instructions by stack height', () => {
    const ctx = TxContext.from(
      tx({
        instructions: [ix(0)],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              ix(1, 2), // child of the top level
              ix(1, 3), // child of the previous one
              ix(1, 2), // back up a level: sibling of the first
            ],
          },
        ],
      }),
    );

    const [top, first, grandchild, second] = ctx.nodes;
    expect(ctx.nodes).toHaveLength(4);
    expect(top?.parent).toBeNull();
    expect(top?.children).toHaveLength(2);
    expect(first?.parent).toBe(top);
    expect(grandchild?.parent).toBe(first);
    expect(second?.parent).toBe(top);
    expect(first?.children).toEqual([grandchild]);
  });

  it('indexes each node by its top-level instruction and inner position', () => {
    const ctx = TxContext.from(
      tx({
        instructions: [ix(0), ix(0)],
        innerInstructions: [{ index: 1, instructions: [ix(1, 2), ix(1, 2)] }],
      }),
    );

    expect(ctx.nodes.map((n) => [n.ixIndex, n.innerIxIndex])).toEqual([
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
    ]);
  });

  it('attributes inner instructions to their top-level parent when stack height is absent', () => {
    // Validators before v1.14.6 omit stackHeight. The tree is flatter than
    // reality, but never attributes an instruction to the wrong transaction
    // slot, which is what the parsers actually depend on.
    const ctx = TxContext.from(
      tx({
        instructions: [ix(0)],
        innerInstructions: [{ index: 0, instructions: [ix(1), ix(1)] }],
      }),
    );

    expect(ctx.nodes[0]?.children).toHaveLength(2);
    expect(ctx.nodes[1]?.stackHeight).toBe(2);
    expect(ctx.nodes[2]?.parent).toBe(ctx.nodes[0]);
  });

  it('reattaches a node whose depth jumps more than one level', () => {
    // The runtime cannot skip a depth, so this is corrupt input. It must not
    // produce an orphan node or throw.
    const ctx = TxContext.from(
      tx({
        instructions: [ix(0)],
        innerInstructions: [{ index: 0, instructions: [ix(1, 2), ix(1, 5)] }],
      }),
    );

    expect(ctx.nodes).toHaveLength(3);
    expect(ctx.nodes[2]?.parent).toBe(ctx.nodes[1]);
  });

  it('finds every invocation of a program, top-level and nested alike', () => {
    const ctx = TxContext.from(
      tx({
        instructions: [ix(1), ix(0)],
        innerInstructions: [{ index: 1, instructions: [ix(1, 2)] }],
      }),
    );

    expect(ctx.nodesForProgram('prog1')).toHaveLength(2);
    expect(ctx.nodesForProgram('prog0')).toHaveLength(1);
  });
});

describe('TxContext token balances', () => {
  const withBalances = tx({
    preTokenBalances: [
      { accountIndex: 2, mint: 'mintA', owner: 'walletA', decimals: 6, amount: 10n },
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: 'mintA', owner: 'walletA', decimals: 6, amount: 30n },
      { accountIndex: 3, mint: 'mintB', owner: null, decimals: 9, amount: 5n },
    ],
  });

  it('exposes decimals, owners and mints keyed the way parsers ask for them', () => {
    const ctx = TxContext.from(withBalances);

    expect(ctx.decimalsFor('mintA')).toBe(6);
    expect(ctx.decimalsFor('mintB')).toBe(9);
    expect(ctx.ownerOfTokenAccount(2)).toBe('walletA');
    expect(ctx.ownerOfTokenAccount(3)).toBeNull();
    expect(ctx.mintOfTokenAccount(3)).toBe('mintB');
    expect(ctx.mints().sort()).toEqual(['mintA', 'mintB']);
  });

  it('reports an unknown mint as unknown rather than guessing a default', () => {
    expect(TxContext.from(withBalances).decimalsFor('mintC')).toBeNull();
  });
});
