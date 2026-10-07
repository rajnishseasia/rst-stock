/**
 * What-if sizing / risk calculator tool for the chat agent (chat capability
 * #3). Pure math over the arguments the user supplies ("if I buy 100 shares at
 * X with a stop at Y, what's my risk and R:R?"): no broker access, no order
 * placement. Delegates to the shared `computeRiskReward` module so the numbers
 * match anywhere else that logic is reused.
 */

import { computeRiskReward, type TradeSide } from "./lib/risk-math.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandler,
  ToolResult,
} from "./types.js";

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const riskCalculatorDef: ToolDefinition = {
  type: "function",
  function: {
    name: "risk_calculator",
    description:
      "Run position-sizing and risk/reward math for a hypothetical trade. " +
      "Given an entry, a stop, and either a quantity or a max-risk budget, it " +
      "returns risk per share, total dollar risk, and (when a target is given) " +
      "the reward and reward-to-risk ratio. Also returns the share count a " +
      "risk budget implies. Use for 'what-if' questions like 'if I buy 100 " +
      "shares at 50 with a stop at 48, what's my risk and R:R to 56?'. This is " +
      "a calculator: it never places an order.",
    parameters: {
      type: "object",
      properties: {
        side: {
          type: "string",
          enum: ["long", "short"],
          description: "Trade direction. Defaults to long.",
        },
        entry: { type: "number", description: "Entry price per share/contract." },
        stop: { type: "number", description: "Protective stop price." },
        target: {
          type: "number",
          description: "Optional profit target; enables reward and R:R output.",
        },
        quantity: {
          type: "number",
          description:
            "Explicit share/contract count. Omit to size from maxRisk instead.",
        },
        maxRisk: {
          type: "number",
          description:
            "Dollar risk budget. When quantity is omitted, this sizes the " +
            "position from the stop distance.",
        },
        contractMultiplier: {
          type: "number",
          description: "1 for equities (default), 100 for options.",
        },
      },
      required: ["entry", "stop"],
      additionalProperties: false,
    },
  },
};

async function executeRiskCalculator(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const entry = num(args.entry);
  const stop = num(args.stop);
  if (entry == null) return { ok: false, error: "entry price is required" };
  if (stop == null) return { ok: false, error: "stop price is required" };

  const side: TradeSide = args.side === "short" ? "short" : "long";

  const result = computeRiskReward({
    side,
    entry,
    stop,
    target: num(args.target),
    quantity: num(args.quantity),
    maxRisk: num(args.maxRisk),
    contractMultiplier: num(args.contractMultiplier) ?? 1,
  });

  const parts: string[] = [`risk/sh $${result.riskPerShare.toFixed(2)}`];
  if (result.totalRisk != null) parts.push(`total risk $${result.totalRisk.toFixed(2)}`);
  if (result.riskRewardRatio != null) parts.push(`R:R ${result.riskRewardRatio.toFixed(2)}`);
  if (result.quantity != null) parts.push(`qty ${result.quantity}`);

  return {
    ok: true,
    data: result,
    display: `${side} · ${parts.join(" · ")}`,
  };
}

/** Risk calculator tool set. Merged into the per-request registry. */
export const RISK_TOOLS: ToolHandler[] = [
  // public_market: pure math on caller-supplied numbers, no I/O.
  { trustDomain: "public_market", definition: riskCalculatorDef, execute: executeRiskCalculator },
];
