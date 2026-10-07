/**
 * Pure, dependency-free helpers for market research.
 *
 * These are split out from `market-research.ts` so they can be unit tested
 * without pulling in the app config/logger (which parse env at import time)
 * and without hitting the live network. `market-research.ts` imports and
 * uses these directly, so the tests exercise real production code.
 */

/**
 * Error carrying the HTTP status so callers can distinguish an SEC 403
 * (bad/missing User-Agent) from other transport failures.
 */
export class HttpError extends Error {
  status: number;

  constructor(status: number, statusText: string) {
    super(`${status} ${statusText}`);
    this.name = "HttpError";
    this.status = status;
  }
}

// Fallback contact details used only to keep the SEC User-Agent valid when
// the deployment has not configured SEC_USER_AGENT / SEC_CONTACT_EMAIL.
// These are non-personal project defaults, not a monitored inbox.
export const DEFAULT_SEC_WEB_URL = "https://readysettrade.app";
export const DEFAULT_SEC_CONTACT_EMAIL = "contact@readysettrade.app";

// Matches a bare email token such as "name@example.com" anywhere in a string.
const EMAIL_TOKEN_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** True when the given User-Agent already contains a contact email token. */
export function hasContactEmail(userAgent: string): boolean {
  return EMAIL_TOKEN_RE.test(userAgent);
}

/**
 * Build a User-Agent that ALWAYS contains a contact email, because SEC EDGAR
 * returns HTTP 403 for any request without one.
 *
 * - A configured User-Agent that already includes an email is used verbatim.
 * - A configured User-Agent missing an email gets one appended.
 * - With nothing configured, a sensible non-personal default is built.
 */
export function buildSecUserAgent(opts?: {
  userAgent?: string | null;
  contactEmail?: string | null;
  webUrl?: string | null;
}): string {
  const email = opts?.contactEmail?.trim() || DEFAULT_SEC_CONTACT_EMAIL;
  const site = opts?.webUrl?.trim() || DEFAULT_SEC_WEB_URL;
  const configured = opts?.userAgent?.trim();

  if (configured) {
    return hasContactEmail(configured) ? configured : `${configured} (mailto:${email})`;
  }

  return `readysettrade/1.0 (+${site}; mailto:${email})`;
}

/**
 * Known crypto / coin perp symbols. SEC EDGAR and GDELT equity news do not
 * cover these, so they are classified as "coin" and skip both providers.
 */
const KNOWN_COIN_SYMBOLS = new Set([
  "BTC",
  "ETH",
  "SOL",
  "HYPE",
  "XRP",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "MATIC",
  "DOT",
  "LTC",
  "BCH",
  "ATOM",
  "ARB",
  "OP",
  "APT",
  "SUI",
  "SEI",
  "TIA",
  "PEPE",
  "WIF",
  "BONK",
  "SHIB",
  "USDC",
  "USDT",
  "DAI",
  "BNB",
  "TRX",
  "NEAR",
  "INJ",
  "FTM",
  "RNDR",
  "IMX",
  "GRT",
  "AAVE",
  "UNI",
  "MKR",
  "CRV",
  "LDO",
  "ENA",
  "JUP",
  "PYTH",
  "JTO",
  "STRK",
  "BLUR",
  "ORDI",
  "TON",
  "KAS",
  "FET",
  "TAO",
  "RUNE",
  "GALA",
  "SAND",
  "MANA",
  "AXS",
  "FIL",
  "ETC",
  "ALGO",
  "STX",
  "HBAR",
]);

export type SymbolKind = "equity" | "coin";

export type SymbolClassification = {
  /**
   * "equity" -> research SEC/GDELT with `researchSymbol`.
   * "coin"   -> skip SEC/GDELT (crypto/perp market, filings are equity-only).
   */
  kind: SymbolKind;
  /** Upper-cased symbol after trimming and stripping any HL-style prefix. */
  researchSymbol: string;
  /** Original input, trimmed and upper-cased (prefix intact). */
  normalized: string;
  /** True when an HL-style "<prefix>:" segment was stripped. */
  strippedPrefix: boolean;
};

/**
 * Classify a chat symbol before touching SEC/GDELT (both equity-only).
 *
 * - HL-style perps are prefixed with a builder namespace and a colon, e.g.
 *   `xyz:GOOGL`. We strip the prefix and research the underlying (`GOOGL`).
 * - Pure crypto/coin perps (BTC, HYPE, `xyz:BTC`, HL 1000x `kPEPE`) have no
 *   SEC filings, so they are classified as "coin" and skipped.
 * - Everything else is treated as an equity to research.
 */
export function classifySymbol(rawSymbol: string): SymbolClassification {
  const normalized = rawSymbol.trim().toUpperCase();

  let core = normalized;
  let strippedPrefix = false;
  const colonIndex = core.lastIndexOf(":");
  if (colonIndex >= 0) {
    core = core.slice(colonIndex + 1).trim();
    strippedPrefix = true;
  }

  // HL prefixes 1000x meme perps with a lowercase "k" (kPEPE, kBONK); after
  // upper-casing that becomes a leading "K" we strip only for coin matching.
  const coinKey = core.replace(/^K(?=[A-Z])/, "");
  const kind: SymbolKind =
    KNOWN_COIN_SYMBOLS.has(core) || KNOWN_COIN_SYMBOLS.has(coinKey) ? "coin" : "equity";

  return { kind, researchSymbol: core, normalized, strippedPrefix };
}

/**
 * Map an SEC fetch failure to a user-facing warning. A 403 is a distinct,
 * diagnosable configuration problem (missing contact email in the
 * User-Agent); everything else is a generic transport error ("Could not...").
 */
export function describeSecFailure(error: unknown, phase: "index" | "filings"): string {
  if (error instanceof HttpError && error.status === 403) {
    return "SEC blocked the request (set SEC_USER_AGENT with a contact email).";
  }
  return phase === "index"
    ? "Could not query the SEC company ticker index."
    : "Could not fetch recent SEC filings.";
}

// Empty-result and informational notes are deliberately worded as "no results"
// or "unavailable", NEVER "Could not...", so the chat can tell an expected
// empty state (nothing to report) apart from a genuine transport error.

/** No matching SEC company for an equity-looking symbol (expected, empty). */
export function noCompanyMatchWarning(symbol: string): string {
  return `No SEC company match found for ${symbol}.`;
}

/** Company matched but had no recent interesting filings (expected, empty). */
export function noFilingsWarning(ticker: string): string {
  return `No recent SEC filings found for ${ticker}.`;
}

/** News query succeeded but returned nothing (expected, empty). */
export function noNewsWarning(label: string): string {
  return `No recent news found for ${label}.`;
}

/** News soft-failed (429 rate limit / timeout / transport). Informational. */
export function newsUnavailableWarning(label: string): string {
  return `Recent news is temporarily unavailable for ${label} (news provider rate limit or timeout).`;
}

/** Crypto/perp market: SEC filings and equity news do not exist. Non-alarming. */
export function coinMarketWarning(symbol: string): string {
  return `SEC filings and news are equity-only, so none are available for ${symbol} (crypto or perp market). Use signals and portfolio context instead.`;
}
