export type NormalizedStopLossInput =
  | {
      success: true;
      value: number;
      displayValue: string;
      wasSanitized: boolean;
      wasRoundedUp: boolean;
    }
  | {
      success: false;
      error: string;
    };

const CENTS = 100;
const FLOATING_POINT_TOLERANCE = 1e-9;

export const INVALID_CURRENT_MARKET_PRICE_ERROR =
  "Cannot validate exit price without a valid current market price.";

export type StockPositionSide = "long" | "short";

export function isValidMarketPrice(
  currentPrice: number | null | undefined
): currentPrice is number {
  return typeof currentPrice === "number" && Number.isFinite(currentPrice) && currentPrice > 0;
}

export function roundUpToCents(value: number) {
  return Number(
    (
      Math.ceil(value * CENTS - FLOATING_POINT_TOLERANCE) / CENTS
    ).toFixed(2)
  );
}

/**
 * Validate that a stop-loss price sits on the correct side of the live price
 * for the position's direction: below for a long, above for a short. A stop on
 * the wrong side would trigger immediately, so the broker rejects it (and it
 * makes no sense as protection). Returns an error message, or null if valid.
 *
 * A missing or invalid market price makes direction unverifiable, so saves
 * must fail closed instead of reaching the broker.
 */
export function validateStopLossDirection(
  stopPrice: number,
  side: StockPositionSide,
  currentPrice: number | null | undefined
): string | null {
  if (!isValidMarketPrice(currentPrice)) {
    return INVALID_CURRENT_MARKET_PRICE_ERROR;
  }
  if (side === "long" && currentPrice <= stopPrice) {
    return "For a long, set the stop BELOW the current price.";
  }
  if (side === "short" && currentPrice >= stopPrice) {
    return "For a short, set the stop ABOVE the current price.";
  }
  return null;
}

export function normalizeStopLossInput(rawValue: string): NormalizedStopLossInput {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return { success: false, error: "Enter a positive stop price." };
  }

  const formatted = trimmed.replace(/[\s,$]/g, "");

  if (!/^[0-9.]+$/.test(formatted)) {
    return { success: false, error: "Use digits and a decimal point only." };
  }

  const firstDecimalIndex = formatted.indexOf(".");
  const sanitized =
    firstDecimalIndex === -1
      ? formatted
      : `${formatted.slice(0, firstDecimalIndex + 1)}${formatted
          .slice(firstDecimalIndex + 1)
          .replace(/\./g, "")}`;

  const parsed = Number(sanitized);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { success: false, error: "Enter a positive stop price." };
  }

  const rounded = roundUpToCents(parsed);

  return {
    success: true,
    value: rounded,
    displayValue: rounded.toFixed(2),
    wasSanitized: sanitized !== formatted,
    wasRoundedUp: Math.abs(rounded - parsed) > FLOATING_POINT_TOLERANCE,
  };
}
