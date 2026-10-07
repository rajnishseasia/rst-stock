/**
 * Fixed-point decimal arithmetic for the perp mirror (audit H7: own module).
 *
 * Hyperliquid sizes are decimal STRINGS with a per-market precision, and a size
 * that has been through a JavaScript float is a size the venue may round into a
 * different order than the one the guardrails approved. Everything here works on
 * bigint coefficients and an explicit scale so a copied close can be clamped to
 * the follower's live position exactly.
 *
 * Pure and dependency-free on purpose: no database, no venue, no logger. These
 * functions were lifted verbatim out of `copy-mirror.ts`; nothing about their
 * behavior changed in the move.
 */

import type { PerpSide } from "@trade-bot/hyperliquid";
import { isSafePositiveTradingPerpDecimal } from "@trade-bot/utils";

/**
 * Read a stored direction as a perp side, or null when it says nothing definite.
 *
 * Null is a refusal, not a default. A row whose direction we cannot read is one
 * whose exposure we cannot sign, and guessing "long" would be a guess about
 * which way someone's money is pointed.
 */
export function explicitPerpSide(direction: string | null): PerpSide | null {
  const value = direction?.trim().toLowerCase();
  if (value === "long" || value === "buy") return "long";
  if (value === "short" || value === "sell" || value === "sell_short" || value === "sellshort") {
    return "short";
  }
  return null;
}

export type PositiveDecimal = { coefficient: bigint; scale: number };

type UnboundedPositiveDecimal = { coefficient: bigint; scale: number };

/** Parse an ordinary or scientific decimal without applying the perp-size ceiling. */
function parseUnboundedPositiveDecimal(value: string): UnboundedPositiveDecimal | null {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const exponent = match[3] ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let coefficient = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return coefficient > 0n ? { coefficient, scale } : null;
}

/** Return the smaller positive decimal, preserving its exact value. */
export function minPositiveDecimal(left: string, right: string): string | null {
  const a = parseUnboundedPositiveDecimal(left);
  const b = parseUnboundedPositiveDecimal(right);
  if (!a || !b) return null;
  const commonScale = Math.max(a.scale, b.scale);
  const valueA = a.coefficient * 10n ** BigInt(commonScale - a.scale);
  const valueB = b.coefficient * 10n ** BigInt(commonScale - b.scale);
  return valueA <= valueB
    ? formatDecimal(a.coefficient, a.scale)
    : formatDecimal(b.coefficient, b.scale);
}

/** Multiply a positive decimal by a percentage in exact coefficient space. */
export function percentageDecimal(base: string, percentage: string): string | null {
  const left = parseUnboundedPositiveDecimal(base);
  const right = parseUnboundedPositiveDecimal(percentage);
  if (!left || !right) return null;
  const coefficient = left.coefficient * right.coefficient;
  const scale = left.scale + right.scale + 2;
  return coefficient > 0n ? formatDecimal(coefficient, scale) : null;
}

export function parsePositiveDecimal(value: string): PositiveDecimal | null {
  if (!isSafePositiveTradingPerpDecimal(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
}

export function formatDecimal(coefficient: bigint, scale: number): string {
  if (scale === 0) return coefficient.toString();
  const padded = coefficient.toString().padStart(scale + 1, "0");
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

export function truncateDecimal(value: string, scale: number): string | null {
  const parsed = parsePositiveDecimal(value);
  if (!parsed) return null;
  const coefficient = parsed.scale > scale
    ? parsed.coefficient / 10n ** BigInt(parsed.scale - scale)
    : parsed.coefficient * 10n ** BigInt(scale - parsed.scale);
  if (coefficient <= 0n) return null;
  const formatted = formatDecimal(coefficient, scale);
  return isSafePositiveTradingPerpDecimal(formatted) ? formatted : null;
}

/**
 * Divide two positive decimal values and truncate the quotient to `scale`
 * decimal places. Keep this in bigint space so a cap quotient can never be
 * rounded up by floating-point arithmetic.
 */
export function divideDecimalFloor(
  dividend: string,
  divisor: string,
  scale: number,
): string | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) return null;
  const left = parsePositiveDecimal(dividend);
  const right = parsePositiveDecimal(divisor);
  if (!left || !right) return null;

  const numerator = left.coefficient * 10n ** BigInt(right.scale + scale);
  const denominator = right.coefficient * 10n ** BigInt(left.scale);
  const coefficient = numerator / denominator;
  if (coefficient <= 0n) return null;
  const formatted = formatDecimal(coefficient, scale);
  return isSafePositiveTradingPerpDecimal(formatted) ? formatted : null;
}

/**
 * Divide two positive decimal values and round the quotient up to `scale`
 * decimal places. Keep this in bigint space so a venue-minimum quantity can
 * never be rounded down by floating-point arithmetic.
 */
export function divideDecimalCeil(
  dividend: string,
  divisor: string,
  scale: number,
): string | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) return null;
  const left = parsePositiveDecimal(dividend);
  const right = parsePositiveDecimal(divisor);
  if (!left || !right) return null;

  const numerator = left.coefficient * 10n ** BigInt(right.scale + scale);
  const denominator = right.coefficient * 10n ** BigInt(left.scale);
  let coefficient = numerator / denominator;
  if (numerator % denominator !== 0n) coefficient += 1n;
  if (coefficient <= 0n) return null;
  const formatted = formatDecimal(coefficient, scale);
  return isSafePositiveTradingPerpDecimal(formatted) ? formatted : null;
}

