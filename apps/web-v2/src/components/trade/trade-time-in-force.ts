type AssetType = "EQUITY" | "OPTION";
type OrderType = "Market" | "Limit" | "StopMarket" | "StopLimit" | "OCO";
type TimeInForce = "day" | "gtc" | "ioc" | "fok";

export function isSellAction(action: string) {
  return action.toLowerCase().includes("sell");
}

export function isLimitSellOrder({
  orderType,
  action,
}: {
  assetType: AssetType;
  orderType: OrderType;
  action: string;
}) {
  return orderType === "Limit" && isSellAction(action);
}

/**
 * Resolve the form's Time-in-Force value.
 *
 * Mirrors the server-side Alpaca rule in `resolveAlpacaTimeInForce` /
 * `resolveTimeInForce` so the form never drifts out of sync with what the
 * broker will accept.
 *
 * Options: Alpaca accepts GTC only on LIMIT orders. Market/stop options are
 * DAY-only and expire at market close, so we snap those to DAY. Limit sells
 * rest as GTC; limit buys keep the user's choice (DAY or GTC).
 *
 * Equities: limit sells rest as GTC; otherwise keep whatever the user picked.
 */
export function resolveTradeFormTimeInForce({
  assetType,
  orderType,
  action,
  timeInForce,
}: {
  assetType: AssetType;
  orderType: OrderType;
  action: string;
  timeInForce: TimeInForce;
}): TimeInForce {
  if (assetType === "OPTION") {
    // Only limit options may use GTC; everything else is DAY-only.
    if (orderType !== "Limit") return "day";
    if (isSellAction(action)) return "gtc";
    // Limit buys: GTC is valid, but options never support IOC/FOK, so clamp.
    return timeInForce === "gtc" ? "gtc" : "day";
  }

  if (isLimitSellOrder({ assetType, orderType, action })) return "gtc";
  return timeInForce;
}
