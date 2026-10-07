/**
 * Pure mapping helpers for Hyperliquid perp orders + positions.
 *
 * Extracted from the routers so the payload/row mapping can be unit-tested
 * against the real modules (no readFileSync+regex). Two responsibilities:
 *   1. perp submit input  → `@trade-bot/hyperliquid` `PlacePerpOrderRequest`
 *   2. perp submit input  → `orders` table insert values (DECIMAL size via
 *      `quantityDecimal`, `venue="hyperliquid"`, cloid reused as clientOrderId)
 *   3. `clearinghouseState` position → the perp row `positions.listPerps` returns
 *      (delegated to the wrapper's `mapPositionRow`, re-exported here).
 */

import {
  aggressivePrice,
  networkFromEnv,
  triggerSpecForOrderType,
} from "@trade-bot/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { z } from "zod";
import type {
  PlacePerpOrderRequest,
  PerpOrderType,
  PerpSide,
} from "@trade-bot/hyperliquid";
import { isSafePositiveTradingPerpDecimal } from "@trade-bot/utils";
import { copySourceItemIdSchema } from "./manual-copy-source.js";

/** The four trigger (stop / take-profit) order types. */
const TRIGGER_ORDER_TYPES = new Set<PerpOrderType>([
  "StopMarket",
  "StopLimit",
  "TakeProfitMarket",
  "TakeProfitLimit",
]);

/** Order types that carry a user-supplied resting limit price (`p`). */
const LIMIT_PRICE_REQUIRED = new Set<PerpOrderType>([
  "Limit",
  "StopLimit",
  "TakeProfitLimit",
]);

/** Hyperliquid's inclusive minimum notional for a perp order. */
export const HYPERLIQUID_MIN_NOTIONAL_USD = 10;

/** Stable UI-facing message for a server-side minimum-notional rejection. */
export const HYPERLIQUID_MIN_NOTIONAL_MESSAGE =
  "Hyperliquid order notional must be at least $10.";

const positivePerpDecimal = (field: string) =>
  z.string().refine(
    (value) => isSafePositiveTradingPerpDecimal(value),
    `${field} must be a positive safe decimal string`,
  );

/**
 * Shared coin schema for EVERY perp procedure input (submit, cancel, TP/SL,
 * leverage). The coin must be HL's CANONICAL case-sensitive spelling
 * (e.g. `kPEPE`, `kBONK`, `xyz:GOOGL`): it is trimmed but never uppercased,
 * because the HL asset lookup is exact-match and "KPEPE" is an unknown coin.
 * Do NOT reuse the equity `symbolSchema` here (it uppercases, which is
 * correct for stocks only).
 */
export const perpCoinSchema = z.string().trim().min(1).max(20);

/**
 * Zod schema for a perp order submission (`orders.submitPerp`). Mirrors the
 * equity `orderSubmitSchema` idioms (idempotency key) but is perp-shaped:
 * decimal size string, leverage, margin mode, reduce/post-only. The coin must
 * be HL's CANONICAL case-sensitive spelling (e.g. `kPEPE`): it is trimmed but
 * never uppercased, because the HL asset lookup is exact-match and "KPEPE"
 * is an unknown coin.
 */
