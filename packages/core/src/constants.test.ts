import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_CPI_EVENT_TAG,
  PUMPSWAP_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID,
  QUOTE_ASSETS,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
  isQuoteAsset,
  quoteAsset,
} from './constants.js';

const ADDRESSES: Record<string, string> = {
  PUMP_FUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
};

describe('on-chain addresses', () => {
  it.each(Object.entries(ADDRESSES))('%s decodes to a 32-byte pubkey', (_name, address) => {
    expect(bs58.decode(address)).toHaveLength(32);
  });

  it('has no duplicate addresses', () => {
    const values = Object.values(ADDRESSES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('ANCHOR_CPI_EVENT_TAG', () => {
  it('is sha256("anchor:event")[..8] written little-endian', () => {
    // Anchor stores the tag as a u64 and serialises it LE, so the wire bytes
    // are the reverse of the digest prefix. Getting this backwards silently
    // matches nothing, so it is pinned rather than trusted.
    const digestPrefix = createHash('sha256').update('anchor:event').digest().subarray(0, 8);
    const expected = Uint8Array.from([...digestPrefix].reverse());

    expect(Array.from(ANCHOR_CPI_EVENT_TAG)).toEqual(Array.from(expected));
    expect(Buffer.from(ANCHOR_CPI_EVENT_TAG).toString('hex')).toBe('e445a52e51cb9a1d');
  });
});

describe('quote assets', () => {
  it('prices SOL from the series and stablecoins at their peg', () => {
    expect(quoteAsset(WSOL_MINT)?.usdPerUnit).toBeNull();
    expect(quoteAsset(USDC_MINT)?.usdPerUnit).toBe(1);
    expect(quoteAsset(USDT_MINT)?.usdPerUnit).toBe(1);
  });

  it('reports unknown mints as unpriceable rather than guessing', () => {
    expect(isQuoteAsset('9mQrDdCcanPjSNCa2iGqoPRfCmcgJcnRRbaMhg2Vpump')).toBe(false);
    expect(quoteAsset('9mQrDdCcanPjSNCa2iGqoPRfCmcgJcnRRbaMhg2Vpump')).toBeNull();
  });

  it('keys every entry by its own mint', () => {
    for (const [key, asset] of Object.entries(QUOTE_ASSETS)) {
      expect(asset.mint).toBe(key);
    }
  });
});
