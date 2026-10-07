/**
 * Alpaca read-only tools for the chat agent.
 *
 * Each tool is a thin wrapper over the existing `AlpacaClient` methods we
 * already use server-side. We deliberately do NOT expose any write tool here
 * (no place_order / cancel_order). Trading via the agent is a Phase 3
 * concern that requires a confirmation modal + audit table + per-user
 * feature flag; until that lands the agent stays structurally read-only.
 *
 * All tool names are prefixed `alpaca_` so they can coexist with `signa_*`
 * tools forwarded from the Signa MCP server.
 */

import { getAlpacaClient } from "../../alpaca.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandler,
  ToolResult,
} from "./types.js";

const TIMEFRAMES = ["1Min", "5Min", "15Min", "1H", "1D"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

/** Helper: every Alpaca tool needs a credential. Centralize the guard. */
async function withAlpacaClient(
  ctx: ToolExecutionContext,
  fn: (
    client: Awaited<ReturnType<typeof getAlpacaClient>>["client"]
  ) => Promise<ToolResult>
): Promise<ToolResult> {
  if (!ctx.alpacaCredentialId) {
    return {
      ok: false,
      error:
        "No active Alpaca credential. The user needs to connect a brokerage account in Settings before this tool can run.",
    };
  }
  try {
    const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
      credentialId: ctx.alpacaCredentialId,
    });
    return await fn(client);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Alpaca request failed",
    };
  }
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

/**
 * Stock symbol shape check. Permissive enough for share classes like
 * BRK.B / BF-B but rejects anything with whitespace, punctuation that
 * could escape into a URL, or non-ASCII. Tools that fail this should
 * surface a clean error instead of leaking the SDK's 4xx text to the LLM.
 */
const SYMBOL_REGEX = /^[A-Z][A-Z0-9.-]{0,10}$/;

/**
 * Clamp a tool's `limit` arg. The model occasionally passes strings,
 * floats, NaN, 0, or wild numbers — coerce to an integer in [min, max]
 * with a sensible fallback when the input isn't a real number.
 */
function clampLimit(
  raw: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return Math.min(max, Math.max(min, floored));
}

// ── Tool: alpaca_get_account ───────────────────────────────────────────────

const getAccountDef: ToolDefinition = {
  type: "function",
  function: {
    name: "alpaca_get_account",
    description:
      "Get the user's Alpaca brokerage account summary — portfolio value, " +
      "cash, buying power, equity, account status, and whether trading is " +
      "blocked. Use this when the user asks about their account, available " +
      "buying power, or whether they can place a trade.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

async function executeGetAccount(
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  return withAlpacaClient(ctx, async (client) => {
    const account = await client.getAccount();
    return {
      ok: true,
      data: {
        accountNumber: account.account_number,
        status: account.status,
        currency: account.currency,
        cash: Number(account.cash),
        buyingPower: Number(account.buying_power),
        portfolioValue: Number(account.portfolio_value),
        equity: Number(account.equity),
        lastEquity: Number(account.last_equity),
        tradingBlocked: account.trading_blocked,
        patternDayTrader: account.pattern_day_trader,
        daytradeCount: account.daytrade_count,
      },
      display: `Account: ${formatUsd(Number(account.portfolio_value))} value · ${formatUsd(Number(account.buying_power))} buying power`,
    };
  });
}

// ── Tool: alpaca_list_positions ────────────────────────────────────────────

const listPositionsDef: ToolDefinition = {
  type: "function",
  function: {
    name: "alpaca_list_positions",
    description:
      "List the user's currently open Alpaca positions with quantity, " +
      "average entry price, current price, market value, and unrealized P&L. " +
      "Use this whenever the user asks about their holdings, positions, or " +
      "current exposure.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

async function executeListPositions(
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  return withAlpacaClient(ctx, async (client) => {
    const positions = await client.getPositions();
    const trimmed = positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      marketValue: Number(p.market_value),
      costBasis: Number(p.cost_basis),
      unrealizedPL: Number(p.unrealized_pl),
      unrealizedPLPercent: Number(p.unrealized_plpc) * 100,
      changeToday: Number(p.change_today) * 100,
      assetClass: p.asset_class,
    }));
    const totalValue = trimmed.reduce((s, p) => s + p.marketValue, 0);
    return {
      ok: true,
      data: { positions: trimmed, count: trimmed.length, totalValue },
      display: `${trimmed.length} position${trimmed.length === 1 ? "" : "s"} · ${formatUsd(totalValue)} total`,
    };
  });
}

// ── Tool: alpaca_list_orders ───────────────────────────────────────────────

const listOrdersDef: ToolDefinition = {
  type: "function",
  function: {
    name: "alpaca_list_orders",
    description:
      "List the user's Alpaca orders. Pass status='open' for resting/working " +
      "orders, 'closed' for filled/canceled history, 'all' for both. Use this " +
      "when the user asks about pending orders, recent fills, or open limits.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Which subset of orders to return. Defaults to 'open'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of orders to return (1–50). Defaults to 25.",
        },
      },
      additionalProperties: false,
    },
  },
};

