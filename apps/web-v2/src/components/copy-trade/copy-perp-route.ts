/**
 * Pure routing decision for copying a shared PERP trade row onto the PERP
 * ticket (no React, no IO).
 *
 * `mapUserTradeToItem` (apps/api/src/routers/copy-trade.ts) marks every
 * Hyperliquid perp fill with `meta.mirrorableEquity = false`, and
 * `copyDisabledReason` (copy-eligibility.ts) vetoes it UNCONDITIONALLY for the
 * equity route, keyed on `meta.assetType === "PERP"` alone. That veto is left
 * completely untouched by this module - it is the only thing standing between
 * a user and an Alpaca order for the wrong company (SOL is ReneSola on Nasdaq,
 * APT collides too), and it stays in force for every perp row regardless of
 * what this module decides.
 *
 * This module answers a SECOND, independent question about the SAME row: can
 * it be copied onto the PERP ticket instead? It returns non-null ONLY when
 * `meta.assetType === "PERP"`, so it can never redirect an equity/option row
 * into perp routing, and a bug here that fails to recognize a genuine perp row
 * (returns null when it shouldn't) still leaves that row on the untouched
 * equity veto above - it does not fall through to an enabled equity Copy.
 *
 * The coin, direction, leverage and reduce-only flag all come from the server
 * mapper's `perpCoin` / `perpDirection` / `perpLeverage` / `perpReduceOnly`
 * fields (added alongside `mirrorableEquity`), never reconstructed from
 * `item.symbol` - an uppercased DISPLAY string that cannot express HL's
 * case-sensitive coin spelling ("kPEPE" becomes the unknown coin "KPEPE") or a
 * HIP-3 route ("xyz:GOOGL" becomes the bare, DIFFERENT market "GOOGL").
 * signal-perp.ts documents this same failure mode at length for the X-signal
 * perp-copy path; this module makes the identical argument for shared-user-
 * trade rows and reuses its coin validator rather than re-deriving anything.
 */

import { canonicalPerpCoinString } from "../feed/signal-perp";
import { classifyCopyTradeInstrument } from "./copy-trade-instrument";

/** Direction of a perp copy - matches signal-perp.ts's PerpSignalSide. */
export type PerpTradeRowSide = "long" | "short";

/** The perp-copy prefill: which coin, which side, and leverage if known. */
export interface PerpTradeRowCopy {
  kind: "perp";
  /** HL's canonical spelling, verbatim - never uppercased or repaired. */
  coin: string;
  side: PerpTradeRowSide;
  /** Omitted (never defaulted to 1) when the row carries no leverage. */
  leverage?: number;
}

/** A PERP row that cannot be copied onto the perp ticket, with why. */
export interface PerpTradeRowRefusal {
  kind: "refused";
  reason: string;
  /**
   * Canonical market when the row is valid but this deployment cannot open a
   * perp ticket. Keeping it prevents the ticker click from falling through to
   * the equity venue for colliding symbols such as BTC or GOOGL.
   */
  coin?: string;
}

/**
 * The perp-route decision for a feed row's meta:
 *   - null: not a perp row at all - the equity path is untouched.
 *   - { kind: "refused", reason }: a perp row that cannot be copied as a perp.
 *   - { kind: "perp", coin, side, leverage? }: safe to prefill the perp ticket.
 */
export type PerpTradeRowRoute = PerpTradeRowCopy | PerpTradeRowRefusal | null;

/** Read a trimmed non-empty string meta field, or null. */
function readMetaString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Decide the perp-copy route for a shared-user-trade feed row's `meta`.
 *
 * Refuses, in this order, so the tooltip names the FIRST reason that applies:
 *   1. not a perp row at all (returns null, not a refusal - the equity path
 *      continues exactly as it does today);
 *   2. the row's venue isn't confirmed Hyperliquid (a missed orders join fails
 *      closed to `perpVenue: null` server-side, which lands here too);
 *   3. the coin is absent or not HL-resolvable;
 *   4. the direction is absent (also fails closed on a missed join);
 *   5. the row is reduce-only, i.e. it CLOSES a position rather than opening
 *      one. Copying a close as an open would create exposure the source
 *      trader was removing, and the copier may hold no position to close
 *      against in the first place - a reduce-only order in that case is a
 *      rejection or a no-op, not the trade the button promised. Refused in
 *      BOTH directions, not just for a "sell" row: a `side: "buy"` row can
 *      just as well be the close of a short.
 *   6. perps aren't enabled on this deployment (no perp ticket exists to open).
 *
 * The entry/exit discriminator is `perpReduceOnly`, not buy/sell: a perp OPEN
 * is copyable in either direction (long or short), matching the X-signal perp
 * chip (`perpCopyPayload`), which already copies shorts. Manual equity Copy
 * stays buy-only (`copyDisabledReason`); that policy is specific to Alpaca
 * equities and is not extended here.
 */
export function perpCopyFromTradeRow(
  meta: Record<string, unknown> | null | undefined,
  options: { perpsEnabled: boolean },
): PerpTradeRowRoute {
  if (classifyCopyTradeInstrument(meta) !== "perp") return null;

  if (readMetaString(meta?.perpVenue) !== "hyperliquid") {
    return {
      kind: "refused",
      reason: "This perp fill has no confirmed Hyperliquid venue; it cannot be copied.",
    };
  }

  const coin = canonicalPerpCoinString(readMetaString(meta?.perpCoin));
  if (!coin) {
    return {
      kind: "refused",
      reason: "This perp fill's market couldn't be identified; it cannot be copied.",
    };
  }

  const direction = meta?.perpDirection;
  if (direction !== "long" && direction !== "short") {
    return {
      kind: "refused",
      reason: "This perp fill has no confirmed direction; it cannot be copied.",
      coin,
    };
  }

  if (meta?.perpReduceOnly !== false) {
    return {
      kind: "refused",
      reason:
        "This trade closes a position rather than opening one; copying it as a new order isn't supported.",
      coin,
    };
  }

  if (!options.perpsEnabled) {
    return {
      kind: "refused",
      reason: "Perps trading isn't enabled on this deployment.",
      coin,
    };
  }

  const rawLeverage = meta?.perpLeverage;
  const leverage =
    typeof rawLeverage === "number" && Number.isFinite(rawLeverage) && rawLeverage > 0
      ? rawLeverage
      : undefined;

  return leverage !== undefined
    ? { kind: "perp", coin, side: direction, leverage }
    : { kind: "perp", coin, side: direction };
}
