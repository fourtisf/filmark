/**
 * On-chain constants.
 *
 * Every program id and mint below decodes to a 32-byte base58 pubkey; that is
 * asserted in `constants.test.ts` rather than assumed, because a typo here is
 * silent — the stream simply never matches and the swap table stays empty.
 */

/** Pump.fun bonding curve program. */
export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** PumpSwap, the constant-product AMM pump.fun tokens migrate into. */
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

/**
 * Every pump.fun bonding curve token is minted with 6 decimals by the program
 * itself, so the value is safe as a fallback when a transaction carries no
 * token balance entry for the mint (which happens when the buyer's ATA is
 * created inside the same transaction).
 */
export const PUMP_FUN_TOKEN_DECIMALS = 6;

/**
 * Mints we can price without touching a pool.
 *
 * `usdPerUnit` of `null` means "look it up in the SOL/USD series"; a number
 * means the asset is treated as a hard peg. Nothing else is priceable in P0 —
 * spec §2 Stage 1 forbids reading a price off the pool, so an unlisted quote
 * asset produces `usd_value = NULL` rather than a guess.
 */
export const QUOTE_ASSETS: Readonly<Record<string, QuoteAsset>> = Object.freeze({
  [WSOL_MINT]: { mint: WSOL_MINT, symbol: 'SOL', decimals: SOL_DECIMALS, usdPerUnit: null },
  [USDC_MINT]: { mint: USDC_MINT, symbol: 'USDC', decimals: USDC_DECIMALS, usdPerUnit: 1 },
  [USDT_MINT]: { mint: USDT_MINT, symbol: 'USDT', decimals: USDC_DECIMALS, usdPerUnit: 1 },
});

export interface QuoteAsset {
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
  /** `null` => priced from the SOL/USD series; number => hard peg. */
  readonly usdPerUnit: number | null;
}

export function isQuoteAsset(mint: string): boolean {
  return Object.hasOwn(QUOTE_ASSETS, mint);
}

export function quoteAsset(mint: string): QuoteAsset | null {
  return QUOTE_ASSETS[mint] ?? null;
}

/**
 * Anchor's `emit_cpi!` wrapper tag: the u64 `sha256("anchor:event")[..8]`
 * written little-endian, hence the byte order here is the reverse of the raw
 * digest prefix. Every Anchor event arrives as a self-CPI whose data starts
 * with these 8 bytes, followed by the 8-byte event discriminator.
 */
export const ANCHOR_CPI_EVENT_TAG: Uint8Array = new Uint8Array([
  0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d,
]);

/** Anchor discriminators are 8 bytes, for both instructions and events. */
export const DISCRIMINATOR_LENGTH = 8;

/** Solana's target block time. Only used to bound estimates, never to stamp a row. */
export const APPROX_SLOT_MS = 400;
