/**
 * What a copy-feed trade was worth in dollars.
 *
 * A "user" row previously showed the ticker, the side and a live quote, but
 * nothing about SIZE, so a $50 dabble and a $50,000 conviction trade rendered
 * identically. Sizing a trade against your own account is a dollar question,
 * and a raw unit count does not answer it: shares, option contracts and perp
 * coins are not comparable, and a perp coin's unit price spans five orders of
 * magnitude across the venue.
 *
 * Reads the feed item's loosely typed `meta` bag (`qty`, `fillPrice`,
 * `limitPrice`, `assetType` — see `mapUserTradeToItem` in
 * apps/api/src/routers/copy-trade.ts), which is why every field is validated
 * here rather than trusted. Pure and framework-free so the arithmetic is
 * directly testable.
 */

/**
 * An equity option's premium is quoted PER SHARE and one contract covers 100 of
 * them. Multiplying the contract count by the bare premium understates what was
 * spent by exactly this factor.
 */
export const OPTION_CONTRACT_MULTIPLIER = 100;

/** The `meta` fields this calculation reads. Everything is optional and untrusted. */
export interface CopyTradeNotionalMeta {
  qty?: unknown;
  fillPrice?: unknown;
  limitPrice?: unknown;
  assetType?: unknown;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Dollar size of the trade, or null when it cannot be computed honestly.
 *
 * Prefers the actual fill price and falls back to the resting limit price, the
 * same precedence the Discord line uses. Null (rather than 0) whenever the size
 * or price is missing or unusable, so the caller renders nothing instead of a
 * "$0.00" that reads as a real, tiny trade.
 *
 * Not a claim about cash outlay: a leveraged perp costs margin rather than
 * notional, and a sell returns money rather than spending it. It is the
 * position's dollar size, which is what makes two trades comparable.
 */
export function copyTradeNotionalUsd(
  meta: CopyTradeNotionalMeta | null | undefined,
): number | null {
  if (!meta) return null;
  const qty = finiteNumber(meta.qty);
  if (qty == null || qty === 0) return null;
  const price = finiteNumber(meta.fillPrice) ?? finiteNumber(meta.limitPrice);
  if (price == null || price <= 0) return null;
  const isOption =
    typeof meta.assetType === "string" &&
    meta.assetType.trim().toUpperCase() === "OPTION";
  return Math.abs(qty) * price * (isOption ? OPTION_CONTRACT_MULTIPLIER : 1);
}
