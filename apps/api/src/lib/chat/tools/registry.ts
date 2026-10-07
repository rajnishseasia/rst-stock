/**
 * Per-request tool registry assembly.
 *
 * Each chat turn we build a fresh Map of (name -> handler) by combining:
 *   - The static `ALPACA_TOOLS` set (always present).
 *   - The chat-capability tools: portfolio Q&A, ticker trade-idea analysis,
 *     the what-if risk calculator, and order drafting (all always present).
 *   - Whatever the Signa MCP server is currently advertising (best-effort —
 *     omitted entirely if Signa isn't configured or the connection fails).
 *
 * Tool names are namespaced (`alpaca_*`, `portfolio_*`, `ticker_*`, `risk_*`,
 * `draft_*`, `signa_*`) so collisions are impossible. The order is intentionally
 * "your data" first (Alpaca + portfolio), then analysis/calculators, then the
 * order draft, then Signa edge-discovery (a small priming nudge).
 */

import { ALPACA_TOOLS } from "./alpaca-tools.js";
import { PORTFOLIO_TOOLS } from "./portfolio-tools.js";
import { TICKER_ANALYSIS_TOOLS } from "./ticker-analysis-tools.js";
import { RISK_TOOLS } from "./risk-tools.js";
import { ORDER_DRAFT_TOOLS } from "./order-draft-tools.js";
import { buildSignaTools } from "./signa-mcp-client.js";
import type { ToolHandler, ToolRegistry } from "./types.js";

export interface BuildToolRegistryOptions {
  /** Toggle Signa wiring off (e.g. for tests). Defaults to true. */
  includeSigna?: boolean;
}

/**
 * Assemble the per-request tool registry. We catch Signa failures so a
 * misconfigured upstream never blocks the chat; the user just doesn't see
 * `signa_*` tools that turn.
 */
export async function buildToolRegistry(
  opts: BuildToolRegistryOptions = {}
): Promise<{ registry: ToolRegistry; handlers: ToolHandler[] }> {
  const { includeSigna = true } = opts;

  const handlers: ToolHandler[] = [
    ...ALPACA_TOOLS,
    ...PORTFOLIO_TOOLS,
    ...TICKER_ANALYSIS_TOOLS,
    ...RISK_TOOLS,
    ...ORDER_DRAFT_TOOLS,
  ];

  if (includeSigna) {
    try {
      const signa = await buildSignaTools();
      handlers.push(...signa);
    } catch (err) {
      console.error("[chat-tools] failed to build Signa tools:", err);
    }
  }

  const registry: ToolRegistry = new Map();
  for (const h of handlers) {
    registry.set(h.definition.function.name, h);
  }

  return { registry, handlers };
}
