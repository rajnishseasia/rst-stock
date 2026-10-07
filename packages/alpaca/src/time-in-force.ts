/**
 * Time-in-Force (TIF) resolution for Alpaca orders.
 *
 * This is the single source of truth for which TIF a given order may use. It
 * exists because options have narrower TIF support than equities and the rules
 * are easy to get wrong. Every code path that submits an order to Alpaca (manual
 * trade, position close, copy-mirror) should resolve its TIF through here rather
 * than hardcoding a literal.
 *
 * Alpaca options rules (see
 * https://docs.alpaca.markets/us/docs/orders-at-alpaca and
 * https://alpaca.markets/learn/how-to-trade-good-til-canceled-options-trading-with-python-and-alpaca):
 *   - Options accept only `day` or `gtc`. `opg`, `cls`, `ioc`, `fok` are rejected.
 *   - `gtc` is supported ONLY for limit orders. Market/stop/stop_limit options
 *     must be `day`, so a market option submitted with `gtc` is rejected by the
 *     broker.
 *   - `gtc` works for both buying and selling option limit orders.
 *
 * Equities keep the broader Alpaca TIF set and the app's existing convention:
 * resting limit sells default to `gtc`, otherwise the caller's requested value
 * (defaulting to `gtc`) is honored.
 */

export type AlpacaTimeInForce = "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
export type AlpacaAssetType = "EQUITY" | "OPTION";
export type AlpacaOrderKind =
  | "market"
  | "limit"
  | "stop"
  | "stop_limit"
  | "trailing_stop";
export type AlpacaOrderSide = "buy" | "sell";

export interface ResolveTimeInForceInput<T extends AlpacaTimeInForce = AlpacaTimeInForce> {
  assetType: AlpacaAssetType;
  /** Normalized Alpaca order type (e.g. the value sent as `type`). */
  orderType: AlpacaOrderKind;
  side: AlpacaOrderSide;
  /** TIF the caller/user asked for, if any. */
  requested?: T;
}

/**
 * Resolve the TIF Alpaca will accept for a single-leg order.
 *
 * Options:
 *   - non-limit order  -> always `day` (Alpaca rejects `gtc` on market/stop)
 *   - limit sell       -> `gtc` (rest until filled or cancelled)
 *   - limit buy        -> honor an explicit `gtc`, otherwise `day`
 * Equities:
 *   - limit sell       -> `gtc`
 *   - otherwise        -> `requested` (default `gtc`)
 *
 * The result is `requested | "day" | "gtc"`, so callers passing a narrowed TIF
 * union (e.g. the trade form's `day|gtc|ioc|fok`) keep that narrowed type.
 */
export function resolveTimeInForce<T extends AlpacaTimeInForce = AlpacaTimeInForce>(
  input: ResolveTimeInForceInput<T>,
): T | "day" | "gtc" {
  const { assetType, orderType, side, requested } = input;

  if (assetType === "OPTION") {
    // Only limit options may use GTC; everything else is DAY-only.
    if (orderType !== "limit") return "day";
    if (side === "sell") return "gtc";
    // Limit buys: GTC is valid, but only when the caller explicitly asked for it.
    return requested === "gtc" ? "gtc" : "day";
  }

  if (orderType === "limit" && side === "sell") return "gtc";
  return requested ?? "gtc";
}
