/**
 * Pure copy-eligibility helper for the copy-trade feed (no React, no IO).
 *
 * The API marks paste.trade-style perp / derivative / short signals with
 * `meta.mirrorableEquity === false` (plus `platform` / `instrument` /
 * `direction`) via classifySignalInstrument (see mapSignalToItem in
 * apps/api/src/routers/copy-trade.ts). The auto-mirror worker already skips
 * those rows; this helper is the feed-side reader so a manual Copy cannot
 * prefill an Alpaca EQUITY ticket from, say, a "GOOGL 20x short perp on
 * Hyperliquid" call.
 *
 * Shared user trades carry no such classification: they are broker fills, so the
 * venue is `meta.assetType` ("PERP" for a Hyperliquid fill). That is checked
 * directly, because a gate that trusts only a mapper-set flag cannot protect a
 * row whose mapper never set one.
 *
 * Manual Copy is buy-only. Sell rows remain visible as source activity, while
 * guarded auto-mirror exits are handled separately by the worker.
 *
 * This module answers exactly one question: may this row prefill an EQUITY or
 * OPTION Alpaca ticket? A PERP row is refused here unconditionally, on
 * `meta.assetType` or any perp-only marker, even if other metadata is missing.
 * The sibling question -
 * "can this SAME perp row instead prefill the PERP ticket?" - is decided
 * independently by `copy-perp-route.ts`, which this file never imports or
 * defers to. Do not loosen the PERP branch below to "make room" for that
 * route; the two are wired into two different buttons/handlers in
 * copy-trade-panel.tsx, and this function stays the reason a perp row can
 * never reach the equity one.
 */

import { classifyCopyTradeInstrument } from "./copy-trade-instrument";

/** Read a trimmed non-empty string meta field, or null. */
function readMetaString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The reason the manual Copy action is disabled, or null when it is safe to
 * prefill. Instrument metadata explains unsupported calls; side enforces the
 * buy-only manual policy.
 */
export function copyDisabledReason(
  meta: Record<string, unknown> | null | undefined,
  side?: "buy" | "sell",
): string | null {
  const instrument = classifyCopyTradeInstrument(meta);

  // Checked ahead of the flag so the reason names the venue whenever the row is
  // a perp, and so the gate holds even for a perp row that carries no flag. A
  // perp ticker can also be a real Alpaca listing (SOL is ReneSola, APT collides
  // too), so copying one as a stock order buys an unrelated company with no
  // leverage and no short side, not a near miss.
  if (instrument === "perp") {
    return "This trade is a Hyperliquid perp, not a stock; it cannot be copied as a stock order.";
  }

  if (instrument === "unknown") {
    return "This trade's instrument could not be confirmed; it cannot be copied as a stock order.";
  }

  if (meta?.mirrorableEquity === false) {
    const platform = readMetaString(meta.platform);
    const instrument = readMetaString(meta.instrument);
    const direction = readMetaString(meta.direction);

    const descriptor = [platform, instrument].filter(Boolean).join(" ");
    const labeled = descriptor
      ? direction
        ? `${descriptor} (${direction})`
        : descriptor
      : direction;

    if (!labeled) {
      return "This call is not a plain stock trade; it cannot be copied as a stock order.";
    }
    return `This call is a ${labeled}; it cannot be copied as a stock order.`;
  }

  if (side === "sell") {
    return "Sell transactions are shown for context. Manual Copy is buy-only; auto-mirror can only sell to reduce an existing long position.";
  }

  return null;
}
