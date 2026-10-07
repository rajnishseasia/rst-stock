/**
 * Pure math for the perp trade form: size rounding to szDecimals, USD notional
 * <-> coin size conversion via mark price, and leverage clamping to a per-asset
 * maxLeverage.
 *
 * Kept framework-free (no React, no `@trade-bot/hyperliquid` — which pulls in the
 * viem/node SDK) so it lands in the browser bundle cheaply AND is unit-tested by
 * importing the real module (per CLAUDE.md: no readFileSync+regex tests). The HL
 * wrapper owns the *authoritative* server-side rounding (`formatSize`/
 * `clampLeverage`); this mirrors the same rules for responsive client-side UX and
 * a correct review-modal preview.
 */

/**
 * Sane default leverage on a fresh form. Deliberately > 1 so a cold mount (before
 * per-asset `maxLeverage` metadata has loaded) never presents a pinned 1x.
 */
export const DEFAULT_PERP_LEVERAGE = 2;

/**
 * Slider/chip ceiling used ONLY while the real per-asset cap is still loading, so
 * the control stays usable instead of collapsing to a 1x range. Once the real
 * `maxLeverage` arrives it takes over (and clamps the value down if needed).
 */
export const FALLBACK_MAX_LEVERAGE = 20;

/**
 * Clamp a requested leverage to `[1, maxLeverage]` and floor to an integer.
 * Mirrors the wrapper's `clampLeverage` so the slider/chips never present a
 * value HL would reject. `maxLeverage` below 1 (or non-finite) collapses to 1.
 */
export function clampPerpLeverage(requested: number, maxLeverage: number): number {
  const cap = Number.isFinite(maxLeverage) ? Math.max(1, Math.floor(maxLeverage)) : 1;
  const floored = Math.floor(requested);
  if (!Number.isFinite(floored) || floored < 1) return 1;
  return Math.min(floored, cap);
}

/**
 * Clamp leverage against a cap that MAY NOT BE LOADED YET.
 *
 * The per-asset `maxLeverage` arrives asynchronously from HL metadata. Until it
 * does, `maxLeverage` is `null`/`undefined` (or non-finite) and we must NOT clamp
 * down: doing so with a placeholder cap of 1 is exactly what pinned the slider to
 * 1x on a cold mount. When the cap is unknown we only floor to a valid integer
 * `>= 1` and pass the value through; the moment a REAL finite cap loads we clamp
 * DOWN against it. Never clamps UP.
 */
export function clampLeverageForCap(
  requested: number,
  maxLeverage: number | null | undefined,
): number {
  const floored = Math.floor(requested);
  const base = !Number.isFinite(floored) || floored < 1 ? 1 : floored;
  // No real cap known yet -> never clamp down (don't pin to 1x on cold load).
  if (maxLeverage == null || !Number.isFinite(maxLeverage) || maxLeverage < 1) {
    return base;
  }
  return Math.min(base, Math.floor(maxLeverage));
}

/**
 * Round a coin size DOWN to `szDecimals` places and return it as a plain decimal
 * string (no exponent, no trailing-zero padding). Truncation (not rounding to
 * nearest) matches HL's size rules and never overshoots the user's intended size.
 *
 * Returns "0" for non-positive / non-finite input.
 */
