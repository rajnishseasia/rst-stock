/**
 * Per-provider "how to get your API key" guide, shown in Settings under the
 * LLM Provider Keys section once a provider is selected. Data-driven so adding
 * a provider preset on the server only needs a matching entry here.
 */

interface ProviderGuide {
  name: string;
  url: { href: string; label: string };
  steps: string[];
  keyFormat: string;
  /** Rough cost at ~10 messages/day, for light testing. */
  cost: string;
}

const GUIDES: Record<string, ProviderGuide> = {
  openai: {
    name: "OpenAI GPT-4o mini",
    url: { href: "https://platform.openai.com/api-keys", label: "OpenAI Platform" },
    steps: [
      "Create or sign in to your OpenAI account.",
      "Add a payment method under Billing.",
      "Navigate to API Keys.",
      'Click "Create new secret key".',
      "Copy the key immediately.",
      "Paste it into the API Key field above.",
    ],
    keyFormat: "sk-xxxxxxxxxxxxxxxx",
    cost: "~10 messages/day: typically under $1/month for light testing.",
  },
  anthropic: {
    name: "Anthropic Claude Haiku 4.5",
    url: { href: "https://console.anthropic.com/settings/keys", label: "Anthropic Console" },
    steps: [
      "Create an Anthropic account.",
      "Add billing information.",
      "Open API Keys.",
      'Click "Create Key".',
      "Copy the generated key.",
      "Paste it into the API Key field above.",
    ],
    keyFormat: "sk-ant-xxxxxxxxxxxx",
    cost: "~10 messages/day: roughly $1–5/month depending on prompt size.",
  },
  minimax: {
    name: "MiniMax M3",
    url: { href: "https://www.minimax.io/platform", label: "MiniMax Open Platform" },
    steps: [
      "Create a MiniMax account.",
      "Complete email verification.",
      "Open API Management.",
      "Create an API Key.",
      "Copy the key.",
      "Paste it into the API Key field above.",
    ],
    keyFormat: "xxxxxxxxxxxxxxxx",
    cost: "~10 messages/day: usually a few dollars/month - often cheaper than premium frontier models.",
  },
  deepseek: {
    name: "DeepSeek V4 Pro",
    url: { href: "https://platform.deepseek.com/api_keys", label: "DeepSeek Platform" },
    steps: [
      "Create a DeepSeek account.",
      "Add credits.",
      "Navigate to API Keys.",
      'Click "Create API Key".',
      "Copy the key immediately.",
      "Paste it into the API Key field above.",
    ],
    keyFormat: "sk-xxxxxxxxxxxxxxxx",
    cost: "~10 messages/day: usually $1–3/month.",
  },
};

export function LlmProviderGuide({ provider }: { provider: string }) {
  const guide = GUIDES[provider];
  if (!guide) return null;

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">How to get your {guide.name} key</span>
        <a
          href={guide.url.href}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap text-xs text-primary hover:underline"
        >
          {guide.url.label} ↗
        </a>
      </div>
      <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
        {guide.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        Key format:{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
          {guide.keyFormat}
        </code>
      </p>
      <p className="text-xs text-muted-foreground">
        Estimated cost - {guide.cost}
      </p>
    </div>
  );
}
