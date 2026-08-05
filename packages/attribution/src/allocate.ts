import { isAttributable, type Position, type PositionBuyLeg } from '@exitliquidity/positions';
import type {
  AttributionResult,
  AttributionRow,
  CounterpartyTotal,
  NettedWindow,
} from './types.js';

/** A buy leg paired with the window it was netted against. */
export interface LegWindow {
  readonly leg: PositionBuyLeg;
  readonly window: NettedWindow;
}

/**
 * Spreads one closed losing position across the wallets that were selling into
 * its buy windows. Spec §2 Stage 4.
 *
 *     loss_share_b      = (A / total_cost_basis) × |realised_loss|
 *     attributed_loss_j = loss_share_b × share_j
 *
 * The scaling is what stops a big buy in a position that barely lost money from
 * reading as a big extraction: attribution follows the realised loss, never the
 * notional size of the trade.
 *
 * A position that is open, has an unknown basis, or made money returns nothing.
 * §7.3 and §2 Stage 2 both require that, and it is checked here rather than
 * assumed of the caller.
 */
export function allocatePosition(
  position: Position,
  legWindows: readonly LegWindow[],
): AttributionResult {
  if (!isAttributable(position)) return EMPTY;

  const totalBasis = position.costBasisUsd;
  const loss = Math.abs(position.realisedPnlUsd);
  if (!(totalBasis > 0) || !(loss > 0)) return EMPTY;

  const windowByLeg = new Map(legWindows.map((entry) => [legKey(entry.leg), entry.window]));
  const rows: AttributionRow[] = [];
  let attributedUsd = 0;
  let unattributedUsd = 0;

  for (const leg of position.legs) {
    const lossShare = (leg.costBasisUsd / totalBasis) * loss;
    if (!(lossShare > 0)) continue;

    const window = windowByLeg.get(legKey(leg));
    if (window === undefined || window.counterparties.length === 0) {
      unattributedUsd += lossShare;
      continue;
    }

    for (const counterparty of window.counterparties) {
      const attributed = lossShare * counterparty.share;
      if (!(attributed > 0)) continue;
      attributedUsd += attributed;
      rows.push({
        victim: position.wallet,
        counterparty: counterparty.wallet,
        mint: position.mint,
        venue: leg.venue,
        poolId: window.poolId,
        windowStartSlot: window.startSlot,
        windowEndSlot: window.endSlot,
        windowTs: window.buyTs,
        attributedUsd: attributed,
        share: counterparty.share,
        buyLegSignature: leg.signature,
      });
    }
  }

  return { rows, attributedUsd, unattributedUsd };
}

/** Merges the results of several positions into one. */
export function mergeResults(results: readonly AttributionResult[]): AttributionResult {
  const rows: AttributionRow[] = [];
  let attributedUsd = 0;
  let unattributedUsd = 0;
  for (const result of results) {
    rows.push(...result.rows);
    attributedUsd += result.attributedUsd;
    unattributedUsd += result.unattributedUsd;
  }
  return { rows, attributedUsd, unattributedUsd };
}

/**
 * The trace ledger: one entry per counterparty, ranked by dollars.
 *
 * Every entry keeps its rows, because §7.2 makes the window part of the claim —
 * a row without one is an assertion, and the product does not make those.
 */
export function rollUpByCounterparty(rows: readonly AttributionRow[]): CounterpartyTotal[] {
  const byWallet = new Map<string, { usd: number; rows: AttributionRow[]; mints: Set<string> }>();

  for (const row of rows) {
    const entry = byWallet.get(row.counterparty) ?? { usd: 0, rows: [], mints: new Set<string>() };
    entry.usd += row.attributedUsd;
    entry.rows.push(row);
    entry.mints.add(row.mint);
    byWallet.set(row.counterparty, entry);
  }

  return [...byWallet.entries()]
    .map(([counterparty, entry]) => ({
      counterparty,
      attributedUsd: entry.usd,
      mints: [...entry.mints],
      rows: entry.rows.sort((a, b) => b.attributedUsd - a.attributedUsd),
    }))
    .sort((a, b) => b.attributedUsd - a.attributedUsd);
}

/**
 * Identity of a buy leg within a position.
 *
 * A router can fill one order across several pools in one transaction, so the
 * signature alone is not unique — pairing windows by signature would hand the
 * wrong pool's counterparties to a leg.
 */
export function legKey(leg: PositionBuyLeg): string {
  return `${leg.signature}:${leg.slot.toString()}:${leg.poolId}`;
}

const EMPTY: AttributionResult = Object.freeze({
  rows: Object.freeze([]),
  attributedUsd: 0,
  unattributedUsd: 0,
});
