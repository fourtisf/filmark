export const SECONDS_PER_MINUTE = 60;

/** Floors a unix-seconds timestamp to its minute bucket. */
export function floorToMinute(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
}

/** Every minute boundary in `[fromSec, toSec]`, inclusive of both ends' buckets. */
export function minuteRange(fromSec: number, toSec: number): number[] {
  if (toSec < fromSec) throw new RangeError('toSec must be >= fromSec');
  const out: number[] = [];
  for (let t = floorToMinute(fromSec); t <= floorToMinute(toSec); t += SECONDS_PER_MINUTE) {
    out.push(t);
  }
  return out;
}

/**
 * ClickHouse's `DateTime` text format. UTC always — the swap table has no
 * business carrying a local timezone.
 */
export function toClickHouseDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Inverse of `toClickHouseDateTime`. */
export function fromClickHouseDateTime(value: string): number {
  const iso = `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new SyntaxError(`unparseable ClickHouse DateTime: ${value}`);
  return Math.floor(ms / 1000);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 2020-01-01 and 2100-01-01. Solana mainnet sits comfortably inside both. */
const MIN_PLAUSIBLE_BLOCK_TIME = 1_577_836_800;
const MAX_PLAUSIBLE_BLOCK_TIME = 4_102_444_800;

/**
 * Accepts a timestamp only if it could plausibly be a Solana block time.
 *
 * On-chain events carry their own clock reading, which is a good fallback when
 * the stream has not yet joined a block time in — but if a program's event
 * layout shifts, the field being read may not be a timestamp at all. Anything
 * implausible becomes null rather than a row dated 1970.
 */
export function sanitiseBlockTime(timestamp: bigint | number): number | null {
  const seconds = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
  if (!Number.isSafeInteger(seconds)) return null;
  if (seconds < MIN_PLAUSIBLE_BLOCK_TIME || seconds > MAX_PLAUSIBLE_BLOCK_TIME) return null;
  return seconds;
}

export function daysToSeconds(days: number): number {
  return Math.round(days * 24 * 60 * 60);
}
