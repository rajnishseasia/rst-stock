export interface KnownPerpFill {
  symbol: string;
  tradeAction: string;
  executedSizeDecimal: string | null;
  realizedPnl: string | null;
  executedAt: Date | null;
}

export interface LivePerpPosition {
  coin: string;
  side: "long" | "short";
  size: string;
}

function signedSize(fill: KnownPerpFill): number | null {
  const size = Number(fill.executedSizeDecimal);
  if (!Number.isFinite(size) || size <= 0) return null;
  switch (fill.tradeAction) {
    case "Buy":
    case "BuyToOpen":
    case "BuyToCover":
    case "BuyToClose":
      return size;
    case "Sell":
    case "SellShort":
    case "SellToOpen":
    case "SellToClose":
      return -size;
    default:
      return null;
  }
}

function isOpeningForPosition(fill: KnownPerpFill, side: LivePerpPosition["side"]): boolean {
  const delta = signedSize(fill);
  return delta != null && (side === "long" ? delta > 0 : delta < 0);
}

function fillKey(fill: KnownPerpFill): string {
  return [
    fill.symbol,
    fill.tradeAction,
    fill.executedSizeDecimal,
    fill.realizedPnl,
    fill.executedAt?.getTime() ?? "",
  ].join(":");
}

/**
 * Sum realized P&L from durable close rows after the most recent opening fill
 * for each live position. Exact duplicate reconciliation rows are collapsed;
 * distinct partial fills sharing an order id remain separate.
 */
export function realizedPnlForOpenPerps(
  fills: readonly KnownPerpFill[],
  positions: readonly LivePerpPosition[],
): Map<string, number | null> {
  const byCoin = new Map<string, KnownPerpFill[]>();
  const seen = new Set<string>();
  for (const fill of fills) {
    const key = fillKey(fill);
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = byCoin.get(fill.symbol);
    if (bucket) bucket.push(fill);
    else byCoin.set(fill.symbol, [fill]);
  }

  const result = new Map<string, number | null>();
  for (const position of positions) {
    const ordered = [...(byCoin.get(position.coin) ?? [])].sort(
      (a, b) => (a.executedAt?.getTime() ?? 0) - (b.executedAt?.getTime() ?? 0),
    );
    let lastOpenIndex = -1;
    for (let index = 0; index < ordered.length; index++) {
      const fill = ordered[index];
      if (fill && isOpeningForPosition(fill, position.side)) lastOpenIndex = index;
    }
    if (lastOpenIndex < 0) {
      result.set(position.coin, null);
      continue;
    }

    let realizedPnl = 0;
    for (const fill of ordered.slice(lastOpenIndex + 1)) {
      const delta = signedSize(fill);
      const closesPosition = delta != null && (position.side === "long" ? delta < 0 : delta > 0);
      if (!closesPosition) continue;
      const pnl = Number(fill.realizedPnl ?? 0);
      if (Number.isFinite(pnl)) realizedPnl += pnl;
    }
    result.set(position.coin, realizedPnl);
  }
  return result;
}
