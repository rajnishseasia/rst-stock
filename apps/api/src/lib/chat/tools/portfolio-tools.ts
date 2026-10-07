/**
 * Portfolio Q&A tool for the chat agent (chat capability #1).
 *
 * Answers questions over the user's LIVE positions and recent order history:
 * "what's my biggest loser?", "how much AAPL do I hold?", "how concentrated am
 * I?". Read-only: it fetches positions + orders through the same
 * `getAlpacaClient` path the other read tools use, maps the broker rows into
 * the pure `analyzePortfolio` aggregator, and returns the computed figures. No
 * write path exists here.
 */

import { getAlpacaClient } from "../../alpaca.js";
import {
  analyzePortfolio,
  type PortfolioOrderInput,
  type PortfolioPositionInput,
} from "./lib/portfolio-analysis.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandler,
  ToolResult,
} from "./types.js";

const SYMBOL_REGEX = /^[A-Z][A-Z0-9.-]{0,10}$/;

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `$${n.toFixed(2)}`;
}

const portfolioAnalyzeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "portfolio_analyze",
    description:
      "Analyze the user's live portfolio to answer questions about their " +
      "holdings and order history: biggest winner/loser, total unrealized " +
      "P&L, exposure (long/short/net/gross), position concentration, per-" +
      "symbol holdings, open order count, and recent fills. Pass `symbol` to " +
      "focus a single ticker (e.g. 'how much AAPL do I hold?'). Use this " +
      "instead of alpaca_list_positions when the user asks a portfolio-level " +
      "question that needs ranking or aggregation.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "Optional ticker to focus (e.g. AAPL). When set, the result " +
            "includes that symbol's aggregated holding.",
        },
        topN: {
          type: "number",
          description:
            "How many rows to include in the top-by-value and recent-fills " +
            "lists (1-10). Defaults to 5.",
        },
      },
      additionalProperties: false,
    },
  },
};

async function executePortfolioAnalyze(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (!ctx.alpacaCredentialId) {
    return {
      ok: false,
      error:
        "No active Alpaca credential. The user needs to connect a brokerage account in Settings before this tool can run.",
    };
  }

  const focusSymbolRaw = String(args.symbol ?? "").trim().toUpperCase();
  const focusSymbol =
    focusSymbolRaw && SYMBOL_REGEX.test(focusSymbolRaw) ? focusSymbolRaw : undefined;
  const topNRaw = Number(args.topN);
  const topN = Number.isFinite(topNRaw)
    ? Math.min(10, Math.max(1, Math.floor(topNRaw)))
    : 5;

  try {
    const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
      credentialId: ctx.alpacaCredentialId,
    });

    const [positionsRaw, ordersRaw] = await Promise.all([
      client.getPositions(),
      client.getOrders("all", 50, true),
    ]);

    const positions: PortfolioPositionInput[] = positionsRaw.map((p) => ({
      symbol: p.symbol,
      side: p.side === "short" ? "short" : "long",
      qty: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      marketValue: Number(p.market_value),
      costBasis: Number(p.cost_basis),
      unrealizedPl: Number(p.unrealized_pl),
      unrealizedPlPct: Number(p.unrealized_plpc),
      changeTodayPct: Number(p.change_today),
      assetClass: p.asset_class,
    }));

    const orders: PortfolioOrderInput[] = ordersRaw.map((o) => ({
      symbol: o.symbol,
      side: o.side === "sell" ? "sell" : "buy",
      qty: Number(o.qty ?? 0),
      status: o.status,
      type: o.order_type,
      submittedAt: o.submitted_at ?? null,
      filledAt: o.filled_at ?? null,
      filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
    }));

    const analysis = analyzePortfolio(positions, orders, { focusSymbol, topN });

    const display = focusSymbol
      ? analysis.focusHolding
        ? `${focusSymbol}: ${analysis.focusHolding.qty} sh · ${formatUsd(
            analysis.focusHolding.marketValue
          )} · P/L ${formatUsd(analysis.focusHolding.unrealizedPl)}`
        : `No ${focusSymbol} position held`
      : `${analysis.positionCount} positions · P/L ${formatUsd(
          analysis.totalUnrealizedPl
        )} · gross ${formatUsd(analysis.grossExposure)}`;

    return { ok: true, data: analysis, display };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Portfolio analysis failed",
    };
  }
}

/** Portfolio Q&A tool set. Merged into the per-request registry. */
export const PORTFOLIO_TOOLS: ToolHandler[] = [
  // tenant_private: reads the user's positions and order history.
  { trustDomain: "tenant_private", definition: portfolioAnalyzeDef, execute: executePortfolioAnalyze },
];