export const perpOrderSubmitSchema = z
  .object({
    coin: perpCoinSchema,
    isLong: z.boolean(),
    marginMode: z.enum(["cross", "isolated"]),
    orderType: z.enum([
      "Market",
      "Limit",
      "StopMarket",
      "StopLimit",
      "TakeProfitMarket",
      "TakeProfitLimit",
    ]),
    /**
     * Size in coin units as a DECIMAL STRING — never a JS number, to avoid
     * float truncation. Rounded to the asset's szDecimals downstream. Must be a
     * positive numeric string.
     */
    sizeCoin: positivePerpDecimal("sizeCoin"),
    limitPrice: positivePerpDecimal("limitPrice").optional(),
    /**
     * Trigger price for the stop / take-profit trigger order types. Positive
     * decimal string. Required for StopMarket/StopLimit/TakeProfitMarket/
     * TakeProfitLimit; ignored for Market/Limit.
     */
    triggerPx: positivePerpDecimal("triggerPx").optional(),
    reduceOnly: z.boolean().default(false),
    postOnly: z.boolean().default(false),
    leverage: z.number().int().positive(),
    /** Idempotency key reused as the HL cloid (unique index dedupes). */
    cloid: z.string().min(1),
    /** Canonical copy-trade feed item, verified server-side when supplied. */
    copySourceItemId: copySourceItemIdSchema.optional(),
    /** Current mark price (decimal string) for synthesizing a Market IoC price. */
    markPrice: positivePerpDecimal("markPrice").optional(),
    /**
     * Optional take-profit trigger price (positive decimal string). When provided
     * alongside a Market/Limit order, the server places a reduce-only
     * TakeProfitMarket order at this price after the main order is submitted.
     */
    takeProfitPx: positivePerpDecimal("takeProfitPx").optional(),
    /**
     * Optional stop-loss trigger price (positive decimal string). When provided
     * alongside a Market/Limit order, the server places a reduce-only StopMarket
     * order at this price after the main order is submitted.
     */
    stopLossPx: positivePerpDecimal("stopLossPx").optional(),
  })
  .refine(
    // limitPrice is required for a resting limit price: plain Limit orders and
    // the non-market trigger types (StopLimit / TakeProfitLimit), which carry a
    // user limit price as the trigger order's `p`.
    (v) => !LIMIT_PRICE_REQUIRED.has(v.orderType) || v.limitPrice !== undefined,
    {
      message: "limitPrice is required for Limit, StopLimit, and TakeProfitLimit orders",
      path: ["limitPrice"],
    },
  )
  .refine(
    // triggerPx is required for every trigger (stop / take-profit) order type.
    (v) => !TRIGGER_ORDER_TYPES.has(v.orderType) || v.triggerPx !== undefined,
    {
      message: "triggerPx is required for Stop/TakeProfit trigger orders",
      path: ["triggerPx"],
    },
  )
  .refine(
    (v) => !v.postOnly || v.orderType === "Limit",
    { message: "postOnly is only valid for Limit orders", path: ["postOnly"] },
  )
  .refine(
    (v) =>
      (v.takeProfitPx === undefined && v.stopLossPx === undefined) ||
      (v.orderType === "Market" && !v.reduceOnly),
    {
      message: "Inline TP/SL is only valid for new Market positions",
      path: ["takeProfitPx"],
    },
  );

export type PerpOrderSubmitInput = z.infer<typeof perpOrderSubmitSchema>;

/** Format a requested size exactly as the Hyperliquid venue will submit it. */
export function formatPerpOrderSizeForVenue(
  sizeCoin: string,
  szDecimals: number,
): string {
  try {
    return formatSize(sizeCoin, szDecimals);
  } catch (error) {
    // The venue formatter rejects a positive size that truncates to zero. Treat
    // it as zero here so the caller can return the same stable minimum-notional
    // response without inserting a local order or reaching the venue.
    if (error instanceof Error && error.message === "Size is too small and was truncated to 0") {
      return "0";
    }
    throw error;
  }
}

/**
 * Compute the price Hyperliquid puts in the order payload (`p`). Market orders
 * use a fresh server-side mid; trigger-market orders use their trigger price;
 * limit variants use the supplied resting limit price.
 */
export function effectivePerpOrderPrice(
  input: PerpOrderSubmitInput,
  freshMarketPrice: string | undefined,
  szDecimals: number,
): string {
  const side: PerpSide = input.isLong ? "long" : "short";

  if (input.orderType === "Market") {
    if (freshMarketPrice === undefined) {
      throw new Error("Market orders require a fresh market price for preflight.");
    }
    return aggressivePrice(freshMarketPrice, side, szDecimals);
  }

  if (input.orderType === "Limit") {
    if (input.limitPrice === undefined) {
      throw new Error("Limit orders require a limitPrice.");
    }
    return formatPrice(input.limitPrice, szDecimals);
  }

  const trigger = triggerSpecForOrderType(input.orderType);
  if (!trigger || input.triggerPx === undefined) {
    throw new Error(`${input.orderType} orders require a triggerPx.`);
  }
  if (trigger.isMarket) {
    return aggressivePrice(input.triggerPx, side, szDecimals);
  }
  if (input.limitPrice === undefined) {
    throw new Error(`${input.orderType} orders require a limitPrice.`);
  }
  return formatPrice(input.limitPrice, szDecimals);
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return { coefficient: BigInt(digits), scale: fraction.length };
}

