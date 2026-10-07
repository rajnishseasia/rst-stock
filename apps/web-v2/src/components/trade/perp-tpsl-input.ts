export type PerpTpSlInputMode =
  | "price"
  | "percent"
  | "roePercent"
  | "pnlUsd";
export type PerpTriggerKind = "stopLoss" | "takeProfit";
export type PerpPositionSide = "long" | "short";

/**
 * Convert a browser-friendly decimal into the plain decimal grammar used by
 * the perp API. Mobile keyboards commonly produce values such as `.0828`;
 * JavaScript accepts those, while the API deliberately requires `0.0828`.
 */
export function normalizePerpDecimalInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith(".")) return `0${trimmed}`;
  if (trimmed.endsWith(".")) return trimmed.slice(0, -1);
  return trimmed;
}

/** Convert an absolute trigger price back into the selected display unit. */
export function derivePerpTriggerValue(args: {
  mode: "percent" | "pnlUsd";
  triggerPrice: number;
  entryPrice: number;
  size: number;
}): number | null {
  const { mode, triggerPrice, entryPrice, size } = args;
  if (
    !Number.isFinite(triggerPrice) ||
    triggerPrice <= 0 ||
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0
  ) {
    return null;
  }
  const distance = Math.abs(triggerPrice - entryPrice);
  const value =
    mode === "percent"
      ? (distance / entryPrice) * 100
      : distance * Math.abs(size);
  return Number.isFinite(value) && value > 0 ? value : null;
}

interface DerivePerpTriggerPriceInput {
  mode: PerpTpSlInputMode;
  kind: PerpTriggerKind;
  side: PerpPositionSide;
  value: number;
  entryPrice: number;
  size: number;
  marginUsed?: number;
}

/**
 * Convert a friendly TP/SL input into the absolute trigger price Hyperliquid
 * expects. Percent values are price moves from entry. ROE values are returns
 * on the position's current margin. Dollar values are total position P&L, so
 * the per-coin price move is dollars / absolute position size.
 */
export function derivePerpTriggerPrice({
  mode,
  kind,
  side,
  value,
  entryPrice,
  size,
  marginUsed,
}: DerivePerpTriggerPriceInput): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (mode === "price") return value;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const absoluteSize = Math.abs(size);
  const absoluteMargin = Math.abs(marginUsed ?? Number.NaN);
  const delta =
    mode === "percent"
      ? entryPrice * (value / 100)
      : mode === "roePercent"
        ? absoluteSize > 0 &&
          Number.isFinite(absoluteMargin) &&
          absoluteMargin > 0
          ? (absoluteMargin * (value / 100)) / absoluteSize
          : Number.NaN
      : absoluteSize > 0
        ? value / absoluteSize
        : Number.NaN;
  if (!Number.isFinite(delta) || delta <= 0) return null;

  const movesUp =
    (side === "long" && kind === "takeProfit") ||
    (side === "short" && kind === "stopLoss");
  const price = entryPrice + (movesUp ? delta : -delta);
  if (!Number.isFinite(price) || price <= 0) return null;

  return Number(price.toPrecision(12));
}

/** A protective trigger must sit on the expected side of the current market. */
export function isPerpTriggerDirectionValid(
  kind: PerpTriggerKind,
  side: PerpPositionSide,
  triggerPrice: number,
  marketPrice: number,
): boolean {
  if (
    !Number.isFinite(triggerPrice) ||
    triggerPrice <= 0 ||
    !Number.isFinite(marketPrice) ||
    marketPrice <= 0
  ) {
    return false;
  }
  if (side === "long") {
    return kind === "stopLoss"
      ? triggerPrice < marketPrice
      : triggerPrice > marketPrice;
  }
  return kind === "stopLoss"
    ? triggerPrice > marketPrice
    : triggerPrice < marketPrice;
}

/** Stable plain-decimal string for the API payload and calculated-price UI. */
export function triggerPriceToInput(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "";
  // `Number#toString()` may emit exponent notation for fractional-cent assets,
  // while the API intentionally accepts plain decimal strings only.
  return price.toFixed(12).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}
