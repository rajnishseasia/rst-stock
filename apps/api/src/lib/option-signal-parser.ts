export type ParsedOptionTradeAction = "BuyToOpen" | "SellToClose";
export type ParsedOptionType = "CALL" | "PUT";

export interface ParsedOptionSignal {
  assetType: "OPTION";
  symbol: string;
  side: "buy" | "sell";
  tradeAction: ParsedOptionTradeAction;
  optionExpiration: string;
  optionStrike: number;
  optionType: ParsedOptionType;
}

export type OptionSignalParseResult =
  | { kind: "option"; option: ParsedOptionSignal }
  | { kind: "none" }
  | {
      kind: "unsupported";
      reason:
        | "ambiguous-contract"
        | "expired-contract"
        | "missing-contract"
        | "missing-safe-action"
        | "unsupported-action"
        | "underlying-mismatch";
    };

interface ParseOptionSignalOptions {
  symbolHint?: string | null;
  referenceDate?: Date | string | null;
}

const UNSUPPORTED_MULTI_LEG_RE =
  /\b(spread|vertical|debit|credit|straddle|strangle|calendar|butterfly|condor|iron\s+condor|roll)\b/i;

const UNSUPPORTED_ACTION_RE = /\b(STO|BTC|SELL\s+TO\s+OPEN|BUY\s+TO\s+CLOSE|SHORT(?:ING)?)\b/i;
const BUY_TO_OPEN_RE = /\b(BTO|BUY\s+TO\s+OPEN)\b/i;
const SELL_TO_CLOSE_RE = /\b(STC|SELL\s+TO\s+CLOSE)\b/i;

const OPTION_LANGUAGE_RE = /\b(CALLS?|PUTS?|OPTIONS?|CONTRACTS?|BTO|STC|STO|BTC)\b/i;
const STRIKE_TYPE_RE = /\b(\d+(?:\.\d{1,4})?)\s*(C|P|CALLS?|PUTS?)\b/gi;
const SLASH_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g;
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;

const NON_SYMBOL_WORDS = new Set([
  "ADD",
  "ADDING",
  "BOUGHT",
  "BTC",
  "BTO",
  "BUY",
  "BUYING",
  "CALL",
  "CALLS",
  "CONTRACT",
  "CONTRACTS",
  "LONG",
  "OPTION",
  "OPTIONS",
  "PUT",
  "PUTS",
  "SELL",
  "SHORT",
  "STC",
  "STO",
  "TO",
]);

function normalizeSymbol(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const normalized = symbol.replace(/^\$/, "").trim().toUpperCase();
  return /^[A-Z]{1,6}$/.test(normalized) ? normalized : null;
}

function referenceDateOnly(referenceDate: Date | string | null | undefined): Date {
  const raw = referenceDate ? new Date(referenceDate) : new Date();
  const d = Number.isNaN(raw.getTime()) ? new Date() : raw;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatYYMMDD(date: Date): string {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildExpiration(
  month: number,
  day: number,
  yearRaw: string | undefined,
  reference: Date,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let year: number;
  if (yearRaw) {
    const parsed = Number(yearRaw);
    if (!Number.isFinite(parsed)) return null;
    year = yearRaw.length === 2 ? 2000 + parsed : parsed;
  } else {
    year = reference.getUTCFullYear();
  }

  let d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }

  if (!yearRaw && d < reference) {
    d = new Date(Date.UTC(year + 1, month - 1, day));
  }

  if (d < reference) return null;
  return formatYYMMDD(d);
}

function dateMatches(text: string, reference: Date): string[] {
  const expirations: string[] = [];

  for (const m of text.matchAll(ISO_DATE_RE)) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const expiration = buildExpiration(month, day, String(year), reference);
    if (expiration) expirations.push(expiration);
  }

  for (const m of text.matchAll(SLASH_DATE_RE)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const expiration = buildExpiration(month, day, m[3], reference);
    if (expiration) expirations.push(expiration);
  }

  return [...new Set(expirations)];
}

function strikeTypeMatches(text: string): { strike: number; type: ParsedOptionType }[] {
  const out: { strike: number; type: ParsedOptionType }[] = [];
  for (const m of text.matchAll(STRIKE_TYPE_RE)) {
    const strike = Number(m[1]);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const typeToken = m[2]!.toUpperCase();
    out.push({
      strike,
      type: typeToken.startsWith("P") ? "PUT" : "CALL",
    });
  }
  return out;
}

