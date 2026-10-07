import { tradeActionSide, normalizeTradeAction, tradeActionDirection } from "./trade-action.js";

export interface CloseAllLocalOrder {
  id: string;
  brokerOrderId: string | null;
  symbol: string;
  assetType: string;
  tradeAction: string;
  direction: string;
  quantity: number | string | null;
  orderType: string;
  limitPrice: string | null;
}

export interface CloseAllSocialEvent {
  orderId: string;
  brokerOrderId: string;
  symbol: string;
  assetType: string;
  side: "buy" | "sell";
  qty: number;
  orderType: string;
  limitPrice: string | null;
  tradeAction: string;
  direction: string;
}

/** Build a social close only when one local row supplies the complete identity. */
export function resolveCloseAllSocialEvent(
  brokerOrder: { id?: string | null } | null | undefined,
  localMatches: readonly CloseAllLocalOrder[],
): CloseAllSocialEvent | null {
  const brokerOrderId = brokerOrder?.id;
  if (!brokerOrderId || localMatches.length !== 1) return null;
  const local = localMatches[0];
  if (!local || local.brokerOrderId !== brokerOrderId) return null;

  const action = normalizeTradeAction(local.tradeAction);
  const side = tradeActionSide(action);
  const direction = tradeActionDirection(action);
  const qty = typeof local.quantity === "number" ? local.quantity : Number(local.quantity);
  if (!action || !side || !direction || !Number.isFinite(qty) || qty <= 0) return null;
  if (!local.symbol || !local.orderType || !["EQUITY", "OPTION"].includes(local.assetType)) return null;

  return {
    orderId: local.id,
    brokerOrderId,
    symbol: local.symbol,
    assetType: local.assetType,
    side,
    qty,
    orderType: local.orderType,
    limitPrice: local.limitPrice,
    tradeAction: action,
    direction,
  };
}
