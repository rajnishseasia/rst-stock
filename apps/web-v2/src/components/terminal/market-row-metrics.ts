/**
 * The compact metric line under an instrument row on the mobile surfaces.
 *
 * Mobile rows used to spend their second line on a word that restated the
 * badge sitting directly beside it ("Perpetual" next to a PERP badge,
 * "Equity" next to STOCK) and carried no liquidity number at all, while the
 * apps we are measured against put volume, open interest and funding on the
 * same line without making it taller. This composes the numbers that take
 * that word's place.
 *
 * Perps delegate to `perpMarketRowMetrics`, the module the desktop HL Markets
 * list already uses, so the two surfaces cannot drift on what Vol / OI / Fund
 * mean or on how open interest is valued (USD at the mark, never coin units).
 *
 * Pure and framework-free (no React) so the unit handling and the
 * missing-data fallbacks are unit-testable directly.
 */

import {
  perpMarketRowMetrics,
  type PerpMarketRow,
  type PerpMarketRowMetric,
} from "@/components/perps/perp-market-row";
import { formatCompactNumber, formatCompactUsd } from "@/lib/format";

/**
 * One labelled number on a row's metric line. Structurally the desktop
 * `PerpMarketRowMetric`, widened only in `key` so an equity row can sit in the
 * same renderer.
 */
export interface MarketRowMetric {
  /** Stable identity for React keys and tests; not shown to the user. */
  key: string;
  /** Short column label ("Vol", "OI", "Fund", "Max"). */
  label: string;
  /** Display string, already formatted. */
  value: string;
}

/**
 * Read a share-volume field off a quote payload.
 *
 * `quotes.getStockQuotes` and `quotes.getChartQuotes` both return volume as a
 * grouped locale string ("12,345,678"), and `Number("12,345,678")` is NaN, so
 * a naive parse silently blanks the metric on every stock row. Ranking tiles
 * carry the same number as a plain `number`. Both shapes land here.
 */
export function parseShareVolume(
  value: number | string | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = value.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The equity row's metric line: traded share volume.
 *
 * Deliberately `formatCompactNumber`, not `formatCompactUsd`. Alpaca's daily
 * bar volume is a COUNT OF SHARES; rendering "$52.1M" for 52.1 million shares
 * would be a different number entirely. Hyperliquid's `dayNtlVlm` really is
 * notional dollars, which is why the perp side keeps the dollar formatter.
 *
 * An absent or zero volume returns no metric rather than a "0" or a "-": a
 * pre-market snapshot legitimately has no traded volume yet, and a row that
 * simply omits the number reads better than one asserting there was none.
 */
export function stockRowMetrics(
  volume: number | string | null | undefined,
): MarketRowMetric[] {
  const shares = parseShareVolume(volume);
  if (shares == null || shares <= 0) return [];
  return [{ key: "volume", label: "Vol", value: formatCompactNumber(shares) }];
}

/**
 * The perp row's metric line: Vol / OI / Fund, straight from the desktop
 * composer.
 *
 * `fallbackNotionalVolume` covers the ranking tiles, which carry a venue
 * volume in USD but no open interest or funding of their own. When the live
 * `marketStats` row has not landed (or the coin is not in it), the row shows
 * the one number it can stand behind instead of three dashes.
 */
export function perpRowMetrics(
  stat: PerpMarketRow | null | undefined,
  fallbackNotionalVolume?: number | string | null,
): MarketRowMetric[] {
  if (stat) return perpMarketRowMetrics(stat) as PerpMarketRowMetric[];
  const notional =
    typeof fallbackNotionalVolume === "string"
      ? Number(fallbackNotionalVolume)
      : fallbackNotionalVolume;
  if (notional == null || !Number.isFinite(notional) || notional <= 0) {
    return [];
  }
  return [{ key: "volume", label: "Vol", value: formatCompactUsd(notional) }];
}

/**
 * The venue's maximum leverage, as a trailing metric.
 *
 * Kept out of `perpMarketRowMetrics` on purpose: that module's contract is
 * "the same three axes on every row at every sort", and leverage is a static
 * venue property, not a live market number. The mobile row appends it because
 * it has the horizontal room the desktop list spends on a chip.
 */
export function perpLeverageMetric(
  maxLeverage: number | null | undefined,
): MarketRowMetric[] {
  if (maxLeverage == null || !Number.isFinite(maxLeverage) || maxLeverage <= 0) {
    return [];
  }
  return [{ key: "leverage", label: "Max", value: `${maxLeverage}x` }];
}