async function executeListOrders(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const statusInput = (args.status as string) ?? "open";
  const status: "open" | "closed" | "all" =
    statusInput === "closed" || statusInput === "all" ? statusInput : "open";
  const limit = clampLimit(args.limit, 25, 1, 50);

  return withAlpacaClient(ctx, async (client) => {
    const orders = await client.getOrders(status, limit, true);
    const trimmed = orders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: Number(o.qty),
      filledQty: Number(o.filled_qty ?? 0),
      type: o.order_type,
      timeInForce: o.time_in_force,
      limitPrice: o.limit_price ? Number(o.limit_price) : null,
      stopPrice: o.stop_price ? Number(o.stop_price) : null,
      status: o.status,
      submittedAt: o.submitted_at,
      filledAt: o.filled_at,
      filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
    }));
    return {
      ok: true,
      data: { orders: trimmed, count: trimmed.length, status },
      display: `${trimmed.length} ${status} order${trimmed.length === 1 ? "" : "s"}`,
    };
  });
}

// ── Tool: alpaca_get_bars ──────────────────────────────────────────────────

const getBarsDef: ToolDefinition = {
  type: "function",
  function: {
    name: "alpaca_get_bars",
    description:
      "Get historical OHLC bars for a symbol. Use this to reason about " +
      "recent price action — e.g. 'is $X near a 52-week high' or 'what's the " +
      "trend over the last 5 sessions'. Returns up to 100 bars by default.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Stock symbol, e.g. NVDA, LIN, AAPL.",
        },
        timeframe: {
          type: "string",
          enum: [...TIMEFRAMES],
          description:
            "Bar size. 1D for daily, 1H for hourly, 5Min for intraday detail.",
        },
        limit: {
          type: "number",
          description: "Number of bars (1–100). Defaults to 60.",
        },
      },
      required: ["symbol", "timeframe"],
      additionalProperties: false,
    },
  },
};

async function executeGetBars(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { ok: false, error: "symbol is required" };
  if (!SYMBOL_REGEX.test(symbol)) {
    return { ok: false, error: `symbol "${symbol}" is not a valid ticker` };
  }

  const timeframe = args.timeframe as Timeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    return { ok: false, error: `timeframe must be one of ${TIMEFRAMES.join(", ")}` };
  }
  const limit = clampLimit(args.limit, 60, 1, 100);

  return withAlpacaClient(ctx, async (client) => {
    const bars = await client.getBars(symbol, timeframe, limit);
    const compact = bars.map((b: Record<string, unknown>) => ({
      t: b.Timestamp ?? b.t,
      o: b.OpenPrice ?? b.o,
      h: b.HighPrice ?? b.h,
      l: b.LowPrice ?? b.l,
      c: b.ClosePrice ?? b.c,
      v: b.Volume ?? b.v,
    }));
    const last = compact[compact.length - 1];
    return {
      ok: true,
      data: { symbol, timeframe, count: compact.length, bars: compact },
      display: `${compact.length} ${timeframe} bars for $${symbol}${
        last ? ` · last close ${formatUsd(Number(last.c))}` : ""
      }`,
    };
  });
}

