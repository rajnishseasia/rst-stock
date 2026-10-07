import {
  clampLeverageForCap,
  DEFAULT_PERP_LEVERAGE,
} from "./perp-form-math";

export interface ManualCopyPrefillEvent<T> {
  nonce: number;
  value: T;
  consumed: boolean;
}

export interface StockManualCopyPrefill {
  symbol: string;
  side: "buy" | "sell";
  /** Absent for an X-feed chip, which selects a source without sizing a ticket. */
  qty?: number;
  /** Canonical source-prefixed feed id, when this is an eligible manual copy. */
  copySourceItemId?: string;
  accountId?: string;
  accountType?: "PAPER" | "LIVE";
  assetType: "EQUITY" | "OPTION";
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: "CALL" | "PUT";
  tradeAction?: "BuyToOpen" | "SellToClose";
}

export interface PerpManualCopyPrefill {
  coin: string;
  side: "long" | "short";
  leverage?: number;
  /** Canonical source-prefixed feed id, when this is an eligible manual copy. */
  copySourceItemId?: string;
}

export function nextManualCopyNonce(current: number): number {
  return Number.isSafeInteger(current) && current < Number.MAX_SAFE_INTEGER
    ? current + 1
    : 1;
}

export function createManualCopyPrefill<T>(
  nonce: number,
  value: T,
): ManualCopyPrefillEvent<T> {
  return { nonce, value, consumed: false };
}

export function consumeManualCopyPrefill<T>(
  event: ManualCopyPrefillEvent<T> | null | undefined,
  nonce: number,
): ManualCopyPrefillEvent<T> | null | undefined {
  if (!event || event.nonce !== nonce || event.consumed) return event;
  return { ...event, consumed: true };
}

export type ManualCopyPrefillLifecycle = "completed" | "cancelled";

/** Apply a completion or cancellation only to the still-active copy event. */
export function applyManualCopyPrefillLifecycle<T>(
  event: ManualCopyPrefillEvent<T> | null | undefined,
  nonce: number,
  lifecycle: ManualCopyPrefillLifecycle,
): ManualCopyPrefillEvent<T> | null {
  if (lifecycle !== "completed" && lifecycle !== "cancelled") {
    return event ?? null;
  }
  if (!event || event.nonce !== nonce) return event ?? null;
  return null;
}

export function copyPrefillAccountMatches(
  event: ManualCopyPrefillEvent<StockManualCopyPrefill> | null | undefined,
  accountId: string | undefined,
  accountType?: "PAPER" | "LIVE",
): boolean {
  return (
    !event ||
    (event.value.accountId === accountId &&
      (accountType === undefined || event.value.accountType === accountType))
  );
}

/** Missing or malformed source leverage uses the form's conservative default. */
export function resolveManualCopyLeverage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_PERP_LEVERAGE;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Keep a verified equity-copy source attached only while the ticket still
 * represents the source's supported opening intent. The server remains the
 * authority; this client-side guard prevents an ordinary ticket edit from
 * accidentally carrying provenance into a different order.
 */
export function resolveStockManualCopySourceId({
  copySourceItemId,
  sourceSymbol,
  sourceSide,
  orderSymbol,
  assetType,
  action,
  direction,
}: {
  copySourceItemId?: string;
  sourceSymbol?: string;
  sourceSide?: "buy" | "sell";
  orderSymbol: string;
  assetType: "EQUITY" | "OPTION";
  action: string;
  direction: "long" | "short";
}): string | undefined {
  if (!copySourceItemId || assetType !== "EQUITY") return undefined;
  if (action !== "Buy" || direction !== "long") return undefined;
  if (sourceSide && sourceSide !== "buy") return undefined;

  const normalizedSource = sourceSymbol?.trim().toUpperCase();
  const normalizedOrder = orderSymbol.trim().toUpperCase();
  if (!normalizedSource || !normalizedOrder || normalizedSource !== normalizedOrder) {
    return undefined;
  }

  return copySourceItemId;
}

/** Keep a perp source only for the same opening coin and direction. */
export function resolvePerpManualCopySourceId({
  copySourceItemId,
  sourceCoin,
  sourceSide,
  orderCoin,
  isLong,
  reduceOnly,
}: {
  copySourceItemId?: string;
  sourceCoin?: string;
  sourceSide?: "long" | "short";
  orderCoin: string;
  isLong: boolean;
  reduceOnly: boolean;
}): string | undefined {
  if (!copySourceItemId || reduceOnly || !sourceCoin || !sourceSide) return undefined;
  if (sourceCoin !== orderCoin) return undefined;
  if (sourceSide !== (isLong ? "long" : "short")) return undefined;
  return copySourceItemId;
}

interface StockTicketResetInput {
  copy: StockManualCopyPrefill;
  currentMaxRisk?: string;
  trailingEnabled: boolean;
  trailingPercent: string;
  skipPresetTp: boolean;
}

/**
 * Build the complete stock ticket state for a manual copy event. The caller
 * overlays this object with the existing form state in one reset call, so a
 * copied side and quantity cannot leave an old order or exit leg behind.
 */
export function buildStockTicketReset({
  copy,
  currentMaxRisk,
  trailingEnabled,
  trailingPercent,
  skipPresetTp,
}: StockTicketResetInput) {
  const isOption = copy.assetType === "OPTION";
  const action: "Buy" | "Sell" | "BuyToOpen" | "SellToClose" = isOption
    ? copy.tradeAction ?? "BuyToOpen"
    : copy.side === "sell"
      ? "Sell"
      : "Buy";
  const quantity = isOption
    ? Math.min(10, Math.max(1, Math.floor(copy.qty ?? 1)))
    : Math.max(1, Math.floor(copy.qty ?? 1));
  const expiration = copy.optionExpiration ?? "";

  return {
    symbol: copy.symbol.trim().toUpperCase(),
    assetType: copy.assetType,
    orderType: isOption ? ("Market" as const) : ("OCO" as const),
    entryOrderType: "Market" as const,
    timeInForce: isOption ? ("day" as const) : ("gtc" as const),
    action,
    direction: "long" as const,
    maxRisk: currentMaxRisk || "100",
    quantity: String(quantity),
    stopMarketPrice: "",
    priceTrigger: "",
    limitPrice: "",
    optionsDateYear: isOption ? expiration.slice(0, 2) : "",
    optionsDateMonth: isOption ? expiration.slice(2, 4) : "",
    optionsDateDay: isOption ? expiration.slice(4, 6) : "",
    optionsStrike:
      isOption && copy.optionStrike != null ? String(copy.optionStrike) : "",
    optionsLimitPrice: "",
    optionType:
      isOption && copy.optionType === "PUT" ? ("put" as const) : ("call" as const),
    entryPriceRef: "",
    takeProfits: [],
    trailingEnabled,
    trailingPercent,
    trailingQty: "",
    skipPresetTp,
    forceThreeContracts: false,
    notes: "",
  };
}

interface PerpTicketResetInput {
  isLong: boolean;
  marginMode: "cross" | "isolated";
  leverage: unknown;
  maxLeverage?: number | null;
}

/** Reset every order-specific perp field before applying a manual copy. */
export function buildPerpTicketReset({
  isLong,
  marginMode,
  leverage,
  maxLeverage,
}: PerpTicketResetInput) {
  return {
    isLong,
    marginMode,
    orderType: "Market" as const,
    sizeCoin: "",
    limitPrice: "",
    triggerPx: "",
    reduceOnly: false,
    postOnly: false,
    leverage: clampLeverageForCap(
      resolveManualCopyLeverage(leverage),
      maxLeverage,
    ),
  };
}
