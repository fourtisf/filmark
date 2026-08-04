import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ALL_DISCRIMINATORS } from './discriminators.js';

describe('anchor discriminators', () => {
  it.each(ALL_DISCRIMINATORS.map((disc) => [disc.preimage, disc] as const))(
    '%s matches sha256(preimage)[..8]',
    (_preimage, disc) => {
      const expected = createHash('sha256').update(disc.preimage).digest().subarray(0, 8);
      expect(Buffer.from(disc.bytes).toString('hex')).toBe(expected.toString('hex'));
    },
  );

  it('gives every discriminator eight bytes', () => {
    for (const disc of ALL_DISCRIMINATORS) {
      expect(disc.bytes).toHaveLength(8);
    }
  });

  it('keeps event discriminators distinct from each other', () => {
    const hex = ALL_DISCRIMINATORS.map((disc) => Buffer.from(disc.bytes).toString('hex'));
    expect(new Set(hex).size).toBe(hex.length);
  });
});
