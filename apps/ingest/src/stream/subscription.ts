import { CommitmentLevel, type SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { ConfigError } from '@exitliquidity/core';

export const TRANSACTIONS_FILTER = 'venue_swaps';
export const BLOCKS_META_FILTER = 'block_times';
export const SLOTS_FILTER = 'slots';

export type CommitmentName = 'processed' | 'confirmed' | 'finalized';

export function toCommitmentLevel(name: CommitmentName): CommitmentLevel {
  switch (name) {
    case 'processed':
      return CommitmentLevel.PROCESSED;
    case 'confirmed':
      return CommitmentLevel.CONFIRMED;
    case 'finalized':
      return CommitmentLevel.FINALIZED;
    default: {
      throw new ConfigError(`unknown commitment level: ${String(name)}`);
    }
  }
}

export interface SubscriptionOptions {
  readonly programIds: readonly string[];
  readonly commitment: CommitmentName;
  /** Replay from this slot after a reconnect, when the provider supports it. */
  readonly fromSlot?: bigint;
}

/**
 * Builds the subscription.
 *
 * `accountInclude` matches transactions that touch any of the venue programs,
 * which covers both a direct call and one routed through an aggregator — the
 * latter is a large share of pump.fun volume and filtering on the top-level
 * program alone would miss all of it.
 *
 * Votes and failed transactions are excluded at the server. Roughly three
 * quarters of mainnet traffic is votes, and a failed transaction moved no
 * tokens, so neither is worth the bandwidth.
 *
 * `blocksMeta` is subscribed for authoritative block times. Both P0 venues
 * stamp their events from the same on-chain clock, so this is a cross-check
 * today rather than the only source — but a venue whose events carry no
 * timestamp would depend on it entirely.
 */
export function buildSubscribeRequest(options: SubscriptionOptions): SubscribeRequest {
  if (options.programIds.length === 0) {
    throw new ConfigError('a subscription needs at least one program id');
  }

  return {
    accounts: {},
    slots: { [SLOTS_FILTER]: { filterByCommitment: true } },
    transactions: {
      [TRANSACTIONS_FILTER]: {
        vote: false,
        failed: false,
        accountInclude: [...options.programIds],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: { [BLOCKS_META_FILTER]: {} },
    entry: {},
    commitment: toCommitmentLevel(options.commitment),
    accountsDataSlice: [],
    ...(options.fromSlot === undefined ? {} : { fromSlot: options.fromSlot.toString() }),
  };
}
