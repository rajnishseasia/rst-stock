import { randomUUID } from "node:crypto";
import type { PoolDb } from "@trade-bot/db";
import { schema } from "@trade-bot/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { buildStockChatContext } from "./stock-context.js";
import { RST_STOCK_RESEARCH_CHAT_SKILL } from "./skills/rst-stock-research-chat.js";
import {
  createChatCompletionResponse,
  extractChatDelta,
  extractFinishReason,
  extractToolCallDeltas,
  type AssistantToolCall,
  type LlmChatMessage,
  type LlmToolDefinition,
} from "../llm/client.js";
// import { getDecryptedLlmCredential } from "../llm/credentials.js"; // BYOK: re-enable when user-supplied keys return
import { getLlmProviderPreset, LLM_PROVIDER_PRESETS, type LlmProviderPreset } from "../llm/providers.js";
import { env } from "../../config/index.js";
import { buildToolRegistry } from "./tools/registry.js";
import type { ToolExecutionContext, ToolHandler } from "./tools/types.js";
import {
  createToolPrivacyState,
  markToolResult,
  toolCallPolicy,
  type ToolPrivacyState,
} from "./tools/privacy-policy.js";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(8000),
});

// Platform AI model (gpt-4o-mini). BYOK disabled: users no longer supply
// their own keys. llmCredentialId removed from the schema — the server uses
// the platform OPENAI_API_KEY env var for all chat requests.
// To re-enable BYOK, restore llmCredentialId here and in createStockChatStream.
export const streamChatInputSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(20),
  alpacaCredentialId: z.string().uuid().optional(),
  activeAccountType: z.enum(["PAPER", "LIVE"]).optional(),
  activeSymbol: z.string().trim().max(20).optional(),
  /**
   * If present, persist the turn under this existing conversation. If absent,
   * the server creates a new conversation, auto-titles it from the first
   * user message, and returns the new id in the `meta` SSE frame so the
   * client can keep using it for follow-up turns.
   */
  // Accept null too: the client sends `conversationId: null` for a brand-new
  // chat (not just undefined), which previously failed validation.
  conversationId: z.string().uuid().nullish(),
  selectedSignal: z
    .object({
      signalId: z.string().uuid().optional(),
      symbol: z.string().trim().max(20).optional(),
      content: z.string().trim().max(2000).optional(),
    })
    .optional(),
});

export type StreamChatInput = z.infer<typeof streamChatInputSchema>;

type StreamChatOptions = {
  db: PoolDb;
  userId: string;
  input: StreamChatInput;
  signal?: AbortSignal;
};

function encoder() {
  return new TextEncoder();
}