// ── Tool: alpaca_get_quote ─────────────────────────────────────────────────

const getQuoteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "alpaca_get_quote",
    description:
      "Get the latest snapshot (price, bid, ask, day high/low/volume) for a " +
      "single symbol. Use this when the user asks 'what is $X trading at' or " +
      "needs the current price for analysis.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock symbol, e.g. NVDA." },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
};

async function executeGetQuote(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { ok: false, error: "symbol is required" };
  if (!SYMBOL_REGEX.test(symbol)) {
    return { ok: false, error: `symbol "${symbol}" is not a valid ticker` };
  }
  return withAlpacaClient(ctx, async (client) => {
    const snapshot = await client.getSnapshot(symbol);
    const latestTrade = snapshot?.LatestTrade ?? snapshot?.latestTrade;
    const latestQuote = snapshot?.LatestQuote ?? snapshot?.latestQuote;
    const dailyBar = snapshot?.DailyBar ?? snapshot?.dailyBar;
    const last = Number(latestTrade?.Price ?? latestTrade?.p);
    return {
      ok: true,
      data: {
        symbol,
        last: Number.isFinite(last) ? last : null,
        bid: Number(latestQuote?.BidPrice ?? latestQuote?.bp) || null,
        ask: Number(latestQuote?.AskPrice ?? latestQuote?.ap) || null,
        dayOpen: Number(dailyBar?.OpenPrice ?? dailyBar?.o) || null,
        dayHigh: Number(dailyBar?.HighPrice ?? dailyBar?.h) || null,
        dayLow: Number(dailyBar?.LowPrice ?? dailyBar?.l) || null,
        dayVolume: Number(dailyBar?.Volume ?? dailyBar?.v) || null,
      },
      display: `$${symbol}: ${formatUsd(last)}`,
    };
  });
}

// ── Tool: alpaca_get_watchlist ─────────────────────────────────────────────

const getWatchlistDef: ToolDefinition = {
  type: "function",
  function: {
    name: "alpaca_get_watchlist",
    description:
      "Get the user's tracked watchlist symbols (stored in our database, not " +
      "Alpaca's). Use this when the user asks 'what's on my watchlist' or " +
      "wants to scan/analyze across their watched tickers.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

async function executeGetWatchlist(
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    // Read straight from the watchlist table — same source the watchlist
    // panel uses (apps/api/src/routers/watchlist.ts).
    const items = await ctx.db.query.userWatchlistItems.findMany({
      where: (w, { eq }) => eq(w.userId, ctx.userId),
      orderBy: (w, { asc }) => [asc(w.symbol)],
      limit: 200,
    });
    const symbols = items.map((i) => i.symbol);
    return {
      ok: true,
      data: { symbols, count: symbols.length },
      display: `${symbols.length} symbol${symbols.length === 1 ? "" : "s"} on watchlist`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Watchlist read failed",
    };
  }
}

/**
 * Public registry of every Alpaca-side tool. Imported by the chat stream
 * and merged with Signa-side tools to form the per-request tool surface.
 */
export const ALPACA_TOOLS: ToolHandler[] = [
  { trustDomain: "tenant_private", definition: getAccountDef, execute: executeGetAccount },
  {
    trustDomain: "tenant_private",
    definition: listPositionsDef,
    execute: executeListPositions,
  },
  { trustDomain: "tenant_private", definition: listOrdersDef, execute: executeListOrders },
  { trustDomain: "public_market", definition: getBarsDef, execute: executeGetBars },
  { trustDomain: "public_market", definition: getQuoteDef, execute: executeGetQuote },
  {
    trustDomain: "tenant_private",
    definition: getWatchlistDef,
    execute: executeGetWatchlist,
  },
];
