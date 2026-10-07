import { parseOptionSignal } from "./option-signal-parser.js";

export type XCallDirection = "bullish" | "bearish" | "unknown";

export interface DeriveXCallDirectionInput {
  content: string | null | undefined;
  symbol: string;
  referenceDate?: Date | string | null;
  metadata?: unknown;
}

export function deriveXCallDirection(
  input: DeriveXCallDirectionInput,
): XCallDirection {
  const structuredDirection = directionFromMetadata(input.metadata);
  if (structuredDirection) return structuredDirection;

  const symbol = normalizeSymbol(input.symbol);
  const content = input.content?.trim();
  if (!symbol || !content) return "unknown";

  const clause = tickerClauses(content, symbol).join(" ").trim();
  if (!clause) return "unknown";

  const option = parseOptionSignal(clause, {
    symbolHint: symbol,
    referenceDate: input.referenceDate,
  });
  if (option.kind === "option") {
    if (option.option.tradeAction !== "BuyToOpen") return "unknown";
    return option.option.optionType === "PUT" ? "bearish" : "bullish";
  }
  // Option-like prose that is unsupported or missing a safe action must not
  // fall through to the ordinary word matcher. A stray "put" or "call" is
  // not evidence of a stock direction.
  if (option.kind !== "none") return "unknown";

  if (SHORT_COVER_EXIT_RE.test(clause) || EXIT_LANGUAGE_RE.test(clause)) return "unknown";
  const explicitBearishEntry = /\b(?:SELL|SOLD|SELLING)[\s_-]+(?:SHORT|TO[\s_-]+OPEN)\b/i.test(clause);
  if (BARE_SELL_EXIT_RE.test(clause) && !explicitBearishEntry) return "unknown";

  const context = neutralDirectionContext(clause);
  const bullish = BULLISH_LANGUAGE_RE.test(context);
  const bearish = BEARISH_LANGUAGE_RE.test(context);
  // Explicit author intent wins over soft market context such as a short
  // squeeze. Conflicting explicit intent remains ambiguous by design.
  if (bullish && bearish) return "unknown";
  if (bullish) return "bullish";
  if (bearish) return "bearish";
  return SHORT_SQUEEZE_RE.test(clause) ? "bullish" : "unknown";
}

const BULLISH_LANGUAGE_RE = /\b(?:BUY|BUYING|BOUGHT|LONG|LONGS|BULL|BULLISH|CALL|CALLS)\b/i;
const BEARISH_LANGUAGE_RE = /\b(?:SELL|SELLING|SOLD|SHORT|SHORTS|SHORTED|SHORTING|BEAR|BEARISH|PUT|PUTS)\b/i;
const SHORT_COVER_EXIT_RE =
  /\b(?:(?:BUY|BUYING|BOUGHT)[\s_-]+TO[\s_-]+COVER|(?:BUY|BUYING|BOUGHT)[\s_-]*BACK)\b|\bCOVER(?:ING)?[\s_-]+(?:(?:MY|OUR|THE|A|AN)[\s_-]+)?(?:\$?[A-Z][A-Z0-9:]{0,20})(?:['\u2019]S)?[\s_-]+SHORTS?(?:[\s_-]+POSITION)?\b|\bCOVER(?:ING)?[\s_-]+(?:(?:MY|OUR|THE|A|AN)[\s_-]+)?SHORTS?(?:[\s_-]+POSITION)?[\s_-]+(?:(?:IN|ON)[\s_-]+)?(?:\$?[A-Z][A-Z0-9:]{0,20})(?:['\u2019]S)?\b/i;
const EXIT_LANGUAGE_RE =
  /\b(?:STC|SELL\s+TO\s+CLOSE|CLOSE|CLOSED|CLOSING|TRIM|TRIMMED|TRIMMING|TAKE\s+PROFIT|TAKING\s+PROFIT)\b/i;
const BARE_SELL_EXIT_RE = /\b(?:SELL|SOLD|SELLING)\b/i;

const SHORT_SQUEEZE_RE = /\bshort[\s-]*squeez\w*/i;

/** Remove context words before evaluating explicit position intent. */
function neutralDirectionContext(clause: string): string {
  return clause
    .replace(SHORT_SQUEEZE_RE, " ")
    .replace(/\bshort[\s-]*(?:interest|term|float|ratio)\b/gi, " ")
    .replace(/\bsell[\s-]*off\b/gi, " ")
    .replace(/\bshorts?\s+(?:are\s+)?(?:covering|trapped|squeezed)\b/gi, " ");
}

function directionFromMetadata(metadata: unknown): XCallDirection | null {
  let parsed = metadata;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const raw = (parsed as Record<string, unknown>).direction;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["long", "buy", "bull", "bullish"].includes(normalized)) return "bullish";
  if (["short", "sell", "bear", "bearish"].includes(normalized)) return "bearish";
  return null;
}

function normalizeSymbol(raw: string): string | null {
  const normalized = raw.replace(/^\$/, "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9:]{0,20}$/.test(normalized) ? normalized : null;
}

function tickerClauses(content: string, symbol: string): string[] {
  const candidates = [symbol, symbol.slice(symbol.lastIndexOf(":") + 1)];
  const ticker = new RegExp(
    `(?:^|[^A-Z0-9])\\$?(?:${candidates.map(escapeRegExp).join("|")})(?![A-Z0-9])`,
    "i",
  );
  const parts = content.split(/[,;|\n]+/);
  const matchingParts = parts
    .map((part, index) => ({ part: part.trim(), index }))
    .filter(({ part }) => ticker.test(part));
  if (matchingParts.length === 0) return [];

  // Preserve prose before the first ticker and a continuation such as
  // "short squeeze, but I am short" when this is the only dollar ticker.
  const dollarTickers = [...content.matchAll(/\$[A-Z][A-Z0-9:]{0,20}/gi)].map(
    (match) => match[0].slice(1).toUpperCase(),
  );
  const targetDollarCount = dollarTickers.filter((candidate) =>
    candidates.includes(candidate),
  ).length;
  const canExtendSingleTicker =
    dollarTickers.length > 0 &&
    targetDollarCount === 1 &&
    dollarTickers.length === targetDollarCount;

  return matchingParts.map(({ part, index }) =>
    canExtendSingleTicker ? parts.slice(index).join(" ").trim() : part,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
