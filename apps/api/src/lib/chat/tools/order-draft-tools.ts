/**
 * Order-drafting tool for the chat agent (chat capability #4): "draft an order
 * from natural language and PRE-FILL the trade form for the user to review."
 *
 * SAFETY (repo rule, non-negotiable): this tool NEVER places an order. It only
 * builds a validated draft via the pure `buildOrderDraft` module and returns a
 * client `ui` directive that the browser maps into the trade ticket's prefill
 * props. Submission is always a separate, explicit user action (reviewing the
 * prefilled ticket and clicking submit, which runs the normal idempotent order
 * path). There is deliberately no import of any broker order-create function in
 * this file.
 *
 * The only broker call here is an OPTIONAL read: a live quote to anchor the
 * entry price for the risk math when the user didn't give one. That read is
 * best-effort and never blocks producing the draft.
 */

import { getAlpacaClient } from "../../alpaca.js";
import { buildOrderDraft, type OrderDraftInput } from "./lib/order-draft.js";
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

const draftOrderDef: ToolDefinition = {
  type: "function",
  function: {
    name: "draft_order",
    description:
      "Draft an equity order from the user's natural-language request and " +
      "PRE-FILL the trade ticket for them to review. This DOES NOT place an " +
      "order: it only prepares a draft and fills in the form. The user must " +
      "review and submit it themselves. Use it when the user says something " +
      "like 'set up a buy of 100 AAPL with a stop at 180 and target 200'. " +
      "After calling it, tell the user the ticket is pre-filled and ask them " +
      "to review and confirm. Never claim the order was placed or submitted.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker, e.g. AAPL." },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side.",
        },
        direction: {
          type: "string",
          enum: ["long", "short"],
          description:
            'Position intent. Use "short" together with side "sell" when the ' +
            "user wants to OPEN a short position (e.g. 'short AAPL'), so the " +
            "ticket reads sell-short instead of closing a long. Omit for a " +
            "plain buy, or for a sell that closes an existing long.",
        },
        quantity: {
          type: "number",
          description:
            "Share count. Omit to size from stopLoss + maxRisk instead.",
        },
        orderType: {
          type: "string",
          enum: ["market", "limit"],
          description: "Entry type. Defaults to market.",
        },
        limitPrice: {
          type: "number",
          description: "Limit price (required for a limit entry).",
        },
        entryPrice: {
          type: "number",
          description:
            "Entry basis for the risk math. Defaults to the limit price, or " +
            "the live quote when omitted.",
        },
        stopLoss: { type: "number", description: "Protective stop price." },
        takeProfit: {
          type: "number",
          description: "Profit target. With a stop, the ticket becomes an OCO.",
        },
        maxRisk: {
          type: "number",
          description:
            "Dollar risk budget used to size quantity when quantity is omitted.",
        },
        timeInForce: {
          type: "string",
          enum: ["day", "gtc"],
          description: "Time in force. Defaults to gtc.",
        },
        notes: { type: "string", description: "Optional note for the ticket." },
      },
      required: ["symbol", "side"],
      additionalProperties: false,
    },
  },
};

async function executeDraftOrder(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const draftInput: OrderDraftInput = {
    symbol: String(args.symbol ?? ""),
    side: args.side === "sell" ? "sell" : "buy",
    direction:
      args.direction === "short"
        ? "short"
        : args.direction === "long"
          ? "long"
          : null,
    quantity: num(args.quantity),
    orderType: args.orderType === "limit" ? "limit" : "market",
    limitPrice: num(args.limitPrice),
    entryPrice: num(args.entryPrice),
    stopLoss: num(args.stopLoss),
    takeProfit: num(args.takeProfit),
    maxRisk: num(args.maxRisk),
    timeInForce: args.timeInForce === "day" ? "day" : "gtc",
    notes: typeof args.notes === "string" ? args.notes : null,
  };

  // Best-effort: anchor the entry from a live quote when the user gave a stop
  // (so risk sizing can run) but no entry/limit. Read-only; failures are
  // silently ignored so a missing quote never blocks the draft.
  const needsEntryAnchor =
    draftInput.entryPrice == null &&
    draftInput.limitPrice == null &&
    draftInput.stopLoss != null;
  if (needsEntryAnchor && ctx.alpacaCredentialId) {
    try {
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: ctx.alpacaCredentialId,
      });
      const snap = (await client.getSnapshot(
        draftInput.symbol.trim().toUpperCase()
      )) as Record<string, any> | undefined;
      const latestTrade = snap?.LatestTrade ?? snap?.latestTrade;
      const last = Number(latestTrade?.Price ?? latestTrade?.p);
      if (Number.isFinite(last) && last > 0) {
        draftInput.entryPrice = last;
      }
    } catch {
      // Ignore: the ticket will still pick up the live quote on the client.
    }
  }

  const draft = buildOrderDraft(draftInput);

  // Defence in depth: this tool must never emit anything other than a draft.
  // If the literal ever changes, fail closed rather than forward a client
  // action that could be misread as a live order.
  if (draft.status !== "draft") {
    return { ok: false, error: "Internal error: order draft was not in draft state." };
  }

  const sideLabel =
    draft.direction === "short" ? "SELL SHORT" : draft.side.toUpperCase();
  const qtyLabel = draft.quantity != null ? `${draft.quantity} ` : "";
  const priceLabel = draft.entryPrice != null ? ` @ $${draft.entryPrice.toFixed(2)}` : "";
  const display = draft.valid
    ? `Draft ready: ${sideLabel} ${qtyLabel}${draft.symbol}${priceLabel} · review & submit in the ticket`
    : `Draft needs input: ${draft.errors.join("; ")}`;

  return {
    ok: true,
    // The model sees the full draft plus an explicit reminder that this is a
    // draft awaiting the user's manual confirmation.
    data: {
      ...draft,
      note: "This is a DRAFT only. The trade ticket has been pre-filled. The user must review and submit it manually. Do not say the order was placed.",
    },
    display,
    // Only hand the client a prefill directive for a valid draft, so we don't
    // clobber the ticket with an incomplete order.
    ui: draft.valid ? { type: "order_draft", draft: draft.prefill } : undefined,
  };
}

/** Order-draft tool set. Merged into the per-request registry. */
export const ORDER_DRAFT_TOOLS: ToolHandler[] = [
  // public_market: builds a draft from user-stated parameters plus an optional
  // public quote; reads no tenant account data and never submits.
  { trustDomain: "public_market", definition: draftOrderDef, execute: executeDraftOrder },
];
