import { UpstreamError, nowSeconds, retry, type Venue } from '@exitliquidity/core';
import type { SwapCountBreakdown, SwapRepository } from '@exitliquidity/clickhouse';

/**
 * The P0 acceptance check: our swap count for a token against Dexscreener's,
 * within 2%.
 *
 * Two caveats, both reported rather than hidden, because a comparison that
 * quietly measures different things is worse than no comparison:
 *
 *   Dexscreener counts *transactions*, we count *swap instructions*. A router
 *   that fills one order across three pump.fun calls is one transaction and
 *   three swaps. The default comparison therefore uses our distinct-signature
 *   count, and the instruction count is printed beside it.
 *
 *   Dexscreener's h24 is a rolling window ending at its own last update, not
 *   ours. Near the boundary a small difference is expected, and is exactly why
 *   the tolerance is 2% rather than zero.
 */

export const DEXSCREENER_API = 'https://api.dexscreener.com';

/** Dexscreener's ids for the two P0 venues. */
export const VENUE_DEX_IDS: Readonly<Record<Venue, string>> = {
  pumpfun: 'pumpfun',
  pumpswap: 'pumpswap',
};

export interface DexscreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  txns?: Record<string, { buys: number; sells: number } | undefined>;
  volume?: Record<string, number | undefined>;
}

export interface DexscreenerSnapshot {
  readonly pairs: readonly DexscreenerPair[];
  readonly matchedPairs: readonly DexscreenerPair[];
  readonly buys: number;
  readonly sells: number;
  readonly transactions: number;
  readonly volumeUsd: number | null;
}

export interface VerifySwapCountOptions {
  readonly mint: string;
  readonly repository: SwapRepository;
  /** Comparison window, in hours. Must be one Dexscreener publishes. */
  readonly windowHours?: 1 | 6 | 24;
  /** Fractional tolerance. Spec §6 P0 sets this at 2%. */
  readonly tolerance?: number;
  readonly fetchImpl?: typeof fetch;
  readonly apiBase?: string;
  readonly signal?: AbortSignal;
}

export interface VerifyReport {
  readonly mint: string;
  readonly windowHours: number;
  readonly fromSec: number;
  readonly toSec: number;
  readonly ours: SwapCountBreakdown;
  readonly dexscreener: DexscreenerSnapshot;
  /** Signed relative difference of transaction counts: positive means we have more. */
  readonly deltaRatio: number | null;
  readonly tolerance: number;
  readonly withinTolerance: boolean;
  readonly skips: readonly { venue: string; reason: string; count: number }[];
  readonly notes: readonly string[];
}

const WINDOW_KEYS: Record<number, string> = { 1: 'h1', 6: 'h6', 24: 'h24' };

export async function verifySwapCount(options: VerifySwapCountOptions): Promise<VerifyReport> {
  const windowHours = options.windowHours ?? 24;
  const tolerance = options.tolerance ?? 0.02;
  const toSec = nowSeconds();
  const fromSec = toSec - windowHours * 3600;

  const [ours, dexscreener, skips] = await Promise.all([
    options.repository.countByMint({ mint: options.mint, fromSec, toSec }),
    fetchDexscreener(options.mint, windowHours, options),
    options.repository.skipSummary(fromSec, toSec).catch(() => []),
  ]);

  const notes: string[] = [];
  if (dexscreener.matchedPairs.length === 0) {
    notes.push(
      'Dexscreener lists no pump.fun or PumpSwap pair for this mint; there is nothing to compare against.',
    );
  }
  if (ours.unpriced > 0) {
    notes.push(
      `${ours.unpriced} of ${ours.swaps} swaps have no USD price. Counts are unaffected; volume figures would be.`,
    );
  }
  if (skips.length > 0) {
    notes.push(
      `${skips.reduce((sum, s) => sum + s.count, 0)} venue instructions were skipped in this window; see ingest_skips.`,
    );
  }
  if (ours.swaps !== ours.transactions) {
    notes.push(
      `${ours.swaps} swap instructions across ${ours.transactions} transactions. Dexscreener counts transactions.`,
    );
  }

  const deltaRatio =
    dexscreener.transactions === 0
      ? null
      : (ours.transactions - dexscreener.transactions) / dexscreener.transactions;

  return {
    mint: options.mint,
    windowHours,
    fromSec,
    toSec,
    ours,
    dexscreener,
    deltaRatio,
    tolerance,
    withinTolerance: deltaRatio !== null && Math.abs(deltaRatio) <= tolerance,
    skips,
    notes,
  };
}

