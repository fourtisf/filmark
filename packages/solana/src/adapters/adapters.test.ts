import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { fromRpcTransaction, type RpcTransactionResponse } from './rpc.js';
import { fromYellowstoneTransaction, type YellowstoneTransactionInfo } from './yellowstone.js';

const PUBKEY_A = new Uint8Array(32).fill(1);
const PUBKEY_B = new Uint8Array(32).fill(2);
const SIGNATURE = new Uint8Array(64).fill(3);

function yellowstoneInfo(
  overrides: Partial<YellowstoneTransactionInfo> = {},
): YellowstoneTransactionInfo {
  return {
    signature: SIGNATURE,
    isVote: false,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [PUBKEY_A, PUBKEY_B],
        instructions: [{ programIdIndex: 0, accounts: Uint8Array.of(1), data: Uint8Array.of(9) }],
      },
    },
    meta: {
      err: undefined,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 1,
              accounts: Uint8Array.of(0),
              data: Uint8Array.of(8),
              stackHeight: 2,
            },
          ],
        },
      ],
      logMessages: ['Program log: hi'],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: 'mintA',
          owner: 'ownerA',
          uiTokenAmount: { amount: '1234', decimals: 6 },
        },
      ],
      loadedWritableAddresses: [PUBKEY_B],
      loadedReadonlyAddresses: [],
    },
    ...overrides,
  };
}

describe('fromYellowstoneTransaction', () => {
  it('base58-encodes signatures and account keys and keeps instruction bytes raw', () => {
    const raw = fromYellowstoneTransaction(yellowstoneInfo(), '250000000', { blockTime: 1700 });

    expect(raw.signature).toBe(bs58.encode(SIGNATURE));
    expect(raw.accountKeys).toEqual([bs58.encode(PUBKEY_A), bs58.encode(PUBKEY_B)]);
    expect(raw.loadedWritableAddresses).toEqual([bs58.encode(PUBKEY_B)]);
    expect(raw.instructions[0]?.data).toEqual(Uint8Array.of(9));
    expect(raw.instructions[0]?.accountIndexes).toEqual([1]);
  });

  it('parses the slot string into a bigint and takes block time from the caller', () => {
    // Yellowstone transaction updates carry no block time; it is joined in from
    // the block-meta stream, so the adapter must not invent one.
    const raw = fromYellowstoneTransaction(yellowstoneInfo(), '250000000', { blockTime: null });

    expect(raw.slot).toBe(250_000_000n);
    expect(raw.blockTime).toBeNull();
  });

  it('preserves inner instruction stack heights', () => {
    const raw = fromYellowstoneTransaction(yellowstoneInfo(), '1', { blockTime: 1 });
    expect(raw.innerInstructions[0]?.instructions[0]?.stackHeight).toBe(2);
  });

  it('marks a transaction with an err as failed', () => {
    const info = yellowstoneInfo();
    const raw = fromYellowstoneTransaction(
      { ...info, meta: { ...info.meta!, err: { err: Uint8Array.of(1) } } },
      '1',
      { blockTime: 1 },
    );
    expect(raw.failed).toBe(true);
  });

  it('normalises an empty owner string to null', () => {
    const info = yellowstoneInfo();
    const raw = fromYellowstoneTransaction(
      {
        ...info,
        meta: {
          ...info.meta!,
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: 'mintA',
              owner: '',
              uiTokenAmount: { amount: '1', decimals: 6 },
            },
          ],
        },
      },
      '1',
      { blockTime: 1 },
    );
    expect(raw.postTokenBalances[0]?.owner).toBeNull();
  });

  it('throws when the update carries no message', () => {
    expect(() =>
      fromYellowstoneTransaction({ ...yellowstoneInfo(), transaction: undefined }, '1', {
        blockTime: 1,
      }),
    ).toThrow(/no message/);
  });
});

describe('fromRpcTransaction', () => {
  const response: RpcTransactionResponse = {
    slot: 250_000_001,
    blockTime: 1700,
    version: 0,
    transaction: {
      signatures: ['5' + 'a'.repeat(43)],
      message: {
        accountKeys: ['keyA', 'keyB'],
        instructions: [
          { programIdIndex: 0, accounts: [1], data: bs58.encode(Uint8Array.of(7, 7)) },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 1,
              accounts: [0],
              data: bs58.encode(Uint8Array.of(5)),
              stackHeight: 3,
            },
          ],
        },
      ],
      logMessages: ['log'],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: 'mintA',
          owner: 'ownerA',
          uiTokenAmount: { amount: '9', decimals: 9 },
        },
      ],
      loadedAddresses: { writable: ['lutW'], readonly: ['lutR'] },
    },
  };

  it('base58-decodes instruction data back to raw bytes', () => {
    const raw = fromRpcTransaction(response);
    expect(raw.instructions[0]?.data).toEqual(Uint8Array.of(7, 7));
    expect(raw.innerInstructions[0]?.instructions[0]?.data).toEqual(Uint8Array.of(5));
  });

  it('lifts loaded addresses out of meta so both sources look identical', () => {
    const raw = fromRpcTransaction(response);
    expect(raw.loadedWritableAddresses).toEqual(['lutW']);
    expect(raw.loadedReadonlyAddresses).toEqual(['lutR']);
  });

  it('carries the block time RPC supplies', () => {
    expect(fromRpcTransaction(response).blockTime).toBe(1700);
    expect(fromRpcTransaction({ ...response, blockTime: null }).blockTime).toBeNull();
  });

  it('tolerates a null meta', () => {
    const raw = fromRpcTransaction({ ...response, meta: null });
    expect(raw.failed).toBe(false);
    expect(raw.innerInstructions).toEqual([]);
    expect(raw.loadedWritableAddresses).toEqual([]);
  });
});