/** Compare the venue-rounded size × payload price to the inclusive $10 floor. */
export function isPerpOrderNotionalAtLeastMinimum(
  venueSize: string,
  effectivePrice: string,
): boolean {
  const size = decimalParts(venueSize);
  const price = decimalParts(effectivePrice);
  const scale = size.scale + price.scale;
  const minimum = BigInt(HYPERLIQUID_MIN_NOTIONAL_USD) * 10n ** BigInt(scale);
  return size.coefficient * price.coefficient >= minimum;
}

/** Map a validated perp submit input to a wrapper `PlacePerpOrderRequest`. */
export function toPlacePerpOrderRequest(
  input: PerpOrderSubmitInput,
): PlacePerpOrderRequest {
  const side: PerpSide = input.isLong ? "long" : "short";
  return {
    coin: input.coin,
    side,
    size: input.sizeCoin,
    orderType: input.orderType,
    reduceOnly: input.reduceOnly,
    postOnly: input.postOnly,
    clientOrderId: input.cloid,
    ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}),
    ...(input.triggerPx !== undefined ? { triggerPx: input.triggerPx } : {}),
    ...(input.markPrice !== undefined ? { markPrice: input.markPrice } : {}),
  };
}

/**
 * The `tradeAction` enum has no perp-native member, so map long/short onto the
 * existing Buy/Sell values (the venue column disambiguates). Reduce-only closes
 * still record the direction that reduces the position.
 */
export function perpTradeAction(isLong: boolean): "Buy" | "Sell" {
  return isLong ? "Buy" : "Sell";
}

/**
 * Build the `orders` table insert values for a perp order. CRITICAL: the
 * fractional size goes to `quantityDecimal` (DECIMAL) and NEVER to the INTEGER
 * `quantity` column, which would silently truncate. `quantity` is set to 0 as a
 * schema-required placeholder for perps (real size lives in `quantityDecimal`).
 */
export function toPerpOrderRow(
  input: PerpOrderSubmitInput,
  userId: string,
  brokerAccountId: string | null,
): {
  userId: string;
  symbol: string;
  assetType: "PERP";
  orderType: PerpOrderType;
  tradeAction: "Buy" | "Sell";
  direction: "long" | "short";
  quantity: number;
  quantityDecimal: string;
  limitPrice: string | undefined;
  /** HL triggerPx for the stop / take-profit trigger types (reuses priceTrigger). */
  priceTrigger: string | undefined;
  leverage: number;
  marginMode: "cross" | "isolated";
  reduceOnly: boolean;
  venue: "hyperliquid";
  venueNetwork: string;
  clientOrderId: string;
  brokerAccountId: string | null;
  status: "PENDING";
} {
  return {
    userId,
    symbol: input.coin,
    assetType: "PERP",
    orderType: input.orderType,
    tradeAction: perpTradeAction(input.isLong),
    direction: input.isLong ? "long" : "short",
    // Placeholder — perps must never rely on the INTEGER quantity column.
    quantity: 0,
    quantityDecimal: input.sizeCoin,
    limitPrice: input.limitPrice,
    // Persist the HL trigger price into the existing priceTrigger column (no new
    // column needed). Undefined for Market/Limit.
    priceTrigger: input.triggerPx,
    leverage: input.leverage,
    marginMode: input.marginMode,
    reduceOnly: input.reduceOnly,
    venue: "hyperliquid",
    // WHICH chain this order goes to, recorded on the row rather than inferred
    // later from configuration. The reconciler reads open perp orders and asks
    // the venue what became of them; without this it asks whichever network is
    // configured NOW, so moving a deployment between networks makes every older
    // order look like one that never reached the venue and settles it CANCELLED
    // while the exposure is still live on the other chain.
    venueNetwork: networkFromEnv(),
    clientOrderId: input.cloid,
    brokerAccountId,
    status: "PENDING",
  };
}

export { mapPositionRow } from "@trade-bot/hyperliquid";