export function roundSizeToDecimals(size: number, szDecimals: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0";
  const decimals = Number.isFinite(szDecimals) ? Math.max(0, Math.floor(szDecimals)) : 0;
  const factor = 10 ** decimals;
  const truncated = Math.floor(size * factor) / factor;
  if (truncated <= 0) return "0";
  // toFixed then strip trailing zeros / dangling dot so "0.500" -> "0.5", "1.0" -> "1".
  const fixed = truncated.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * Convert a USD notional to a coin size at `markPrice`, rounded to `szDecimals`.
 * Used when the user edits the USD field. Returns "0" when inputs are unusable.
 */
export function usdToCoinSize(
  usdNotional: number,
  markPrice: number,
  szDecimals: number,
): string {
  if (
    !Number.isFinite(usdNotional) ||
    usdNotional <= 0 ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0
  ) {
    return "0";
  }
  return roundSizeToDecimals(usdNotional / markPrice, szDecimals);
}

/**
 * Reconcile the user-facing USD field with the submitted coin-size field.
 *
 * HIP-3 snapshots arrive asynchronously. A user can therefore type a USD
 * notional before the mark price is available. In that state we intentionally
 * return an empty coin size instead of the misleading value "0"; the form
 * reruns this conversion as soon as the mark/precision arrives.
 */
export function usdInputToCoinSize(
  rawUsd: string,
  markPrice: number,
  szDecimals: number,
): string {
  if (rawUsd.trim() === "") return "";
  const usdNotional = Number(rawUsd);
  if (!Number.isFinite(usdNotional) || usdNotional <= 0) return "0";
  if (!Number.isFinite(markPrice) || markPrice <= 0) return "";
  return usdToCoinSize(usdNotional, markPrice, szDecimals);
}

/**
 * Convert a coin size to its USD notional at `markPrice`. Used to keep the USD
 * field in sync when the user edits the coin field (and for the review preview).
 * Returns 0 when inputs are unusable.
 */
export function coinSizeToUsd(coinSize: number, markPrice: number): number {
  if (
    !Number.isFinite(coinSize) ||
    coinSize <= 0 ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0
  ) {
    return 0;
  }
  return coinSize * markPrice;
}

/**
 * Margin required for a position of `notionalUsd` at `leverage`. Drives the
 * "margin required" review row. Returns 0 for unusable input.
 */
export function marginRequiredUsd(notionalUsd: number, leverage: number): number {
  if (
    !Number.isFinite(notionalUsd) ||
    notionalUsd <= 0 ||
    !Number.isFinite(leverage) ||
    leverage < 1
  ) {
    return 0;
  }
  return notionalUsd / leverage;
}

/**
 * The concrete Hyperliquid order types the server accepts (mirrors the server's
 * `perpOrderSubmitSchema` orderType enum). The form maps a friendlier UI
 * selection onto one of these on submit.
 */
export type PerpOrderTypeValue =
  | "Market"
  | "Limit"
  | "StopMarket"
  | "StopLimit"
  | "TakeProfitMarket"
  | "TakeProfitLimit";

/**
 * The user-facing order-type selection. "TakeProfit" resolves to either the
 * market or limit take-profit variant depending on whether a limit price is
 * entered; "StopMarket"/"StopLimit" are explicit because a stop's limit price is
 * intentionally distinct from its trigger. Keeping the selector to five options
 * (Market / Limit / Stop Market / Stop Limit / Take Profit) stays usable while
 * still reaching all six backend types.
 */
export type PerpUiOrderType =
  | "Market"
  | "Limit"
  | "StopMarket"
  | "StopLimit"
  | "TakeProfit";

/** UI order types that require a trigger price (stop / take-profit). */
export const TRIGGER_UI_ORDER_TYPES: readonly PerpUiOrderType[] = [
  "StopMarket",
  "StopLimit",
  "TakeProfit",
] as const;

/** Whether the given UI order type is a trigger (stop / take-profit) order. */
export function isTriggerUiOrderType(ui: PerpUiOrderType): boolean {
  return TRIGGER_UI_ORDER_TYPES.includes(ui);
}

/**
 * Whether the given UI order type carries a user-supplied resting limit price.
 * Limit always does; a Take Profit becomes a limit variant only when the user
 * has typed a limit price. Stop Limit always carries one; Stop Market / Market
 * never do.
 */
export function uiOrderTypeUsesLimitPrice(
  ui: PerpUiOrderType,
  hasLimitPrice: boolean,
): boolean {
  switch (ui) {
    case "Limit":
    case "StopLimit":
      return true;
    case "TakeProfit":
      return hasLimitPrice;
    case "Market":
    case "StopMarket":
      return false;
  }
}

/**
 * Resolve a UI order-type selection (plus whether a limit price is present) into
 * the concrete server `PerpOrderTypeValue`. "Take Profit" becomes
 * TakeProfitLimit when a limit price is entered, else TakeProfitMarket — the
 * "offer a limit variant when a limit price is entered" rule.
 */
export function resolvePerpOrderType(
  ui: PerpUiOrderType,
  hasLimitPrice: boolean,
): PerpOrderTypeValue {
  switch (ui) {
    case "Market":
      return "Market";
    case "Limit":
      return "Limit";
    case "StopMarket":
      return "StopMarket";
    case "StopLimit":
      return "StopLimit";
    case "TakeProfit":
      return hasLimitPrice ? "TakeProfitLimit" : "TakeProfitMarket";
  }
}

/** Base ladder for the numeric leverage preset chips. */
export const PERP_LEVERAGE_PRESETS = [2, 5, 10, 20] as const;

/**
 * Derive the numeric leverage preset chips for an asset with the given
 * `maxLeverage`. Takes the base ladder, keeps only values STRICTLY BELOW the cap
 * (so the always-present "Max" chip is never duplicated by a numeric chip equal
 * to it, and no chip ever exceeds the cap), and de-duplicates. The caller renders
 * these chips plus a single trailing "Max" chip that selects `maxLeverage`.
 *
 * A `maxLeverage` of 10 yields [2, 5] (10 is Max); 5 yields [2] (5 is Max);
 * 3 yields [2]; 20 yields [2, 5, 10]; 25 yields [2, 5, 10, 20]. Non-finite or
 * sub-1 caps collapse the cap to 1 and yield [] (only the Max chip renders).
 */
export function leveragePresets(maxLeverage: number): number[] {
  const cap = Number.isFinite(maxLeverage) ? Math.max(1, Math.floor(maxLeverage)) : 1;
  const seen = new Set<number>();
  const presets: number[] = [];
  for (const preset of PERP_LEVERAGE_PRESETS) {
    if (preset >= cap || seen.has(preset)) continue;
    seen.add(preset);
    presets.push(preset);
  }
  return presets;
}

/** Leverage at/above which the review modal is always shown. */
export const PERP_REVIEW_LEVERAGE_THRESHOLD = 10;

/** Notional (USD) at/above which the review modal is always shown. */
export const PERP_REVIEW_NOTIONAL_CAP = 10_000;

/**
 * Whether a perp order must pass through the review modal before submission:
 * high leverage or large notional. Mirrors the equity form's `shouldReviewOrder`
 * gate but with perp-specific risk triggers.
 */
export function shouldReviewPerpOrder(args: {
  leverage: number;
  notionalUsd: number;
  requiresAccountTransitionDisclosure?: boolean;
}): boolean {
  return (
    args.requiresAccountTransitionDisclosure === true ||
    args.leverage >= PERP_REVIEW_LEVERAGE_THRESHOLD ||
    args.notionalUsd >= PERP_REVIEW_NOTIONAL_CAP
  );
}

/**
 * Generate a fresh client-side idempotency key (reused as the HL cloid). A UUID
 * gives us broker-side dedupe on retried submits without threading server state.
 */
export function generatePerpCloid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-crypto environments (should not happen in the browser).
  return `cloid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
