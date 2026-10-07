/**
 * Price formatting for the feed's equity ticker chips. Extracted from
 * signal-feed.tsx (audit H7 + M16): the chip used to build its own
 * `Intl.NumberFormat`, which is a third un-sanctioned currency formatter. These
 * delegate to the shared helpers in lib/format and only add the feed's own rule:
 * a chip with no usable price renders no price pill at all.
 */

import { formatSignedNumber, formatUsd } from "@/lib/format";

/** Price tone for a chip's change value. */
export type SignalChangeTone = "positive" | "negative" | "neutral";

/**
 * Chip price, or null when the quote is missing / non-positive. Null means "do
 * not render a price pill": a zero-valued placeholder quote (how the batch
 * endpoint represents a failed snapshot lookup) is not a price.
 */
export function formatSignalChipPrice(
  value: string | number | null | undefined,
): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return formatUsd(parsed);
}

/** Signed percent change like "+1.25%" / "-0.40%"; empty when unavailable. */
export function formatSignalChipChange(
  value: string | number | null | undefined,
): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  return formatSignedNumber(parsed, "%");
}

/** Up / down / flat tone for a chip's absolute change value. */
export function signalChangeTone(
  value: string | number | null | undefined,
): SignalChangeTone {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed === 0) return "neutral";
  return parsed > 0 ? "positive" : "negative";
}
