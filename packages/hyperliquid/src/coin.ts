/**
 * Canonical Hyperliquid coin naming (PURE, no I/O).
 *
 * ============================================================================
 *  REAL MONEY. The coin string decides WHICH MARKET an order hits.
 * ============================================================================
 *
 * `resolveAsset` / `updateLeverage` / `placeOrder` all look the coin up in the
 * asset cache by EXACT, case-sensitive match. Two consequences:
 *
 *   1. Case is meaningful. "KPEPE" is not an alias of "kPEPE", it is an unknown
 *      coin. Uppercasing a coin the way equity symbols are uppercased either
 *      throws or, worse, lands on a different listing.
 *   2. The "<dex>:" prefix is the route to a HIP-3 builder market. "xyz:GOOGL"
 *      and a bare "GOOGL" are DIFFERENT markets, so substituting one for the
 *      other is a wrong-market order, not a near miss.
 *
 * On the copy-trade auto-mirror path the coin arrives from untrusted external
 * JSON (the paste.trade board's `hl_ticker`), which makes it exactly the kind
 * of input the equity symbol is already schema-checked for. These helpers are
 * that check for perps.
 *
 * The parser NEVER changes case, never invents a dex prefix, and never repairs
 * a malformed value. It accepts or it rejects, because a rejected coin means a
 * skipped mirror (safe) while a guessed coin means a leveraged order on a
 * market nobody asked for (not safe).
 */

/**
 * Upper bound on the whole coin string, matching `perpCoinSchema` in
 * apps/api/src/lib/perp-orders.ts (the manual perp order path). Keep the two
 * in sync: they guard the same broker calls from opposite ends.
 */
const MAX_PERP_COIN_LENGTH = 20;

/**
 * A main-DEX coin ("BTC", "HYPE", "kPEPE") or a HIP-3 builder coin
 * ("<dex>:<name>", e.g. "xyz:GOOGL"). Alphanumerics only on both sides of the
 * separator, at most one separator, and neither side may be empty. Anything
 * else (whitespace, punctuation, a trailing colon, a second colon) is not a
 * coin Hyperliquid can resolve, so it is rejected rather than cleaned up.
 */
const CANONICAL_PERP_COIN_RE = /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/;

/**
 * Validate an untrusted value as a canonical Hyperliquid coin.
 *
 * Returns the coin with surrounding whitespace removed and its case PRESERVED,
 * or null when the value is absent, not a string, empty, over-long, or outside
 * the canonical charset. Callers must treat null as "skip this candidate", not
 * as "fall back to the ticker".
 */
export function parseCanonicalPerpCoin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PERP_COIN_LENGTH) return null;
  if (!CANONICAL_PERP_COIN_RE.test(trimmed)) return null;
  return trimmed;
}

/** Whether a value is already a canonical Hyperliquid coin (no normalization). */
export function isCanonicalPerpCoin(raw: unknown): boolean {
  return typeof raw === "string" && parseCanonicalPerpCoin(raw) === raw;
}