function inferExplicitUnderlyings(text: string, allowLooseMatch: boolean): string[] {
  const candidates = new Set<string>();
  const addCandidate = (raw: string | null | undefined) => {
    const token = normalizeSymbol(raw);
    if (token && !NON_SYMBOL_WORDS.has(token)) candidates.add(token);
  };

  for (const m of text.matchAll(/\$([A-Z]{1,6})\b/g)) {
    addCandidate(m[1]);
  }

  for (const m of text.matchAll(
    /\b(?:BTO|STC|BUY\s+TO\s+OPEN|SELL\s+TO\s+CLOSE)\s+\$?([A-Z]{1,6})\b/g,
  )) {
    addCandidate(m[1]);
  }

  for (const m of text.matchAll(
    /\b([A-Z]{1,6})\s+(?=\d+(?:\.\d{1,4})?\s*(?:C|P|CALLS?|PUTS?)\b)/g,
  )) {
    addCandidate(m[1]);
  }

  if (candidates.size > 0 || !allowLooseMatch) return [...candidates];

  for (const m of text.matchAll(/\b([A-Z]{1,6})\b/g)) {
    const token = normalizeSymbol(m[1]);
    if (token && !NON_SYMBOL_WORDS.has(token)) return [token];
  }

  return [];
}

function hasOptionLanguage(text: string): boolean {
  return OPTION_LANGUAGE_RE.test(text) || strikeTypeMatches(text).length > 0;
}

function safeAction(text: string): ParsedOptionTradeAction | null | "unsupported" {
  if (UNSUPPORTED_ACTION_RE.test(text)) return "unsupported";
  const isBuyToOpen = BUY_TO_OPEN_RE.test(text);
  const isSellToClose = SELL_TO_CLOSE_RE.test(text);
  if (isBuyToOpen && isSellToClose) return "unsupported";
  if (isSellToClose) return "SellToClose";
  if (isBuyToOpen) return "BuyToOpen";
  return null;
}

export function parseOptionSignal(
  content: string | null | undefined,
  options: ParseOptionSignalOptions = {},
): OptionSignalParseResult {
  const text = (content ?? "").trim();
  if (!text) return { kind: "none" };

  if (UNSUPPORTED_MULTI_LEG_RE.test(text)) {
    return { kind: "unsupported", reason: "unsupported-action" };
  }

  const reference = referenceDateOnly(options.referenceDate);
  const symbolHint = normalizeSymbol(options.symbolHint);
  const upper = text.toUpperCase();
  const strikes = strikeTypeMatches(upper);
  const expirations = dateMatches(upper, reference);

  if (strikes.length === 0 && expirations.length === 0 && !hasOptionLanguage(upper)) {
    return { kind: "none" };
  }

  if (strikes.length !== 1 || expirations.length !== 1) {
    return {
      kind: "unsupported",
      reason: strikes.length > 1 || expirations.length > 1 ? "ambiguous-contract" : "missing-contract",
    };
  }

  const action = safeAction(upper);
  if (action === "unsupported") {
    return { kind: "unsupported", reason: "unsupported-action" };
  }
  if (!action) {
    return { kind: "unsupported", reason: "missing-safe-action" };
  }

  const explicitUnderlyings = inferExplicitUnderlyings(upper, !symbolHint);
  if (explicitUnderlyings.length > 1) {
    return { kind: "unsupported", reason: "underlying-mismatch" };
  }
  const explicitUnderlying = explicitUnderlyings[0] ?? null;
  if (symbolHint && explicitUnderlying && explicitUnderlying !== symbolHint) {
    return { kind: "unsupported", reason: "underlying-mismatch" };
  }
  const inferred = explicitUnderlying ?? symbolHint;
  if (!inferred) return { kind: "unsupported", reason: "missing-contract" };

  const { strike, type } = strikes[0]!;
  const expiration = expirations[0]!;

  return {
    kind: "option",
    option: {
      assetType: "OPTION",
      symbol: inferred,
      side: action === "SellToClose" ? "sell" : "buy",
      tradeAction: action,
      optionExpiration: expiration,
      optionStrike: strike,
      optionType: type,
    },
  };
}
