/**
 * Shared money/number formatters (audit M16).
 *
 * These used to be re-declared in 7+ components with subtly different
 * signatures (some tolerated strings/null, some did not), which risked
 * inconsistent money rendering. One canonical implementation, tolerant of
 * the loosest inputs any call site passes; invalid input renders "-".
 */

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$1,234.56" for anything number-like; "-" for null/undefined/NaN. */
export function formatUsd(value: number | string | null | undefined): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed)) return "-";
  return USD_FORMATTER.format(parsed);
}

/**
 * Compact above $10k ("$12.3K", "$5M": no trailing zeros), standard below,
 * 4 decimals under $1 so sub-dollar prices are not rounded to "$0.00".
 */
export function formatCompactUsd(value: number | string | null | undefined): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed)) return "-";
  const absolute = Math.abs(parsed);
  if (absolute >= 10000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(parsed);
  }
  const fractionDigits =
    absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : absolute >= 0.0001 ? 6 : 8;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(parsed);
}

/**
 * Quote-style price: 2 decimals at $1 and above, 4 below so a sub-dollar
 * price does not round to "$0.00". "-" for anything that is not a positive
 * finite price: the batch quote endpoints report 0 for a failed snapshot
 * lookup, and no tradable price is zero or negative. Values that can
 * legitimately go negative (P&L) belong in formatSignedUsd instead.
 */
export function formatPriceUsd(value: number | string | null | undefined): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return "-";
  const fractionDigits = parsed >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(parsed);
}

/** Whole-dollar exits omit .00; cents and sub-dollar precision stay visible. */
export function formatExitPriceUsd(value: number | string | null | undefined): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return "-";
  const absolute = Math.abs(parsed);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: absolute < 1 ? 2 : 0,
    maximumFractionDigits: absolute >= 1 ? 2 : Math.min(12, Math.ceil(-Math.log10(absolute)) + 4),
  }).format(parsed);
}

/** "+$1,234.56" / "-$42.00" / "$0.00"; "-" for invalid input. */
export function formatSignedUsd(value: number | string | null | undefined): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed)) return "-";
  const sign = parsed > 0 ? "+" : parsed < 0 ? "-" : "";
  return `${sign}${USD_FORMATTER.format(Math.abs(parsed))}`;
}

/** "1.2M" / "950" for finite values; "-" for invalid input. */
export function formatCompactNumber(
  value: number | string | null | undefined,
): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(parsed);
}

/** "+1.23" / "-1.23" with optional suffix; "-" for invalid input. */
export function formatSignedNumber(
  value: number | string | null | undefined,
  suffix = "",
): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed)) return "-";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}${suffix}`;
}

/** Direction of a change value; the tone half of every gain/loss treatment. */
export type ChangeTone = "positive" | "negative" | "neutral";

/** Up / down / flat tone; non-finite input is flat, never a false direction. */
export function changeTone(
  value: number | string | null | undefined,
): ChangeTone {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed == null || !Number.isFinite(parsed) || parsed === 0) {
    return "neutral";
  }
  return parsed > 0 ? "positive" : "negative";
}

/**
 * A percent change as display text plus its tone, so components that render
 * change badges never re-derive direction from a formatted string.
 */
export function formatChangePct(value: number | string | null | undefined): {
  text: string;
  tone: ChangeTone;
} {
  return { text: formatSignedNumber(value, "%"), tone: changeTone(value) };
}

/**
 * Coerce a live-data value (Hyperliquid mids and quote prices arrive as
 * decimal strings) to a finite number, or null when absent or unparseable.
 *
 * Blank is checked before Number(): `Number("")` is 0, and a missing quote
 * must read as "no price", never as zero. Hoisted here because the ticker
 * and the watchlist had grown character-identical private copies, the same
 * drift class the M16 audit flagged for currency formatters.
 */
export function toFiniteNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}
