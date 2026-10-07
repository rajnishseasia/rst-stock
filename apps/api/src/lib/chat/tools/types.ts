/**
 * Tool-call types shared across the LLM tool surface (Alpaca read tools,
 * Signa MCP forwarding, etc.).
 *
 * The shape is deliberately a minimal subset of the OpenAI / DeepSeek
 * function-calling protocol so we can hand `definition` straight into the
 * provider request body without massaging it. Anything provider-specific
 * (e.g. MCP tool result envelopes) is unwrapped inside `execute` and
 * returned as a plain serializable value.
 */

import type { PoolDb } from "@trade-bot/db";

/**
 * The JSON-schema-ish parameters object the LLM uses to decide how to call
 * a tool. We type it loosely as `object` so MCP-derived tools (whose schema
 * we don't know at compile time) can pass through.
 */
export type ToolParametersSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * What the LLM provider sees in its `tools[]` array. Mirrors the OpenAI
 * function-calling shape — DeepSeek + MiniMax both accept it.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParametersSchema;
  };
}

/**
 * Per-request context passed to every tool's `execute` function. This is
 * where Alpaca creds, the chat user id, the active symbol, and so on live
 * so a tool implementation doesn't need to re-fetch them.
 */
export interface ToolExecutionContext {
  db: PoolDb;
  userId: string;
  /** The user's currently-selected Alpaca credential id, if any. */
  alpacaCredentialId?: string;
  /** The active account mode for this chat. */
  activeAccountType?: "PAPER" | "LIVE";
  /** The active symbol on screen, if any (handy as a fallback default). */
  activeSymbol?: string;
}

/**
 * A client-directed UI action a tool can emit alongside its model-facing
 * `data`. Forwarded verbatim to the browser on the `tool_result` SSE frame so
 * a tool can drive client state (e.g. pre-fill the trade ticket) WITHOUT ever
 * performing a side-effectful action on the server. Today the only directive
 * is an order draft; the browser maps it into the trade form's prefill props.
 *
 * Note: this is a suggestion the client renders, never an instruction the
 * server acts on. The order-draft tool in particular stops at building this
 * prefill payload. It never calls a broker order-create path, so a draft can
 * only ever pre-fill the form for the user to review and submit by hand.
 */
export type ToolUiDirective = {
  type: "order_draft";
  draft: OrderDraftPrefill;
};

/**
 * The exact fields the browser needs to pre-fill the trade ticket. Mirrors the
 * `initial*` props `TradeForm` already consumes for copied Signa signals, so
 * the draft rides the same review-before-submit path (a prefilled order always
 * opens the confirmation dialog). All fields are advisory; the user edits and
 * submits manually.
 */
export interface OrderDraftPrefill {
  symbol: string;
  side: "buy" | "sell";
  /**
   * Explicit position intent. "short" means the user asked to OPEN a short
   * (the ticket should read SellShort / direction short), not close a long.
   * null preserves the plain buy/sell behavior for ordinary drafts.
   */
  direction: "long" | "short" | null;
  quantity: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /**
   * Suggested ticket order type. "OCO" whenever a stop is present (with or
   * without a target), so the exit-plan ticket broker-attaches the stop. A
   * plain Market/Limit ticket would only store the stop locally and submit a
   * naked entry.
   */
  orderType: "Market" | "Limit" | "OCO";
  /**
   * Entry-leg type for an OCO ticket. A limit bracket ("limit buy at 180 with
   * stop/target") collapses to an OCO ticket but must keep its Limit entry;
   * without this the form defaults the OCO entry to Market. null for
   * non-OCO tickets.
   */
  entryOrderType: "Market" | "Limit" | null;
  limitPrice: number | null;
  /**
   * Time in force for the ticket. Carried so a "DAY order" request actually
   * sets the form's TIF field instead of silently falling back to GTC.
   */
  timeInForce: "day" | "gtc";
}

/**
 * The structured result returned to the model after we execute a tool. We
 * always return a JSON-serializable object and let the framework stringify
 * it before pushing it back into the message history as a `tool` role
 * message.
 *
 * `display` is optional metadata for the UI (e.g. a one-line summary of
 * "what the tool did") that the chat panel can render as a "Called
 * alpaca_list_positions" badge. The model never sees it.
 *
 * `ui` is an optional client-directed action (see `ToolUiDirective`). It is
 * forwarded to the browser but is purely presentational: it can never cause
 * the server to place an order or take any other side effect.
 */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  /** Plain-English error message when ok = false. */
  error?: string;
  /** Optional one-line summary for the UI ("3 positions, $4,201 total"). */
  display?: string;
  /** Optional client-directed UI action (e.g. an order draft prefill). */
  ui?: ToolUiDirective;
}

/**
 * The unit of work a tool registry holds: the public-facing schema the LLM
 * uses, plus the implementation we run when the LLM picks it.
 */
export interface ToolHandler {
  /** Trust boundary used by the server-owned cross-tool privacy policy. */
  trustDomain: "public_market" | "tenant_private" | "external";
  definition: ToolDefinition;
  execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext
  ): Promise<ToolResult>;
}

export type ToolRegistry = Map<string, ToolHandler>;

/**
 * What the LLM emits while streaming. We assemble these incrementally
 * (DeepSeek streams `tool_calls` field-by-field) and only execute once
 * `finish_reason: "tool_calls"` lands.
 */
export interface PendingToolCall {
  /** The provider's call id — pass straight back when responding. */
  id: string;
  name: string;
  /** Raw JSON-string args as the provider streams them. Parsed at execute. */
  argsBuffer: string;
}
