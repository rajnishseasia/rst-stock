/**
 * The only client-side instrument classifier used by the manual copy surface.
 *
 * A perp-only field is authoritative even when the rest of the row is missing:
 * treating a partial perp row as an equity can turn a colliding ticker into an
 * Alpaca order. An absent asset type remains the legacy plain-equity signal
 * shape; an explicit but unfamiliar asset type is unknown and fails closed.
 */

export type CopyTradeInstrument = "equity" | "option" | "perp" | "unknown";

const PERP_MARKER_KEYS = [
  "perpVenue",
  "perpCoin",
  "perpDirection",
  "perpReduceOnly",
  "perpLeverage",
] as const;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readAssetType(meta: Record<string, unknown> | null | undefined): string | null {
  return typeof meta?.assetType === "string" && meta.assetType.trim()
    ? meta.assetType.trim().toUpperCase()
    : null;
}

/** Perp metadata is a discriminator, not optional decoration. */
export function hasCopyTradePerpMarker(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return !!meta && PERP_MARKER_KEYS.some((key) => hasOwn(meta, key));
}

export function classifyCopyTradeInstrument(
  meta: Record<string, unknown> | null | undefined,
): CopyTradeInstrument {
  if (hasCopyTradePerpMarker(meta)) return "perp";

  const assetType = readAssetType(meta);
  if (assetType === "PERP") return "perp";
  if (assetType === "OPTION") return "option";
  if (assetType === "EQUITY" || !hasOwn(meta ?? {}, "assetType")) return "equity";
  return "unknown";
}
