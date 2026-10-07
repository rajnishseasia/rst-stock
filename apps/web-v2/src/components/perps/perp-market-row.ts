/**
 * The metric line under a coin in the HL Markets list.
 *
 * The list used to show one liquidity number that changed with the active sort
 * (volume while sorting by volume, open interest while sorting by open
 * interest, nothing at all while sorting by gainers / losers / symbol), so a
 * trader could not compare two rows on the same axis without re-sorting, and
 * funding never appeared at all even though `marketStats` already carries it.
 * A perp row is scanned on three numbers: how much traded, how crowded the book
 * is, and what the carry costs. This returns all three, in a fixed order, for
 * every sort.
 *
 * Pure and framework-free (no React) so the selection, the coin-units to USD
 * conversion, and the missing-data fallbacks are unit-testable directly.
 */

import { formatPerpFundingPct } from "@/components/perps/perp-format";
import {
  perpMarketOpenInterestUsd,
  type SortablePerpMarket,
} from "@/components/perps/perp-market-sort";
import { formatCompactUsd } from "@/lib/format";

/** A market-list row: the sortable stats plus the venue's funding rate. */
export type PerpMarketRow = SortablePerpMarket & {
  /** Hourly funding rate as a signed decimal; null when HL omitted it. */
  funding: string | null;
};

/** One labelled number on a market row's metric line. */
export interface PerpMarketRowMetric {
  /** Stable identity for React keys and tests; not shown to the user. */
  key: "volume" | "open-interest" | "funding";
  /** Short column label ("Vol", "OI", "Fund"). */
  label: string;
  /** Display string, already formatted; "-" when the input is unusable. */
  value: string;
}

/**
 * The three numbers shown under every coin, always in this order.
 *
 * Open interest is converted from HL's coin units to notional USD at the mark:
 * "90,000,000 kPEPE" is not comparable to "12,000 BTC", while dollars are.
 * Funding is deliberately left uncoloured. Its sign says which side pays, not
 * whether the number is good, and a green/red read would be wrong for half the
 * traders looking at it.
 */
export function perpMarketRowMetrics(
  market: PerpMarketRow,
): PerpMarketRowMetric[] {
  return [
    {
      key: "volume",
      label: "Vol",
      value: formatCompactUsd(market.dayNtlVlm),
    },
    {
      key: "open-interest",
      label: "OI",
      value: formatCompactUsd(perpMarketOpenInterestUsd(market)),
    },
    {
      key: "funding",
      label: "Fund",
      value: formatPerpFundingPct(market.funding),
    },
  ];
}
