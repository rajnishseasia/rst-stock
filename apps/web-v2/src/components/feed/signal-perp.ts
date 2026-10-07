/**
 * Pure mapping from a signal's stored metadata to a PERP-copy payload (no React,
 * no IO). paste.trade / Hyperliquid rows carry venue / instrument / direction /
 * leverage / hlTicker metadata; a "GOOGL 20x short perp" call must open the PERP
 * trade form (coin + long/short + leverage), never the equity ticket.
 *
 * The perp-vs-equity + long/short decision REUSES the shared
 * `classifySignalInstrument` classifier (packages/utils) so the feed, the api,
 * and the mirror worker all agree on what counts as a perp; this module only
 * adds the two scalar fields the classifier does not carry (leverage, hlTicker)
 * and shapes the copy payload. Rows that are not perps return null, so the
 * caller keeps the existing equity-copy behavior untouched; a perp row whose
 * coin cannot be named returns null too, and `groupFeedSignals` is what stops
 * that second case from falling through to an equity chip.
 */

import { classifySignalInstrument } from "@trade-bot/utils/utils/signal-instrument";

/** Direction of a perp call. */
export type PerpSignalSide = "long" | "short";

/** The prefill a perp "Copy" produces: which coin, which side, and (if the call
 * specified one) the leverage to seed the perp form's slider with. */
export interface PerpCopyPayload {
  /** The call's canonical `hlTicker`, verbatim: HL's own spelling of the market. */
  coin: string;
  side: PerpSignalSide;
  /** Leverage from the call, omitted when the call did not specify one. */
  leverage?: number;
}

