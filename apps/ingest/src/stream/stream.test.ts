import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { ConfigError, PUMPSWAP_PROGRAM_ID, PUMP_FUN_PROGRAM_ID } from '@exitliquidity/core';
import { describe, expect, it } from 'vitest';
import { BlockTimeCache } from './block-times.js';
import {
  BLOCKS_META_FILTER,
  TRANSACTIONS_FILTER,
  buildSubscribeRequest,
  toCommitmentLevel,
} from './subscription.js';

describe('BlockTimeCache', () => {
  it('stores and returns a block time by slot', () => {
    const cache = new BlockTimeCache();
    cache.set(100n, 1_735_689_600);

    expect(cache.get(100n)).toBe(1_735_689_600);
    expect(cache.get(101n)).toBeNull();
  });

  it('evicts the oldest slot once full, so a long run does not leak', () => {
    const cache = new BlockTimeCache(2);
    cache.set(1n, 10);
    cache.set(2n, 20);
    cache.set(3n, 30);

    expect(cache.size).toBe(2);
    expect(cache.get(1n)).toBeNull();
    expect(cache.get(3n)).toBe(30);
  });

  it('updating an existing slot does not evict anything', () => {
    const cache = new BlockTimeCache(2);
    cache.set(1n, 10);
    cache.set(2n, 20);
    cache.set(2n, 21);

    expect(cache.size).toBe(2);
    expect(cache.get(1n)).toBe(10);
    expect(cache.get(2n)).toBe(21);
  });

  it('rejects a nonsensical capacity', () => {
    expect(() => new BlockTimeCache(0)).toThrow(RangeError);
  });
});

describe('buildSubscribeRequest', () => {
  const request = buildSubscribeRequest({
    programIds: [PUMP_FUN_PROGRAM_ID, PUMPSWAP_PROGRAM_ID],
    commitment: 'confirmed',
  });

  it('matches transactions touching any venue program, including routed ones', () => {
    // accountInclude, not a top-level program filter: a large share of
    // pump.fun volume arrives through aggregators as an inner instruction.
    expect(request.transactions[TRANSACTIONS_FILTER]?.accountInclude).toEqual([
      PUMP_FUN_PROGRAM_ID,
      PUMPSWAP_PROGRAM_ID,
    ]);
  });

  it('excludes votes and failed transactions at the server', () => {
    expect(request.transactions[TRANSACTIONS_FILTER]).toMatchObject({ vote: false, failed: false });
  });

  it('subscribes to block meta for authoritative block times', () => {
    expect(request.blocksMeta).toHaveProperty(BLOCKS_META_FILTER);
  });

  it('maps commitment names onto the protocol enum', () => {
    expect(request.commitment).toBe(CommitmentLevel.CONFIRMED);
    expect(toCommitmentLevel('processed')).toBe(CommitmentLevel.PROCESSED);
    expect(toCommitmentLevel('finalized')).toBe(CommitmentLevel.FINALIZED);
  });

  it('omits fromSlot unless a resume point was given', () => {
    expect(request.fromSlot).toBeUndefined();
    expect(
      buildSubscribeRequest({
        programIds: [PUMP_FUN_PROGRAM_ID],
        commitment: 'confirmed',
        fromSlot: 250_000_000n,
      }).fromSlot,
    ).toBe('250000000');
  });

  it('refuses a subscription that would match nothing', () => {
    expect(() => buildSubscribeRequest({ programIds: [], commitment: 'confirmed' })).toThrow(
      ConfigError,
    );
  });
});
