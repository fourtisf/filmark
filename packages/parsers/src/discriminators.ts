/**
 * Anchor discriminators for the two P0 venues.
 *
 * Every value here is `sha256(preimage)[..8]` — instructions use
 * `global:<snake_case_name>`, events use `event:<TypeName>`. They are written
 * out as literals so the hot path does no hashing, and `discriminators.test.ts`
 * recomputes each one from its preimage so a typo cannot survive a test run.
 */

export interface Discriminator {
  readonly preimage: string;
  readonly bytes: Uint8Array;
}

function d(preimage: string, bytes: number[]): Discriminator {
  return Object.freeze({ preimage, bytes: Uint8Array.from(bytes) });
}

/**
 * `buy` and `sell` share their discriminators across both programs, because
 * both are Anchor programs with identically named instructions. The program id
 * is what tells them apart — never the discriminator alone.
 */
export const IX_BUY = d('global:buy', [102, 6, 61, 18, 1, 218, 235, 234]);
export const IX_SELL = d('global:sell', [51, 230, 133, 164, 1, 127, 131, 173]);

/** Pump.fun bonding curve trade event. Emitted once per buy/sell invocation. */
export const EVENT_TRADE = d('event:TradeEvent', [189, 219, 127, 211, 78, 230, 97, 238]);

/** PumpSwap emits a distinct event type per direction. */
export const EVENT_PUMPSWAP_BUY = d('event:BuyEvent', [103, 244, 82, 31, 44, 245, 119, 119]);
export const EVENT_PUMPSWAP_SELL = d('event:SellEvent', [62, 47, 55, 10, 165, 3, 220, 42]);

export const ALL_DISCRIMINATORS: readonly Discriminator[] = [
  IX_BUY,
  IX_SELL,
  EVENT_TRADE,
  EVENT_PUMPSWAP_BUY,
  EVENT_PUMPSWAP_SELL,
];