/** Parse a (possibly stringified) jsonb metadata blob into a plain record, or null. */
function toRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read a leverage value (number or numeric string) as a positive integer, or null. */
function parseLeverage(raw: unknown): number | null {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/** Read a trimmed non-empty string field, or null. */
function readString(meta: Record<string, unknown> | null, key: string): string | null {
  const raw = meta?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Canonical Hyperliquid coin form: a main-DEX coin ("BTC", "kPEPE") or a HIP-3
 * builder route ("<dex>:<name>", e.g. "xyz:GOOGL"). Alphanumerics only on both
 * sides of at most one separator, and bounded by the same 20 chars the perp
 * order procedures accept.
 *
 * These two lines restate `parseCanonicalPerpCoin`
 * (packages/hyperliquid/src/coin.ts), which is the source of truth. They are
 * restated rather than imported because `@trade-bot/hyperliquid` is a
 * server-side package (Privy signer, exchange transports) and this module is
 * part of the browser bundle. The watchlist router and copy-perp-route.ts (the
 * shared-user-trade perp copy path, which imports `canonicalPerpCoinString`
 * below rather than adding a fourth copy of the regex) duplicate the same rule
 * for the same reason. Keep all in sync.
 */
const MAX_PERP_COIN_LENGTH = 20;
const CANONICAL_PERP_COIN_RE = /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/;

/**
 * Validate an arbitrary string as a canonical Hyperliquid coin, with no lookup
 * key attached (see `canonicalPerpCoin` below for the `meta.hlTicker` reader).
 * Case is PRESERVED and nothing is repaired: "KPEPE" is not an alias of
 * "kPEPE" (it is an unknown coin), and "xyz-GOOGL" is not a route to
 * "xyz:GOOGL". A value this rejects means "no coin", never "try something
 * else". Exported so any caller validating a server-supplied coin string
 * (copy-perp-route.ts) shares this exact rule instead of restating it.
 */
export function canonicalPerpCoinString(raw: string | null): string | null {
  if (raw === null || raw.length > MAX_PERP_COIN_LENGTH) return null;
  return CANONICAL_PERP_COIN_RE.test(raw) ? raw : null;
}

/**
 * The stored `hlTicker` when it names a market Hyperliquid can resolve, else
 * null.
 */
function canonicalPerpCoin(meta: Record<string, unknown> | null): string | null {
  return canonicalPerpCoinString(readString(meta, "hlTicker"));
}

/**
 * Whether a signal (by its metadata) is a PERP call: a perp/derivatives venue
 * (Hyperliquid, dYdX, ...) OR a perp/derivative instrument. A plain SHORT equity
 * (short direction with no perp venue/instrument) is NOT a perp and returns
 * false, so it stays on the equity path. Delegates entirely to the shared
 * classifier.
 */
export function isPerpSignal(metadata: unknown): boolean {
  const c = classifySignalInstrument(metadata);
  return c.perpVenue || c.perpInstrument;
}

/**
 * Build the perp-copy payload for a signal, or null when no perp copy may be
 * offered (the row is not a perp, or it is a perp whose coin we cannot name).
 * Side comes from the shared classifier's short flag; the leverage is included
 * only when the call specified one.
 *
 * The coin comes from the call's canonical `hlTicker` and from NOWHERE else,
 * which is why this takes no ticker argument. `signals.symbol` is the EQUITY
 * symbol the pollers uppercase at ingest, and that charset cannot express
 * either form Hyperliquid actually trades: it renders "kPEPE" as the unknown
 * coin "KPEPE", and it renders a HIP-3 market ("xyz:GOOGL") as its bare
 * underlying "GOOGL", which is a DIFFERENT, main-DEX market. A perp Copy seeds
 * a LEVERAGED order ticket, so a guessed coin is a guess at which market to
 * lever up. The mirror worker refuses these same rows (skip:
 * unusable-perp-coin, copy-mirror-candidate-sources.ts) and the manual path
 * must agree with it: no coin means no perp copy, which is the safe outcome.
 *
 * `hlTicker` is null whenever upstream sent a missing or non-canonical value
 * (paste-trade-poller.ts validates it at ingest), so this is a reachable state,
 * not defensive dead code.
 */
export function perpCopyPayload(metadata: unknown): PerpCopyPayload | null {
  const c = classifySignalInstrument(metadata);
  if (!c.perpVenue && !c.perpInstrument) return null;

  const meta = toRecord(metadata);
  const coin = canonicalPerpCoin(meta);
  if (!coin) return null;

  const leverage = parseLeverage(meta?.leverage);
  const side: PerpSignalSide = c.short ? "short" : "long";
  return leverage != null ? { coin, side, leverage } : { coin, side };
}

/**
 * Compact human label for the direction/leverage badge, e.g. "20x Short",
 * "3x Long", or just "Long" when the call carried no leverage.
 */
export function perpBadgeLabel(side: PerpSignalSide, leverage?: number): string {
  const direction = side === "short" ? "Short" : "Long";
  return leverage && leverage > 0 ? `${leverage}x ${direction}` : direction;
}

/** Minimal shape of the feed selection the equity ticket reads. */
export interface EquitySignalLinkInput {
  symbol?: string | null;
  signalId?: string | null;
  venue?: "stocks" | "perps";
}

/**
 * The signal id an EQUITY order may be linked to, or undefined when the current
 * selection does not belong to this equity ticket.
 *
 * Requires BOTH conditions, and the venue check is the load-bearing one:
 *
 *  1. The selection is not a perp copy. A perp Copy populates the same
 *     selection state (it drives the feed's selection ring), and symbols are NOT
 *     sufficient to tell the venues apart because tickers collide across them:
 *     SOL is Solana on Hyperliquid and ReneSola on Nasdaq, APT is Aptos and
 *     Alpha Pro Tech. Comparing symbols alone would attach a perp signal's id to
 *     an equity order on the colliding ticker, corrupting the order's provenance
 *     (wrong "mark signal TRADED" target, wrong social / leaderboard credit).
 *  2. The selection is for the symbol currently on the ticket, so a stale
 *     selection does not follow the user to a different equity.
 */
export function equityOrderSignalId(
  selected: EquitySignalLinkInput | null | undefined,
  activeSymbol: string | null | undefined,
): string | undefined {
  if (!selected?.signalId) return undefined;
  if (selected.venue === "perps") return undefined;
  const selectedSymbol = selected.symbol?.trim().toUpperCase();
  const ticketSymbol = activeSymbol?.trim().toUpperCase();
  if (!selectedSymbol || !ticketSymbol) return undefined;
  if (selectedSymbol !== ticketSymbol) return undefined;
  return selected.signalId;
}