function sse(payload: unknown) {
  return encoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function systemPrompt(
  stockContext: string,
  warnings: string[],
  toolNames: string[]
) {
  // Tools live alongside the pre-computed stock context — the chat backend
  // still injects the user's positions / orders / filings inline so a model
  // that ignores tools still answers competently. Tools are the "ask for
  // more on demand" path.
  const toolsBlock =
    toolNames.length > 0
      ? [
          "Tools available this turn (call them when you need data not already in the context):",
          ...toolNames.map((n) => `- ${n}`),
          "",
          "Use tools sparingly: only call one when the context above is genuinely missing what you need. Always cite which tool's data you used in your final answer.",
        ].join("\n")
      : "";

  return [
    "Server-owned skill to apply for this chat:",
    RST_STOCK_RESEARCH_CHAT_SKILL,
    "",
    "Current stock context:",
    stockContext || "No stock context available.",
    warnings.length > 0 ? `Context warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    toolsBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Compact the user/assistant transcript before sending to the model. The
 *  client transcript only carries plain `content` for assistant turns —
 *  tool_calls are an intra-turn affair that we never round-trip back from
 *  the browser — so we treat every assistant entry as a plain text turn.
 *  The current turn's tool-call loop still appends its own `assistant` +
 *  `tool` messages with full `tool_calls` so the provider can match call
 *  ids inside the same turn (see `createStockChatStream`). */
function compactMessages(messages: StreamChatInput["messages"]): LlmChatMessage[] {
  return messages.slice(-12).map((message) => {
    if (message.role === "user") {
      return { role: "user" as const, content: message.content.slice(0, 8000) };
    }
    return {
      role: "assistant" as const,
      content: message.content.slice(0, 8000),
    };
  });
}

const NON_TICKER_WORDS = new Set([
  "A",
  "AI",
  "AND",
  "ARE",
  "ABOUT",
  "CHAT",
  "CFO",
  "CEO",
  "FOR",
  "FILING",
  "FILINGS",
  "I",
  "IS",
  "LLM",
  "ME",
  "NEWS",
  "ON",
  "OR",
  "SEC",
  "THE",
  "TO",
  "TALK",
  "WHAT",
]);

function normalizeTickerCandidate(value: string | undefined) {
  const candidate = value?.replace(/[.,:;!?)]$/g, "").toUpperCase();
  if (!candidate) return null;
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(candidate)) return null;
  if (NON_TICKER_WORDS.has(candidate)) return null;
  return candidate;
}

export function inferSymbolFromMessages(messages: StreamChatInput["messages"]) {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const content = latestUserMessage?.content;
  if (!content) return null;

  const cashtagMatch = content.match(/\$([A-Za-z][A-Za-z0-9.]{0,9})\b/);
  const cashtag = normalizeTickerCandidate(cashtagMatch?.[1]);
  if (cashtag) return cashtag;

  const phrasePatterns = [
    /(?:news|filings?|research)\s+(?:about|on|for)\s+([A-Za-z][A-Za-z0-9.]{0,9})\b/gi,
    /(?:ticker|symbol)\s+(?:is\s+|for\s+)?([A-Za-z][A-Za-z0-9.]{0,9})\b/gi,
    /(?:talk(?:\s+to\s+me)?|tell\s+me|what(?:'s|\s+is))\s+(?:about|on|for)\s+([A-Za-z][A-Za-z0-9.]{0,9})\b/gi,
  ];

  for (const pattern of phrasePatterns) {
    for (const match of content.matchAll(pattern)) {
      const candidate = normalizeTickerCandidate(match[1]);
      if (candidate) return candidate;
    }
  }

  for (const match of content.matchAll(/\b([A-Z][A-Z0-9.]{1,9})\b/g)) {
    const candidate = normalizeTickerCandidate(match[1]);
    if (candidate) return candidate;
  }

  return null;
}

/**
 * Heuristic conversation title from the first user message. Caps at 60
 * chars and strips trailing whitespace/punctuation so the sidebar entry
 * reads cleanly — no LLM round-trip needed for a one-line label.
 */
function deriveConversationTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;
  return cleaned.slice(0, 57).replace(/[\s.,;:!?]+$/, "") + "…";
}

/**
 * The conversation identity + privacy state a turn runs under. The privacy
 * flag is the durable, server-owned record that tenant-private broker data
 * has entered this conversation at some point; the client can never lower it.
 */
type ResolvedConversation = {
  conversationId: string | null;
  /** Per-conversation privacy flag after this turn's own writes. */
  tenantPrivateDataSeen: boolean;
  /**
   * True when `tenantPrivateDataSeen` reflects what the conversation row
   * durably holds. False on the fail-closed fallback paths (row unreadable
   * or unwritable), where the in-memory flag may be true without a matching
   * row write; the stream loop then retries the durable write itself.
   */
  flagDurable: boolean;
};

/**
 * Resolve (or create) the conversation row that this turn belongs to and
 * persist the latest user message. Returns the conversation id so the
 * caller can both echo it back to the client and use it when persisting
 * the assistant turn after streaming finishes, plus the durable
 * `tenantPrivateDataSeen` flag for the conversation.
 *
 * When this turn attaches an Alpaca credential, broker account context is
 * loaded into the system prompt, so the durable flag is raised as part of
 * the same insert/update rather than in a separate write.
 *
 * Best-effort for history: if persistence fails we log and return a null
 * conversation id rather than aborting the stream. The privacy flag fails
 * CLOSED in that case: an existing conversation whose row we could not
 * read is treated as already containing private data.
 */
async function persistUserTurnAndConversation(
  db: PoolDb,
  userId: string,
  input: StreamChatInput
): Promise<ResolvedConversation> {
  const seedsPrivateContext = Boolean(input.alpacaCredentialId);
  try {
    const latestUserMessage = [...input.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!latestUserMessage) {
      return {
        conversationId: input.conversationId ?? null,
        // No user turn to persist means no row read either: fail closed for
        // an existing conversation, seed from this turn for a new one.
        tenantPrivateDataSeen:
          Boolean(input.conversationId) || seedsPrivateContext,
        flagDurable: false,
      };
    }

    let conversationId = input.conversationId ?? null;
    let tenantPrivateDataSeen = seedsPrivateContext;

    if (!conversationId) {
      const inserted = await db
        .insert(schema.chatConversations)
        .values({
          userId,
          title: deriveConversationTitle(latestUserMessage.content),
          accountMode: input.activeAccountType ?? null,
          tenantPrivateDataSeen: seedsPrivateContext,
        })
        .returning({ id: schema.chatConversations.id });
      const newRow = inserted[0];
      if (!newRow) {
        return { conversationId: null, tenantPrivateDataSeen, flagDurable: false };
      }
      conversationId = newRow.id;
    } else {
      // CRITICAL: prove ownership before writing any messages under this
      // conversation. The (id, userId) where clause makes the update a no-op
      // for someone else's conversation, but the message insert below would
      // succeed regardless (the FK only checks `id` exists, not who owns it).
      // .returning lets us detect the no-op and bail.
      const touched = await db
        .update(schema.chatConversations)
        .set({
          updatedAt: new Date(),
          // Raise (never lower) the durable flag when this turn loads broker
          // context into the system prompt.
          ...(seedsPrivateContext ? { tenantPrivateDataSeen: true } : {}),
        })
        .where(
          and(
            eq(schema.chatConversations.id, conversationId),
            eq(schema.chatConversations.userId, userId)
          )
        )
        .returning({
          id: schema.chatConversations.id,
          tenantPrivateDataSeen: schema.chatConversations.tenantPrivateDataSeen,
        });
      const touchedRow = touched[0];
      if (!touchedRow) {
        // Caller supplied an id that isn't theirs (or doesn't exist).
        // Don't trust the input — start a fresh conversation instead of
        // writing the user's message into someone else's history.
        const inserted = await db
          .insert(schema.chatConversations)
          .values({
            userId,
            title: deriveConversationTitle(latestUserMessage.content),
            accountMode: input.activeAccountType ?? null,
            tenantPrivateDataSeen: seedsPrivateContext,
          })
          .returning({ id: schema.chatConversations.id });
        const newRow = inserted[0];
        if (!newRow) {
          return { conversationId: null, tenantPrivateDataSeen, flagDurable: false };
        }
        conversationId = newRow.id;
      } else {
        tenantPrivateDataSeen =
          touchedRow.tenantPrivateDataSeen || seedsPrivateContext;
      }
    }

    await db.insert(schema.chatMessages).values({
      conversationId,
      role: "user",
      content: latestUserMessage.content,
    });

    return { conversationId, tenantPrivateDataSeen, flagDurable: true };
  } catch (err) {
    console.error("[chat] failed to persist user turn:", err);
    return {
      conversationId: input.conversationId ?? null,
      // Fail closed: if the client referenced an existing conversation and we
      // could not read its row, assume it already carries private data.
      tenantPrivateDataSeen:
        Boolean(input.conversationId) || seedsPrivateContext,
      flagDurable: false,
    };
  }
}

/**
 * Raise the durable per-conversation privacy flag. Called the moment a
 * tenant_private-domain tool result succeeds mid-turn so later turns of the
 * same conversation seed closed even if the client drops the credential.
 * Returns true when the row write landed.
 */
async function persistPrivacyFlag(
  db: PoolDb,
  userId: string,
  conversationId: string
): Promise<boolean> {
  try {
    await db
      .update(schema.chatConversations)
      .set({ tenantPrivateDataSeen: true })
      .where(
        and(
          eq(schema.chatConversations.id, conversationId),
          eq(schema.chatConversations.userId, userId)
        )
      );
    return true;
  } catch (err) {
    console.error("[chat] failed to persist privacy flag:", err);
    return false;
  }
}

/**
 * Hard cap on the number of tool-call round-trips per user turn. Each
 * iteration is one provider HTTP call + the tool execution. Five is
 * generous (most useful chains are 1–2 tools); above that we assume the
 * model is looping and tell it to wrap up.
 */
const MAX_TOOL_ITERATIONS = 5;

/**
 * Run one streaming completion. Emits content deltas to the SSE client as
 * they arrive. Returns the full assistant turn so the caller can decide
 * whether to execute tools and loop, or close out.
 */
async function streamOneCompletion(opts: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  apiKey: string;
  preset: LlmProviderPreset;
  messages: LlmChatMessage[];
  tools: LlmToolDefinition[] | undefined;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  toolCalls: AssistantToolCall[];
  finishReason: string | null;
}> {
  const { controller, apiKey, preset, messages, tools, signal } = opts;

  const providerResponse = await createChatCompletionResponse({
    apiKey,
    preset,
    stream: true,
    signal,
    messages,
    tools: tools && tools.length > 0 ? tools : undefined,
    maxOutputTokens: 2200,
  });

  let assistantBuffer = "";
  let finishReason: string | null = null;
  // tool_calls are streamed as partial entries with stable `index`; we
  // accumulate id / name / arguments by index.
  const callsByIndex = new Map<
    number,
    { id: string; name: string; argsBuffer: string }
  >();

  const reader = providerResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const rawPayload = trimmed.slice(5).trim();
      if (!rawPayload || rawPayload === "[DONE]") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        continue; // malformed frame
      }

      const delta = extractChatDelta(parsed);
      if (delta) {
        assistantBuffer += delta;
        controller.enqueue(sse({ type: "delta", delta }));
      }

      const toolDeltas = extractToolCallDeltas(parsed);
      if (toolDeltas) {
        for (const td of toolDeltas) {
          const existing = callsByIndex.get(td.index) ?? {
            id: "",
            name: "",
            argsBuffer: "",
          };
          if (td.id) existing.id = td.id;
          if (td.name) existing.name = td.name;
          if (td.argumentsDelta) existing.argsBuffer += td.argumentsDelta;
          callsByIndex.set(td.index, existing);
        }
      }

      const fr = extractFinishReason(parsed);
      if (fr) finishReason = fr;
    }
  }

  const toolCalls: AssistantToolCall[] = [...callsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({
      // Some providers stream tool calls without an `id` until the final
      // chunk. Synthesize a uuid so the round-trip still works and we don't
      // collide between requests landing in the same millisecond.
      id: c.id || `call_${randomUUID()}`,
      type: "function" as const,
      function: { name: c.name, arguments: c.argsBuffer || "{}" },
    }));

  return { content: assistantBuffer, toolCalls, finishReason };
}

/**
 * Execute a single tool call. Emits `tool_call` + `tool_result` SSE frames
 * so the UI can render "Calling alpaca_list_positions…" badges. The model
 * will see the structured result on the next round.
 */
async function executeToolCall(
  controller: ReadableStreamDefaultController<Uint8Array>,
  registry: Map<string, ToolHandler>,
  call: AssistantToolCall,
  ctx: ToolExecutionContext,
  privacyState: ToolPrivacyState,
): Promise<{ tool_call_id: string; resultJson: string }> {
  const name = call.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : "tool arguments were not valid JSON";
    controller.enqueue(
      sse({ type: "tool_call", id: call.id, name, args: null, error: errMsg })
    );
    return {
      tool_call_id: call.id,
      resultJson: JSON.stringify({ ok: false, error: errMsg }),
    };
  }

  controller.enqueue(sse({ type: "tool_call", id: call.id, name, args }));

  const handler = registry.get(name);
  if (!handler) {
    const result = { ok: false, error: `Unknown tool: ${name}` };
    controller.enqueue(
      sse({ type: "tool_result", id: call.id, name, ...result })
    );
    return { tool_call_id: call.id, resultJson: JSON.stringify(result) };
  }

  const policy = toolCallPolicy(handler, privacyState);
  if (!policy.allowed) {
    const result = { ok: false, error: policy.error };
    controller.enqueue(
      sse({ type: "tool_result", id: call.id, name, ...result }),
    );
    return { tool_call_id: call.id, resultJson: JSON.stringify(result) };
  }

  try {
    const result = await handler.execute(args, ctx);
    markToolResult(privacyState, handler, result);
    controller.enqueue(
      sse({
        type: "tool_result",
        id: call.id,
        name,
        ok: result.ok,
        display: result.display,
        error: result.error,
        // Forward any client-directed UI action (e.g. an order-draft prefill).
        // Purely presentational; the server never acts on it.
        ...(result.ui ? { ui: result.ui } : {}),
      })
    );
    // The model sees the structured result but NOT the `ui` directive (which is
    // a client concern). Strip it so we don't feed redundant prefill data back
    // into the transcript.
    const { ui: _ui, ...modelResult } = result;
    return { tool_call_id: call.id, resultJson: JSON.stringify(modelResult) };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "tool execution failed";
    controller.enqueue(
      sse({ type: "tool_result", id: call.id, name, ok: false, error: errMsg })
    );
    return {
      tool_call_id: call.id,
      resultJson: JSON.stringify({ ok: false, error: errMsg }),
    };
  }
}

export function createStockChatStream(options: StreamChatOptions) {
  const { db, userId, input, signal } = options;
  const explicitSymbol = input.activeSymbol || input.selectedSignal?.symbol;
  const inferredSymbol = explicitSymbol ? null : inferSymbolFromMessages(input.messages);
  const activeSymbol = input.activeSymbol || input.selectedSignal?.symbol || inferredSymbol || undefined;

  return new ReadableStream({
    async start(controller) {
      // Persistence-relevant state is hoisted out of the inner try so the
      // outer finally can still save partial assistant content when the
      // provider stream errors mid-reply. Without this, a network drop
      // halfway through a long answer left the user with a half-rendered
      // bubble that vanished on reload.
      let lastAssistantText = "";
      let conversationId: string | null = null;
      let providerLabel: string | null = null;
      let providerModel: string | null = null;
      let contextSources: unknown = [];
      let contextWarnings: string[] = [];
      let toolNamesForMetadata: string[] = [];
      let didError: string | null = null;
      // Hoisted so the finally block can retry the durable privacy write if
      // the mid-turn attempt failed.
      let toolPrivacyState: ToolPrivacyState | null = null;
      let privacyFlagDurable = false;

      try {
        const conversationPromise = persistUserTurnAndConversation(
          db,
          userId,
          input
        );

        // Platform key: all users share the same model.
        // BYOK disabled — restore getDecryptedLlmCredential() here when re-enabling.
        const _openaiPreset = LLM_PROVIDER_PRESETS.openai;
        const credential = {
          id: "platform",
          provider: "openai" as const,
          label: null,
          apiKey: env.OPENAI_API_KEY ?? "",
          apiKeyLast4: (env.OPENAI_API_KEY ?? "").slice(-4),
          baseUrl: _openaiPreset.baseUrl,
          defaultModel: "gpt-4o-mini",
        };

        if (!credential.apiKey) {
          throw new Error("AI Chat is not configured. Contact support.");
        }

        // Build everything we need for the first provider call in parallel.
        // The tool registry includes Signa over MCP (best-effort — empty
        // list if the upstream is down) plus the static Alpaca read tools.
        const [stockContext, resolvedConversation, toolBundle] =
          await Promise.all([
            buildStockChatContext({
              db,
              userId,
              alpacaCredentialId: input.alpacaCredentialId,
              activeAccountType: input.activeAccountType,
              activeSymbol,
              selectedSignal: input.selectedSignal,
            }),
            conversationPromise,
            buildToolRegistry(),
          ]);

        conversationId = resolvedConversation.conversationId;
        contextSources = stockContext.sources;
        contextWarnings = stockContext.warnings;

        const preset = getLlmProviderPreset(credential.provider);
        const providerPreset = {
          ...preset,
          baseUrl: credential.baseUrl,
          defaultModel: credential.defaultModel,
        };
        providerLabel = providerPreset.label;
        providerModel = providerPreset.defaultModel;

        const toolDefs: LlmToolDefinition[] = toolBundle.handlers.map(
          (h) => h.definition as unknown as LlmToolDefinition
        );
        toolNamesForMetadata = toolDefs.map((t) => t.function.name);

        controller.enqueue(
          sse({
            type: "meta",
            provider: providerPreset.label,
            model: providerPreset.defaultModel,
            warnings: stockContext.warnings,
            sources: stockContext.sources,
            conversationId,
            tools: toolNamesForMetadata,
          })
        );

        const toolCtx: ToolExecutionContext = {
          db,
          userId,
          alpacaCredentialId: input.alpacaCredentialId,
          activeAccountType: input.activeAccountType,
          activeSymbol,
        };

        // Build the running message list. The system prompt advertises the
        // available tool names so the LLM has them top-of-mind.
        const sysPrompt = systemPrompt(
          stockContext.context,
          stockContext.warnings,
          toolNamesForMetadata
        );

        const conversation: LlmChatMessage[] = [
          { role: "system", content: sysPrompt },
          ...compactMessages(input.messages),
        ];
        // Seed the tool privacy boundary from durable, server-owned state:
        // the conversation row's `tenantPrivateDataSeen` flag (raised when
        // broker context was ever loaded into the system prompt or when a
        // tenant_private tool call succeeded on any earlier turn) OR this
        // turn's own broker-credential attachment. The client's request body
        // can only raise the boundary, never lower it. For turns without a
        // conversation row (persistence unavailable on a brand-new chat) the
        // seed falls back to this turn's credential state alone, and an
        // unreadable EXISTING conversation fails closed inside
        // `persistUserTurnAndConversation`.
        toolPrivacyState = createToolPrivacyState(
          resolvedConversation.tenantPrivateDataSeen ||
            Boolean(input.alpacaCredentialId),
        );
        // Track whether the durable row already records the flag so the tool
        // loop only writes it once, the first time private data appears.
        privacyFlagDurable =
          resolvedConversation.flagDurable &&
          resolvedConversation.tenantPrivateDataSeen;

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          const { content, toolCalls, finishReason } = await streamOneCompletion({
            controller,
            apiKey: credential.apiKey,
            preset: providerPreset,
            messages: conversation,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            signal,
          });

          if (content) lastAssistantText = content;

          if (toolCalls.length === 0) {
            // Plain text reply — we're done.
            break;
          }

          // Append the assistant's tool-call turn to the running history so
          // the provider can match `tool_call_id`s on the next round.
          conversation.push({
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls,
          });

          // Execute each tool and append a `tool` message back. We run them
          // sequentially for determinism and to keep error reporting clear.
          for (const tc of toolCalls) {
            const { tool_call_id, resultJson } = await executeToolCall(
              controller,
              toolBundle.registry,
              tc,
              toolCtx,
              toolPrivacyState,
            );
            conversation.push({
              role: "tool",
              tool_call_id,
              content: resultJson,
            });

            // The moment a tenant_private tool result raises the in-memory
            // boundary, record it on the conversation row so every later turn
            // seeds closed even if the client detaches the credential.
            if (
              toolPrivacyState.tenantPrivateDataSeen &&
              !privacyFlagDurable &&
              conversationId
            ) {
              privacyFlagDurable = await persistPrivacyFlag(
                db,
                userId,
                conversationId
              );
            }
          }

          // If the provider explicitly said it's done with a non-tool stop,
          // bail (defensive: shouldn't happen, but covers weird providers).
          if (finishReason && finishReason !== "tool_calls") break;
        }

        // BYOK: when user-supplied keys return, restore the lastUsedAt update here.
        // await db
        //   .update(schema.userLlmApiCredentials)
        //   .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        //   .where(and(eq(schema.userLlmApiCredentials.id, credential.id), eq(schema.userLlmApiCredentials.userId, userId)));

        controller.enqueue(sse({ type: "done" }));
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : "Chat request failed";
        // Prefix with which phase failed so the UI can tell the user exactly
        // what broke: [Setup] for credential/context errors before we reach the
        // provider, [ProviderLabel / model] for LLM-side errors.
        const phase = providerLabel
          ? `[${providerLabel}${providerModel ? ` / ${providerModel}` : ""}]`
          : "[Setup]";
        didError = `${phase} ${rawMsg}`;
        controller.enqueue(sse({ type: "error", message: didError }));
      } finally {
        // Last-chance durable privacy write: if a tenant_private result (or a
        // fail-closed seed) raised the in-memory boundary this turn but the
        // row write hasn't landed yet, retry once before closing out.
        if (
          toolPrivacyState?.tenantPrivateDataSeen &&
          !privacyFlagDurable &&
          conversationId
        ) {
          await persistPrivacyFlag(db, userId, conversationId);
        }
        // Persist whatever we managed to accumulate, even on mid-stream
        // error. The user already saw `lastAssistantText` rendered token
        // by token — losing it on reload would be jarring. Flagged with a
        // metadata `error` so the UI can later render a "Reply truncated"
        // hint when loading.
        if (conversationId && lastAssistantText.trim()) {
          try {
            await db.insert(schema.chatMessages).values({
              conversationId,
              role: "assistant",
              content: lastAssistantText,
              metadata: {
                provider: providerLabel,
                model: providerModel,
                sources: contextSources,
                warnings: contextWarnings,
                tools: toolNamesForMetadata,
                ...(didError ? { error: didError } : {}),
              },
            });
            await db
              .update(schema.chatConversations)
              .set({ updatedAt: new Date() })
              .where(
                and(
                  eq(schema.chatConversations.id, conversationId),
                  eq(schema.chatConversations.userId, userId)
                )
              );
          } catch (err) {
            console.error("[chat] failed to persist assistant turn:", err);
          }
        }
        controller.close();
      }
    },
  });
}
