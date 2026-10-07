/**
 * Ticker trade-idea analysis tool for the chat agent (chat capability #2).
 *
 * For a given ticker it gathers the price snapshot + recent bars (Alpaca),
 * recent news (the shared SEC/GDELT research helper), and recent signals (the
 * signals table the feed reads from), then folds them through the pure
 * `buildTradeIdeaReadout` assembler into a concise, structured trade-idea
 * readout. It is an analytical summary, not personalized advice, and takes no
 * write actions.
 */

import { desc, eq } from "drizzle-orm";
import { schema } from "@trade-bot/db";
import { getAlpacaClient } from "../../alpaca.js";
import { getMarketResearchForSymbol } from "../../research/market-research.js";
import {
  buildTradeIdeaReadout,
  type TradeIdeaBar,
  type TradeIdeaNewsItem,
  type TradeIdeaQuote,
  type TradeIdeaSignalItem,
} from "./lib/trade-idea.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandler,
  ToolResult,
} from "./types.js";

const SYMBOL_REGEX = /^[A-Z][A-Z0-9.-]{0,10}$/;
/** Cap on signals pulled for the readout. Keeps the scan bounded (audit H6). */
const SIGNAL_LOOKBACK_LIMIT = 10;

const tickerTradeIdeaDef: ToolDefinition = {
  type: "function",
  function: {
    name: "ticker_trade_idea",
    description:
      "Build a concise trade-idea readout for one ticker by summarizing its " +
      "recent price action / trend, recent news, and any recent signals into " +
      "a single structured view. Use this when the user asks for a read on a " +
      "symbol ('what's the setup on NVDA?', 'give me a trade idea for $TSLA'). " +
      "Returns trend direction, distance from the recent range, news, and " +
      "signals. This is an analytical summary, not personalized advice.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Stock symbol, e.g. NVDA, AAPL, TSLA.",
        },
        timeframe: {
          type: "string",
          enum: ["1D", "1H"],
          description:
            "Bar size for the trend read. 1D (daily) is the default; 1H for " +
            "a shorter-term intraday view.",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
};

async function executeTickerTradeIdea(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { ok: false, error: "symbol is required" };
  if (!SYMBOL_REGEX.test(symbol)) {
    return { ok: false, error: `symbol "${symbol}" is not a valid ticker` };
  }
  const timeframe = args.timeframe === "1H" ? "1H" : "1D";

  // News + signals never need a broker credential, so gather them regardless.
  const [researchResult, signalsResult] = await Promise.allSettled([
    getMarketResearchForSymbol(symbol),
    ctx.db.query.signals.findMany({
      where: eq(schema.signals.symbol, symbol),
      orderBy: [desc(schema.signals.timestamp)],
      limit: SIGNAL_LOOKBACK_LIMIT,
      columns: {
        content: true,
        source: true,
        status: true,
        timestamp: true,
      },
    }),
  ]);

  const news: TradeIdeaNewsItem[] =
    researchResult.status === "fulfilled"
      ? researchResult.value.news.map((n) => ({
          title: n.title,
          url: n.url,
          source: n.domain ?? null,
          publishedAt: n.publishedAt ?? null,
        }))
      : [];

  const signals: TradeIdeaSignalItem[] =
    signalsResult.status === "fulfilled"
      ? signalsResult.value.map((s) => ({
          content: s.content ?? "",
          source: s.source ?? "unknown",
          status: s.status ?? "PENDING",
          timestamp:
            s.timestamp instanceof Date
              ? s.timestamp.toISOString()
              : String(s.timestamp ?? ""),
        }))
      : [];

  // Price snapshot + bars require a credential. Degrade gracefully to a
  // news/signal-only readout when none is connected.
  let quote: TradeIdeaQuote | null = null;
  let bars: TradeIdeaBar[] = [];
  const warnings: string[] = [];

  if (ctx.alpacaCredentialId) {
    try {
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: ctx.alpacaCredentialId,
      });
      const [snapshotResult, barsResult] = await Promise.allSettled([
        client.getSnapshot(symbol),
        client.getBars(symbol, timeframe, 60),
      ]);

      if (snapshotResult.status === "fulfilled" && snapshotResult.value) {
        const snap = snapshotResult.value as Record<string, any>;
        const latestTrade = snap.LatestTrade ?? snap.latestTrade;
        const latestQuote = snap.LatestQuote ?? snap.latestQuote;
        const dailyBar = snap.DailyBar ?? snap.dailyBar;
        const last = Number(latestTrade?.Price ?? latestTrade?.p);
        quote = {
          last: Number.isFinite(last) ? last : null,
          bid: Number(latestQuote?.BidPrice ?? latestQuote?.bp) || null,
          ask: Number(latestQuote?.AskPrice ?? latestQuote?.ap) || null,
          dayHigh: Number(dailyBar?.HighPrice ?? dailyBar?.h) || null,
          dayLow: Number(dailyBar?.LowPrice ?? dailyBar?.l) || null,
        };
      }

      if (barsResult.status === "fulfilled") {
        bars = (barsResult.value as Array<Record<string, any>>).map((b) => ({
          o: Number(b.OpenPrice ?? b.o),
          h: Number(b.HighPrice ?? b.h),
          l: Number(b.LowPrice ?? b.l),
          c: Number(b.ClosePrice ?? b.c),
          v: Number(b.Volume ?? b.v),
        }));
      }
    } catch (err) {
      warnings.push(
        err instanceof Error
          ? `Price data unavailable: ${err.message}`
          : "Price data unavailable."
      );
    }
  } else {
    warnings.push(
      "No Alpaca account connected, so this readout is based on news and signals only (no price trend)."
    );
  }

  const readout = buildTradeIdeaReadout({ symbol, quote, bars, news, signals });

  const trendLabel = readout.trend.direction;
  const priceLabel = readout.price != null ? `$${readout.price.toFixed(2)}` : "n/a";

  return {
    ok: true,
    data: { ...readout, warnings },
    display: `$${symbol} idea · ${trendLabel} · ${priceLabel} · ${news.length} news · ${signals.length} signals`,
  };
}

/** Ticker trade-idea tool set. Merged into the per-request registry. */
export const TICKER_ANALYSIS_TOOLS: ToolHandler[] = [
  // public_market: bars/snapshot, public news, and site-wide signals only; no
  // tenant account data is read.
  { trustDomain: "public_market", definition: tickerTradeIdeaDef, execute: executeTickerTradeIdea },
];
