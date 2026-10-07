export type PerpMarketSort =
  | "volume"
  | "open-interest"
  | "gainers"
  | "losers"
  | "symbol";

export interface SortablePerpMarket {
  coin: string;
  markPx: string | null;
  prevDayPx: string | null;
  dayNtlVlm: string | null;
  openInterest: string | null;
}

function finiteNumber(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function perpMarketChangePercent(market: SortablePerpMarket): number | null {
  const mark = finiteNumber(market.markPx);
  const previous = finiteNumber(market.prevDayPx);
  if (mark == null || previous == null || previous <= 0) return null;
  return ((mark - previous) / previous) * 100;
}

export function perpMarketOpenInterestUsd(market: SortablePerpMarket): number | null {
  const mark = finiteNumber(market.markPx);
  const openInterest = finiteNumber(market.openInterest);
  if (mark == null || openInterest == null || mark < 0 || openInterest < 0) return null;
  return mark * openInterest;
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: "asc" | "desc",
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
}

export function sortPerpMarkets<T extends SortablePerpMarket>(
  markets: readonly T[],
  sort: PerpMarketSort,
): T[] {
  return [...markets].sort((left, right) => {
    let comparison = 0;
    switch (sort) {
      case "volume":
        comparison = compareNullableNumbers(
          finiteNumber(left.dayNtlVlm),
          finiteNumber(right.dayNtlVlm),
          "desc",
        );
        break;
      case "open-interest":
        comparison = compareNullableNumbers(
          perpMarketOpenInterestUsd(left),
          perpMarketOpenInterestUsd(right),
          "desc",
        );
        break;
      case "gainers":
        comparison = compareNullableNumbers(
          perpMarketChangePercent(left),
          perpMarketChangePercent(right),
          "desc",
        );
        break;
      case "losers":
        comparison = compareNullableNumbers(
          perpMarketChangePercent(left),
          perpMarketChangePercent(right),
          "asc",
        );
        break;
      case "symbol":
        break;
    }
    return comparison || left.coin.localeCompare(right.coin);
  });
}
