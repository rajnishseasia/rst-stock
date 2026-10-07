/**
 * Largest finite numeric value that can safely participate in leaderboard,
 * ingestion, and mirror sizing arithmetic without exceeding JS safe precision.
 */
export const MAX_SAFE_TRADING_VALUE = Number.MAX_SAFE_INTEGER;

/** Maximum decimal(24,8) perp size that remains exactly representable in JS. */
export const MAX_SAFE_TRADING_PERP_SIZE = "90071992.54740991";

/** Numeric form for paths that have already validated a decimal string. */
export const MAX_SAFE_TRADING_PERP_NUMBER = Number(MAX_SAFE_TRADING_PERP_SIZE);

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

/**
 * Compare a decimal string to the shared perp ceiling without converting it to
 * Number first. The caller may use this for sizes and prices at ingestion.
 */
export function isSafeTradingPerpDecimal(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) return false;
  const parts = value.split(".");
  const whole = (parts[0] ?? "").replace(/^0+/, "") || "0";
  const fraction = (parts[1] ?? "").replace(/0+$/, "");
  const maxParts = MAX_SAFE_TRADING_PERP_SIZE.split(".");
  const maxWhole = maxParts[0] ?? "";
  const maxFraction = maxParts[1] ?? "";

  if (whole.length !== maxWhole.length) return whole.length < maxWhole.length;
  if (whole !== maxWhole) return whole < maxWhole;

  const width = Math.max(fraction.length, maxFraction.length);
  const left = fraction.padEnd(width, "0");
  const right = maxFraction.padEnd(width, "0");
  return left <= right;
}

/** True only for a strictly positive decimal within the shared perp domain. */
export function isSafePositiveTradingPerpDecimal(value: unknown): value is string {
  if (!isSafeTradingPerpDecimal(value)) return false;
  return /[1-9]/.test(value.replace(/\./g, ""));
}
