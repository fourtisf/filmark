import type { ParsedSwap, Venue } from '@exitliquidity/core';
import type { InstructionNode, TxContext } from '@exitliquidity/solana';

/**
 * Why a venue instruction produced no row.
 *
 * These are counted, not thrown. A single undecodable instruction must never
 * stall the stream, but a rising `event_missing` count is the difference
 * between "quiet market" and "we shipped a broken parser", so it has to be
 * visible.
 */
export type ParseSkipReason =
  /** Discriminator did not match a swap instruction we handle. */
  | 'not_a_swap'
  /** No matching Anchor event under the invocation. */
  | 'event_missing'
  /** The event body was shorter than its known layout. */
  | 'event_truncated'
  /** Required accounts were absent or unresolvable. */
  | 'accounts_missing'
  /** Could not work out which side of the pair is the traded asset. */
  | 'pair_unresolved'
  /** Amounts were zero or otherwise not a real trade. */
  | 'empty_trade';

export interface ParseSkip {
  readonly venue: Venue;
  readonly reason: ParseSkipReason;
  readonly signature: string;
  readonly ixIndex: number;
  readonly innerIxIndex: number;
  readonly detail?: string;
}

export interface ParseResult {
  readonly swaps: readonly ParsedSwap[];
  readonly skipped: readonly ParseSkip[];
}

export interface SwapParser {
  readonly venue: Venue;
  readonly programId: string;
  /** Called once per transaction; returns every swap the venue executed in it. */
  parse(ctx: TxContext): ParseResult;
}

export const EMPTY_RESULT: ParseResult = Object.freeze({
  swaps: Object.freeze([]),
  skipped: Object.freeze([]),
});

export function skip(
  venue: Venue,
  reason: ParseSkipReason,
  ctx: TxContext,
  node: InstructionNode,
  detail?: string,
): ParseSkip {
  return {
    venue,
    reason,
    signature: ctx.signature,
    ixIndex: node.ixIndex,
    innerIxIndex: node.innerIxIndex,
    ...(detail === undefined ? {} : { detail }),
  };
}
