import type { Venue } from '@exitliquidity/core';
import type { TxContext } from '@exitliquidity/solana';
import { pumpFunParser } from './pumpfun.js';
import { pumpSwapParser } from './pumpswap.js';
import type { ParseResult, ParseSkip, SwapParser } from './parser.js';

/**
 * Every parser P0 ships.
 *
 * Spec §2 Stage 1 sets the venue priority: pump.fun and PumpSwap first,
 * Raydium, Meteora and Orca as a parallel track once P1 is green. Adding one
 * is a matter of appending to this list.
 */
export const PARSERS: readonly SwapParser[] = Object.freeze([pumpFunParser, pumpSwapParser]);

/** Program ids worth subscribing to, derived from the registry rather than restated. */
export const PARSED_PROGRAM_IDS: readonly string[] = Object.freeze(
  PARSERS.map((parser) => parser.programId),
);

export function parserForVenue(venue: Venue): SwapParser | null {
  return PARSERS.find((parser) => parser.venue === venue) ?? null;
}

/**
 * Runs every parser over one transaction.
 *
 * A parser throwing is a bug, not a data problem, so it is contained here: one
 * broken venue must not stop the others from producing rows, and the failure
 * is returned as a skip so it shows up in metrics instead of in silence.
 */
export function parseTransaction(ctx: TxContext): ParseResult {
  const swaps = [];
  const skipped: ParseSkip[] = [];

  for (const parser of PARSERS) {
    try {
      const result = parser.parse(ctx);
      swaps.push(...result.swaps);
      skipped.push(...result.skipped);
    } catch (error) {
      skipped.push({
        venue: parser.venue,
        reason: 'not_a_swap',
        signature: ctx.signature,
        ixIndex: -1,
        innerIxIndex: -1,
        detail: `parser threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { swaps, skipped };
}