async function fetchDexscreener(
  mint: string,
  windowHours: number,
  options: VerifySwapCountOptions,
): Promise<DexscreenerSnapshot> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.apiBase ?? DEXSCREENER_API;
  const url = new URL(`/latest/dex/tokens/${encodeURIComponent(mint)}`, base);

  const body = await retry(
    async () => {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) {
        throw new UpstreamError(`Dexscreener returned HTTP ${response.status}`, {
          context: { status: response.status, mint },
        });
      }
      return (await response.json()) as { pairs?: DexscreenerPair[] | null };
    },
    {
      maxAttempts: 3,
      minMs: 500,
      maxMs: 4000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      shouldRetry: () => true,
    },
  );

  const pairs = body.pairs ?? [];
  const venueIds = new Set(Object.values(VENUE_DEX_IDS));
  const matchedPairs = pairs.filter(
    (pair) => pair.chainId === 'solana' && venueIds.has(pair.dexId),
  );

  const key = WINDOW_KEYS[windowHours] ?? 'h24';
  let buys = 0;
  let sells = 0;
  let volumeUsd = 0;
  let sawVolume = false;

  for (const pair of matchedPairs) {
    const txns = pair.txns?.[key];
    buys += txns?.buys ?? 0;
    sells += txns?.sells ?? 0;
    const volume = pair.volume?.[key];
    if (typeof volume === 'number') {
      volumeUsd += volume;
      sawVolume = true;
    }
  }

  return {
    pairs,
    matchedPairs,
    buys,
    sells,
    transactions: buys + sells,
    volumeUsd: sawVolume ? volumeUsd : null,
  };
}

/** Renders a report for a terminal. */
export function formatVerifyReport(report: VerifyReport): string {
  const pct = (value: number | null): string =>
    value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

  const lines = [
    `mint                ${report.mint}`,
    `window              last ${report.windowHours}h`,
    '',
    `ours (transactions) ${report.ours.transactions}`,
    `ours (swap ixs)     ${report.ours.swaps}  (${report.ours.buys} buy / ${report.ours.sells} sell)`,
    `  by venue          ${formatVenues(report.ours.byVenue)}`,
    `  unpriced          ${report.ours.unpriced}`,
    '',
    `dexscreener         ${report.dexscreener.transactions}  (${report.dexscreener.buys} buy / ${report.dexscreener.sells} sell)`,
    `  pairs matched     ${report.dexscreener.matchedPairs.length} of ${report.dexscreener.pairs.length}`,
    '',
    `delta               ${pct(report.deltaRatio)}   tolerance ${pct(report.tolerance)}`,
    `result              ${report.withinTolerance ? 'PASS' : 'FAIL'}`,
  ];

  if (report.skips.length > 0) {
    lines.push('', 'parse skips in window');
    for (const skip of report.skips) {
      lines.push(`  ${skip.venue.padEnd(10)} ${skip.reason.padEnd(18)} ${skip.count}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('', 'notes');
    for (const note of report.notes) lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}

function formatVenues(byVenue: Readonly<Record<string, number>>): string {
  const entries = Object.entries(byVenue);
  return entries.length === 0 ? '(none)' : entries.map(([k, v]) => `${k}=${v}`).join(' ');
}
