import { canonicalPerpCoinString } from "../feed/signal-perp";
import { classifyCopyTradeInstrument } from "./copy-trade-instrument";

/** Maximum number of stock symbols sent to the batched Alpaca quote query. */
export const MAX_COPY_TRADE_STOCK_QUOTES = 30;

/** Minimal feed-row shape needed to select a venue-correct quote source. */
export interface CopyTradeQuoteItem {
  symbol: string;
  meta: Record<string, unknown> | null | undefined;
}

/** Venue identity used by the copy-trade quote and display paths. */
export type CopyTradeQuoteIdentity =
  | { venue: "stocks"; symbol: string }
  | { venue: "perps"; coin: string | null }
  | { venue: "unknown"; symbol: string };

/** Structural subset of the Hyperliquid market-stats response used by Copy. */
export interface CopyTradePerpQuote {
  coin: string;
  markPx: string | null;
  prevDayPx: string | null;
}

/** Read a trimmed non-empty metadata string, or null. */
function readMetaString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve a feed row to its quote venue without repairing any perp metadata.
 * Invalid perp identity remains a perp with a null coin, which prevents the
 * display path from looking up the row as an equity ticker.
 */
export function copyTradeQuoteIdentity(item: CopyTradeQuoteItem): CopyTradeQuoteIdentity {
  const instrument = classifyCopyTradeInstrument(item.meta);
  if (instrument === "unknown") {
    return { venue: "unknown", symbol: item.symbol.toUpperCase() };
  }
  if (instrument !== "perp") {
    return { venue: "stocks", symbol: item.symbol.toUpperCase() };
  }

  const venue = readMetaString(item.meta?.perpVenue);
  const coin =
    venue === "hyperliquid"
      ? canonicalPerpCoinString(readMetaString(item.meta?.perpCoin))
      : null;
  return { venue: "perps", coin };
}

/**
 * Split visible Copy rows into the stock symbols Alpaca should quote and the
 * canonical perp coins covered by the Hyperliquid market-stats query.
 */
export function selectCopyTradeQuoteInputs(
  items: readonly CopyTradeQuoteItem[],
  maxStockQuotes: number = MAX_COPY_TRADE_STOCK_QUOTES,
): { stockSymbols: string[]; perpCoins: string[] } {
  const stockSymbols: string[] = [];
  const perpCoins: string[] = [];
  const seenStocks = new Set<string>();
  const seenPerps = new Set<string>();
  const stockLimit = Number.isFinite(maxStockQuotes) ? Math.max(0, Math.floor(maxStockQuotes)) : 0;

  for (const item of items) {
    const identity = copyTradeQuoteIdentity(item);
    if (identity.venue === "stocks") {
      if (
        stockSymbols.length < stockLimit &&
        identity.symbol &&
        !seenStocks.has(identity.symbol)
      ) {
        seenStocks.add(identity.symbol);
        stockSymbols.push(identity.symbol);
      }
      continue;
    }

    if (identity.venue !== "perps") continue;
    if (identity.coin && !seenPerps.has(identity.coin)) {
      seenPerps.add(identity.coin);
      perpCoins.push(identity.coin);
    }
  }

  return { stockSymbols, perpCoins };
}

/** Find only the exact canonical Hyperliquid market requested by a row. */
export function findCopyTradePerpQuote(
  identity: CopyTradeQuoteIdentity,
  quotes: readonly CopyTradePerpQuote[] | null | undefined,
): CopyTradePerpQuote | undefined {
  if (identity.venue !== "perps" || !identity.coin) return undefined;
  return quotes?.find((quote) => quote.coin === identity.coin);
}
