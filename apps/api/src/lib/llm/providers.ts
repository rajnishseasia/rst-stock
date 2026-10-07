/**
 * LLM provider presets.
 *
 * Every provider here is reachable via an OpenAI-style
 * `POST {baseUrl}/chat/completions` endpoint with `Authorization: Bearer ...`.
 * That lets the chat client (`./client.ts`) speak to all of them through a
 * single code path:
 *
 *   - **OpenAI** — native shape, no translation.
 *   - **Anthropic** — exposes an OpenAI-compatible endpoint at
 *     `https://api.anthropic.com/v1/` that maps tool-calls / tool-results to
 *     OpenAI shape, so we don't need a separate Anthropic SDK.
 *   - **DeepSeek** / **MiniMax** — both ship OpenAI-compatible APIs already.
 *
 * Adding a new provider is one preset entry here + (if the wire format needs
 * any quirks) an entry in `providerExtraBody` / `providerExtraHeaders` in
 * `./client.ts`. The Settings UI reads the provider list from the
 * `llm-credentials` tRPC router which iterates this map, so it picks up new
 * providers without further UI changes.
 *
 * Default models are picked to optimise the *price × tool-use reliability*
 * trade-off, not raw quality. Users can override per-credential via the API
 * if they want a bigger model.
 */
export const LLM_PROVIDER_PRESETS = {
  openai: {
    provider: "openai",
    label: "OpenAI GPT-4o mini",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  anthropic: {
    provider: "anthropic",
    label: "Anthropic Claude Haiku 4.5",
    // Anthropic's OpenAI-compat shim — accepts the same `/chat/completions`
    // payload shape (tools, tool_choice, streamed `tool_calls` deltas) and
    // translates internally. Native messages API would need its own adapter;
    // this lets us reuse the OpenAI code path verbatim.
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-haiku-4-5",
  },
  minimax: {
    provider: "minimax",
    label: "MiniMax M3",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M3",
  },
  deepseek: {
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
  },
} as const;

export type LlmProvider = keyof typeof LLM_PROVIDER_PRESETS;
export type LlmProviderPreset = {
  provider: LlmProvider;
  label: string;
  baseUrl: string;
  defaultModel: string;
};

export const LLM_PROVIDERS = Object.keys(LLM_PROVIDER_PRESETS) as LlmProvider[];

export function getLlmProviderPreset(provider: LlmProvider): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS[provider];
}

export function isLlmProvider(provider: string): provider is LlmProvider {
  return provider in LLM_PROVIDER_PRESETS;
}
