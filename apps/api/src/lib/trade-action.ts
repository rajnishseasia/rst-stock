/** Shared position-intent helpers for social publication and copy mirroring. */

export type TradeAction =
  | "Buy"
  | "Sell"
  | "SellShort"
  | "BuyToCover"
  | "BuyToOpen"
  | "SellToClose"
  | "SellToOpen"
  | "BuyToClose";

export type TradeDirection = "long" | "short";

export function normalizeTradeAction(raw: string | null | undefined): TradeAction | null {
  switch (raw) {
    case "Buy":
    case "Sell":
    case "SellShort":
    case "BuyToCover":
    case "BuyToOpen":
    case "SellToClose":
    case "SellToOpen":
    case "BuyToClose":
      return raw;
    default:
      return null;
  }
}

/** The broker side implied by the full action, never by a lossy default. */
export function tradeActionSide(
  action: string | null | undefined,
): "buy" | "sell" | null {
  if (action?.startsWith("Buy")) return "buy";
  if (action?.startsWith("Sell")) return "sell";
  return null;
}

export function tradeActionDirection(
  action: string | null | undefined,
): TradeDirection | null {
  if (action === "SellShort" || action === "BuyToCover" || action === "SellToOpen" || action === "BuyToClose") {
    return "short";
  }
  if (action?.startsWith("Buy") || action?.startsWith("Sell")) return "long";
  return null;
}

/** Actions that the Alpaca auto-mirror path can execute without changing intent. */
export function isSupportedAlpacaMirrorAction(
  assetType: "EQUITY" | "OPTION",
  action: string | null | undefined,
): boolean {
  return assetType === "EQUITY"
    ? action === "Buy" || action === "Sell"
    : action === "BuyToOpen" || action === "SellToClose";
}
