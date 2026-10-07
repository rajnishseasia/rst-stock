import type { LlmProvider, LlmProviderPreset } from "./providers.js";

/**
 * Message shape we send to provider chat-completion endpoints. We expand
 * beyond the original `system | user | assistant` set to support the
 * tool-calling round-trip:
 *   - `assistant` messages can include a `tool_calls` array when the model
 *     asked us to run something.
 *   - `tool` messages carry the structured result back, addressed by the
 *     same call id.
 */
export type LlmChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: AssistantToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * OpenAI-style tool definition. Mirrors the `ToolDefinition` from
 * `chat/tools/types.ts`; defined here too so the LLM client doesn't
 * cross-depend on the chat module.
 */
export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type ChatCompletionOptions = {
  apiKey: string;
  preset: LlmProviderPreset;
  messages: LlmChatMessage[];
  stream: boolean;
  signal?: AbortSignal;
  /**
   * Optional function-calling tool list. If present we send `tools` and
   * `tool_choice: "auto"`. Provider may or may not honor it — gracefully
   * ignored downstream when not.
   */
  tools?: LlmToolDefinition[];
  /** Override the default output-token cap. Necessary for tool-calling
   *  paths where a sub-24-token reply (the validate-key default) is
   *  obviously insufficient. */
  maxOutputTokens?: number;
};

function chatCompletionsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function providerExtraBody(provider: LlmProvider) {
  if (provider === "minimax") {
    return {
      reasoning_split: true,
    };
  }

  if (provider === "deepseek") {
    return {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    };
  }

  return {};
}

function buildChatCompletionBody(options: ChatCompletionOptions) {
  // The historic default of 24 tokens for non-streaming was only ever right
  // for the API-key health check — for tool-calling round trips we need
  // room for a real reply. Callers should pass `maxOutputTokens` explicitly
  // when they know better.
  const defaultMax = options.stream ? 2200 : 24;
  const maxOutputTokens = options.maxOutputTokens ?? defaultMax;
  const tokenLimit =
    options.preset.provider === "minimax"
      ? { max_completion_tokens: maxOutputTokens }
      : { max_tokens: maxOutputTokens };

  const body: Record<string, unknown> = {
    model: options.preset.defaultModel,
    messages: options.messages,
    stream: options.stream,
    temperature: 0.2,
    ...tokenLimit,
    ...providerExtraBody(options.preset.provider),
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }

  return body;
}

async function readProviderError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return response.statusText;
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return response.statusText;
  }
}

export async function createChatCompletionResponse(options: ChatCompletionOptions) {
  const response = await fetch(chatCompletionsUrl(options.preset.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildChatCompletionBody(options)),
    signal: options.signal,
  });

  if (!response.ok) {
    const message = await readProviderError(response);
    throw new Error(`${options.preset.label} returned ${response.status}: ${message}`);
  }

  if (options.stream && !response.body) {
    throw new Error(`${options.preset.label} did not return a response stream`);
  }

  return response;
}

export async function validateLlmApiKey(apiKey: string, preset: LlmProviderPreset) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    await createChatCompletionResponse({
      apiKey,
      preset,
      stream: false,
      signal: controller.signal,
      messages: [
        {
          role: "system",
          content: "Reply with the single word ok.",
        },
        {
          role: "user",
          content: "Health check.",
        },
      ],
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function extractChatDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";

  const firstChoice = choices[0] as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
  };
  const content = firstChoice.delta?.content ?? firstChoice.message?.content;

  if (typeof content === "string") return stripReasoningTags(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

/**
 * Pull the `tool_calls` delta out of a streamed chat completion chunk.
 * DeepSeek (and OpenAI-style providers in general) stream tool calls as
 * partial entries with the same `index` across chunks — we surface them in
 * raw form so the caller can merge by index. Returns null when there are
 * no tool-call deltas in this chunk.
 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  /** A fragment of the JSON-string `arguments`; concatenate across deltas. */
  argumentsDelta?: string;
}

export function extractToolCallDeltas(payload: unknown): ToolCallDelta[] | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as {
    delta?: { tool_calls?: unknown };
    message?: { tool_calls?: unknown };
  };
  const rawCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return null;

  const out: ToolCallDelta[] = [];
  for (const c of rawCalls) {
    if (!c || typeof c !== "object") continue;
    const obj = c as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    // If the provider doesn't emit an explicit numeric index we can't safely
    // merge partial argument fragments across chunks — a synthetic index
    // (out.length) collides across chunk boundaries and would concat the
    // arguments of two different calls into one. Skip rather than corrupt.
    if (typeof obj.index !== "number") continue;
    out.push({
      index: obj.index,
      id: obj.id,
      name: obj.function?.name,
      argumentsDelta: obj.function?.arguments,
    });
  }
  return out;
}

/**
 * Pull `finish_reason` out of a streamed chunk (so the chat loop knows when
 * to stop waiting for tool_call deltas and actually execute them). Returns
 * null if the chunk doesn't carry one yet.
 */
export function extractFinishReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === "string" ? reason : null;
}

function stripReasoningTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "");
}