export function multiplyDecimal(value: string, multiplier: number, scale: number): string | null {
  const left = parsePositiveDecimal(value);
  const right = parsePositiveDecimal(String(multiplier));
  if (!left || !right) return null;
  const product = left.coefficient * right.coefficient;
  const productScale = left.scale + right.scale;
  const coefficient = productScale > scale
    ? product / 10n ** BigInt(productScale - scale)
    : product * 10n ** BigInt(scale - productScale);
  if (coefficient <= 0n) return null;
  const formatted = formatDecimal(coefficient, scale);
  return isSafePositiveTradingPerpDecimal(formatted) ? formatted : null;
}

export function minDecimal(left: string, right: string, scale: number): string | null {
  const a = truncateDecimal(left, scale);
  const b = truncateDecimal(right, scale);
  if (!a || !b) return null;
  const parsedA = parsePositiveDecimal(a)!;
  const parsedB = parsePositiveDecimal(b)!;
  const valueA = parsedA.coefficient * 10n ** BigInt(scale - parsedA.scale);
  const valueB = parsedB.coefficient * 10n ** BigInt(scale - parsedB.scale);
  return valueA <= valueB ? a : b;
}

export function proportionalDecimal(
  numerator: string,
  exposure: string,
  denominator: string,
  scale: number,
): string | null {
  const a = parsePositiveDecimal(numerator);
  const b = parsePositiveDecimal(exposure);
  const c = parsePositiveDecimal(denominator);
  if (!a || !b || !c) return null;

  const exponent = c.scale + scale - a.scale - b.scale;
  const rawNumerator = a.coefficient * b.coefficient;
  const scaledNumerator = exponent >= 0
    ? rawNumerator * 10n ** BigInt(exponent)
    : rawNumerator;
  const scaledDenominator = exponent >= 0
    ? c.coefficient
    : c.coefficient * 10n ** BigInt(-exponent);
  const coefficient = scaledNumerator / scaledDenominator;
  if (coefficient <= 0n) return null;
  const formatted = formatDecimal(coefficient, scale);
  return isSafePositiveTradingPerpDecimal(formatted) ? formatted : null;
}

/** Net signed exposure across a set of fills, or null when they cancel out. */
export function signedPerpExposure(
  rows: ReadonlyArray<{
    direction: string | null;
    executedSizeDecimal: string | null;
  }>,
  scale = 8,
): { side: PerpSide; size: string } | null {
  let coefficient = 0n;
  for (const row of rows) {
    if (!row.executedSizeDecimal) continue;
    const size = truncateDecimal(row.executedSizeDecimal, scale);
    const parsed = size ? parsePositiveDecimal(size) : null;
    const side = explicitPerpSide(row.direction);
    if (!parsed || !side) continue;
    const normalized = parsed.coefficient * 10n ** BigInt(scale - parsed.scale);
    coefficient += side === "long" ? normalized : -normalized;
  }
  if (coefficient === 0n) return null;
  const size = formatDecimal(coefficient > 0n ? coefficient : -coefficient, scale);
  if (!isSafePositiveTradingPerpDecimal(size)) return null;
  return {
    side: coefficient > 0n ? "long" : "short",
    size,
  };
}
