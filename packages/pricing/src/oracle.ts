import {
  WSOL_MINT,
  quoteAsset,
  quoteToUsd,
  type QuotePrice,
  type UsdPriceSource,
} from '@exitliquidity/core';
import type { SolUsdSeries } from './sol-usd-series.js';

/** Why a quote leg came back unpriced. Surfaced as a metric label. */
export type UnpricedReason = 'unknown_quote_asset' | 'no_price_in_range' | 'not_representable';

export interface PriceOutcome {
  readonly price: QuotePrice | null;
  readonly reason: UnpricedReason | null;
}

export interface QuoteOracle {
  price(
    quoteMint: string,
    quoteAmount: bigint,
    quoteDecimals: number,
    blockTime: number,
  ): PriceOutcome;
}

/**
 * Prices a swap's quote leg.
 *
 * Spec §2 Stage 1 is explicit that the price never comes from the pool — on a
 * thin memecoin pool that number is manipulable by design, and a manipulated
 * price would flow straight through cost basis into attributed dollars. So
 * there are exactly two sources: a dollar stablecoin at its peg, and SOL from
 * the Pyth series. Anything else is left null.
 */
export class SolUsdOracle implements QuoteOracle {
  constructor(private readonly series: SolUsdSeries) {}

  price(
    quoteMint: string,
    quoteAmount: bigint,
    quoteDecimals: number,
    blockTime: number,
  ): PriceOutcome {
    const asset = quoteAsset(quoteMint);
    if (asset === null) {
      return { price: null, reason: 'unknown_quote_asset' };
    }

    if (asset.usdPerUnit !== null) {
      return outcome(quoteAmount, quoteDecimals, asset.usdPerUnit, 'stable_peg');
    }

    if (quoteMint !== WSOL_MINT) {
      // A non-stable quote asset with no series behind it. Unreachable today,
      // but adding one to QUOTE_ASSETS without a feed must not fabricate a price.
      return { price: null, reason: 'unknown_quote_asset' };
    }

    const point = this.series.lookup(blockTime);
    if (point === null) return { price: null, reason: 'no_price_in_range' };

    return outcome(quoteAmount, quoteDecimals, point.usd, 'pyth_1m');
  }
}

function outcome(
  quoteAmount: bigint,
  quoteDecimals: number,
  usdPerUnit: number,
  source: UsdPriceSource,
): PriceOutcome {
  const usd = quoteToUsd(quoteAmount, quoteDecimals, usdPerUnit);
  if (usd === null) return { price: null, reason: 'not_representable' };
  return { price: { usd, source }, reason: null };
}

/** An oracle that prices nothing. Used when pricing is explicitly disabled. */
export class NullOracle implements QuoteOracle {
  price(): PriceOutcome {
    return { price: null, reason: 'no_price_in_range' };
  }
}
