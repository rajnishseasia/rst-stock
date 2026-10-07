import { formatPriceUsd } from "@/lib/format";

export interface PositionEntryLine {
  /** Stable id for reconciler. */
  id: string;
  price: number;
  /** Rendered label at right edge, e.g. "Avg Entry: $150.00". */
  label: string;
  side?: "long" | "short";
}

/** The shape `positions.list` returns for active equity positions. */
export interface EquityPositionSource {
  symbol: string;
  qty?: number | string | null;
  avgEntryPrice?: number | string | null;
}

/** The shape `positions.listPerps` returns for active perp positions. */
export interface PerpPositionSource {
  coin: string;
  size?: number | string | null;
  entryPx?: number | string | null;
  side?: "long" | "short" | string | null;
}

function usablePrice(value: number | string | null | undefined): number | null {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function usableQty(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  if (parsed == null || !Number.isFinite(parsed)) return 0;
  return Math.abs(parsed);
}

/**
 * Position entry lines for an equity chart.
 */
export function equityPositionEntryLines(
  positions: ReadonlyArray<EquityPositionSource>,
  chartSymbol: string,
): PositionEntryLine[] {
  const canonical = chartSymbol.trim().toUpperCase();
  if (!canonical) return [];

  const lines: PositionEntryLine[] = [];
  for (const position of positions) {
    if (position.symbol.trim().toUpperCase() !== canonical) continue;
    const qty = usableQty(position.qty);
    if (qty <= 0) continue;
    const price = usablePrice(position.avgEntryPrice);
    if (price === null) continue;

    lines.push({
      id: `eq:entry:${canonical}:${price}`,
      price,
      label: `Avg Entry: ${formatPriceUsd(price)}`,
    });
  }

  return lines;
}

/**
 * Position entry lines for a perp chart.
 */
export function perpPositionEntryLines(
  positions: ReadonlyArray<PerpPositionSource>,
  chartCoin: string,
): PositionEntryLine[] {
  const canonical = chartCoin.trim().toUpperCase();
  if (!canonical) return [];

  const lines: PositionEntryLine[] = [];
  for (const position of positions) {
    if (position.coin.trim().toUpperCase() !== canonical) continue;
    const size = usableQty(position.size);
    if (size <= 0) continue;
    const price = usablePrice(position.entryPx);
    if (price === null) continue;

    const sideLabel = position.side ? `${position.side.toUpperCase()} ` : "";
    lines.push({
      id: `hl:entry:${canonical}:${price}`,
      price,
      label: `${sideLabel}Entry: ${formatPriceUsd(price)}`,
      side: position.side === "short" ? "short" : "long",
    });
  }

  return lines;
}

