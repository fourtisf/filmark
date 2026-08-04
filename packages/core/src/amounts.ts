/**
 * Raw-unit arithmetic.
 *
 * Token amounts stay `bigint` end to end. They only become `number` at the
 * moment a USD figure is produced, and that conversion is done here so the
 * rounding rule lives in exactly one place.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Converts a raw token amount into a float scaled by `decimals`.
 *
 * Splits into integer and fractional parts before touching floating point, so
 * a large `bigint` does not lose its low digits on the way through `Number`.
 */
export function rawToNumber(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new RangeError(`decimals out of range: ${decimals}`);
  }
  if (decimals === 0) return Number(raw);

  const scale = 10n ** BigInt(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / scale;
  const fraction = abs % scale;

  const value = Number(whole) + Number(fraction) / Number(scale);
  return negative ? -value : value;
}

/** True when `raw` survives a trip through `Number` without losing precision. */
export function fitsInSafeInteger(raw: bigint): boolean {
  return raw <= MAX_SAFE && raw >= -MAX_SAFE;
}

/**
 * USD value of a quote leg: raw amount, scaled by decimals, times unit price.
 *
 * Returns null for a non-finite result rather than writing `NaN` or `Infinity`
 * into the column — a missing number is recoverable, a poisoned one is not.
 */
export function quoteToUsd(raw: bigint, decimals: number, usdPerUnit: number): number | null {
  if (!Number.isFinite(usdPerUnit) || usdPerUnit < 0) return null;
  const units = rawToNumber(raw, decimals);
  const usd = units * usdPerUnit;
  return Number.isFinite(usd) ? usd : null;
}

/**
 * Parses a decimal string into raw units without floating point.
 *
 * Used for RPC payloads that hand back `"1.234"` style amounts. Extra fraction
 * digits beyond `decimals` are truncated, matching on-chain behaviour.
 */
export function decimalStringToRaw(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) throw new SyntaxError(`not a decimal number: ${value}`);

  const [, sign = '', whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') throw new SyntaxError(`not a decimal number: ${value}`);

  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const raw = BigInt((whole === '' ? '0' : whole) + padded);
  return sign === '-' ? -raw : raw;
}

/** Parses an unsigned integer string into a bigint, rejecting anything else. */
export function parseUnsignedBigInt(value: string, label: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw new SyntaxError(`${label} is not an unsigned integer: ${value}`);
  }
  return BigInt(value.trim());
}
