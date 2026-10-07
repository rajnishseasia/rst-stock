"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  Eraser,
  ExternalLink,
  LoaderCircle,
  Plus,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { SelectedSignal } from "@/components/feed/signal-feed";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { applyGeneratedDraft } from "./stock-chat-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
// BYOK removed: Select + model-related DropdownMenu items unused until BYOK returns.
// import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  // DropdownMenuLabel,        // unused until BYOK model selector returns
  // DropdownMenuRadioGroup,   // unused until BYOK model selector returns
  // DropdownMenuRadioItem,    // unused until BYOK model selector returns
  // DropdownMenuSeparator,    // unused until BYOK model selector returns
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ChatMarkdown } from "./chat-markdown";

/**
 * Tool-call event rendered inline within an assistant message bubble so the
 * user can see exactly what the agent ran on their behalf ("Calling
 * alpaca_list_positions…" → "✓ 3 positions · $4,201"). Keyed by the
 * provider's stable call id so the result frame can find the right entry.
 */
interface ToolCallEntry {
  id: string;
  name: string;
  args?: Record<string, unknown> | null;
  /** When undefined the call is still in-flight. */
  ok?: boolean;
  display?: string;
  error?: string;
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallEntry[];
};

type ChatActivity = {
  role: "user" | "assistant";
  content?: string | null;
  toolCalls?: readonly unknown[];
};

export function shouldShowChatSuggestions(messages: readonly ChatActivity[]) {
  return !messages.some(
    (message) =>
      Boolean(message.content?.trim()) || Boolean(message.toolCalls?.length),
  );
}

/**
 * Tailwind classes for one message body in the transcript.
 *
 * Every user turn used to be a solid `bg-primary` bubble, so a real
 * conversation was a stack of gold slabs down the right edge of the panel
 * (DESIGN.md: gold is a seasoning, not a sauce, and it never fills). The turn
 * is now a neutral bubble with a gold rail on its leading edge: the accent
 * still says whose turn it is, at an accent's dose.
 *
 * This panel is mounted by both the mobile and the desktop shells and the rule
 * is identical on both, so there is no breakpoint variant here.
 */
export function chatMessageBodyClassName(isAssistant: boolean): string {
  return isAssistant
    ? "py-1 text-foreground"
    : "whitespace-pre-wrap rounded-lg rounded-l-sm border-l-2 border-primary bg-muted px-3 py-2 text-foreground";
}

type ResearchSource = {
  id: string;
  type: "filing" | "news";
  title: string;
  url: string;
  date: string | null;
  source: string;
};

/**
 * Prefill payload the `draft_order` tool emits on its `tool_result` frame. The
 * server never submits anything: it hands the browser these fields, which we
 * map straight into the trade ticket's `initial*` props for the user to review
 * and submit by hand. Mirrors `OrderDraftPrefill` in the api tool types.
 */
export type ChatOrderDraft = {
  symbol: string;
  side: "buy" | "sell";
  /** Explicit position intent: "short" means OPEN a short (SellShort ticket),
   *  not close a long. null preserves plain buy/sell behavior. */
  direction: "long" | "short" | null;
  quantity: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  orderType: "Market" | "Limit" | "OCO";
  /** Entry-leg type for an OCO ticket, so a limit bracket keeps its Limit
   *  entry. null for non-OCO tickets. */
  entryOrderType: "Market" | "Limit" | null;
  limitPrice: number | null;
  /** Time in force for the ticket, so a DAY draft doesn't silently fall back
   *  to the form's GTC default. Optional for older server payloads. */
  timeInForce?: "day" | "gtc" | null;
};

type ToolUiDirective = { type: "order_draft"; draft: ChatOrderDraft };

type StreamPayload =
  | {
      type: "meta";
      provider: string;
      model: string;
      warnings?: string[];
      sources?: ResearchSource[];
      conversationId?: string;
      tools?: string[];
    }
  | { type: "delta"; delta: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args?: Record<string, unknown> | null;
      error?: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      display?: string;
      error?: string;
      /** Optional client-directed action (e.g. an order-draft prefill). */
      ui?: ToolUiDirective;
    }
  | { type: "error"; message: string }
  | { type: "done" };

type StockChatPanelProps = {
  isSignedIn: boolean;
  selectedSignal: SelectedSignal | null;
  activeSymbol?: string;
  activeCredentialId?: string;
  activeAccountType?: "PAPER" | "LIVE";
  activeAccountLabel?: string;
  draftPrompt?: { id: number; text: string } | null;
  /**
   * Called when the `draft_order` tool returns an order-draft prefill. The
   * parent maps it into the trade ticket's `initial*` props (symbol, side,
   * qty, entry, stop, target). This ONLY pre-fills the form: the user still
   * reviews and submits manually. Nothing here places an order.
   */
  onDraftOrder?: (draft: ChatOrderDraft) => void;
  /**
   * When true, the outer Card sizes itself to fill its parent (used by the
   * floating chat overlay) instead of using the page-height calc the
   * standalone tab variant relies on.
   */
  embedded?: boolean;
  /**
   * When provided and `embedded` is true, renders a close button (X) in the
   * embedded header so the panel can dismiss itself. This replaces the outer
   * popout header, avoiding a double-header stacking issue.
   */
  onClose?: () => void;
};

/**
 * Outer Card sizing. The tab-mode (default) uses viewport-height math so the
 * panel fills the middle column; the overlay-mode (embedded) just fills
 * whatever fixed-position frame the parent gave it.
 */
const PAGE_CARD_HEIGHT = "h-[calc(100vh-8rem)] max-h-[900px] lg:min-h-[680px]";
const EMBED_CARD_HEIGHT = "h-full max-h-full";

function parseSseBuffer(buffer: string, onPayload: (payload: StreamPayload) => void) {
  const blocks = buffer.split(/\n\n/);
  const remainder = blocks.pop() || "";

  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) continue;

    try {
      onPayload(JSON.parse(dataLines.join("\n")) as StreamPayload);
    } catch {
      // Ignore malformed frames from the stream.
    }
  }

  return remainder;
}

/**
 * Build the empty-state suggested prompts. We tailor by the user's current
 * focus: if a ticker is active (selected signal or chart symbol) we lead with
 * symbol-specific prompts; otherwise we lead with portfolio-wide questions.
 *
 * Each prompt is structured to exercise either the Alpaca tools (account /
 * positions / orders), the Signa tools (signals / flow / scans), or both -
 * the demo-by-doing tour of what the agent can actually do. Clicking a chip
 * sends the prompt directly (one-click) rather than just prefilling the
 * textarea, since the chips are deliberately curated and the user can always
 * stop a stream and re-send if they meant something else.
 */
interface SuggestedPrompt {
  /** Human-readable label shown on the chip. */
  label: string;
  /** Full prompt actually sent to the agent. */
  prompt: string;
}

function suggestedPrompts(symbol?: string): SuggestedPrompt[] {
  if (symbol) {
    const tag = `$${symbol}`;
    return [
      {
        label: `Signa verdict on ${tag}`,
        prompt: `Pull the Signa signal for ${tag} and explain the multi-agent verdict. Include the trade plan (entry/stop/target) and what would invalidate the setup.`,
      },
      {
        label: `Options flow on ${tag}`,
        prompt: `Show me unusual options flow on ${tag} right now. Highlight any large sweeps or blocks, and tell me whether smart money looks bullish or bearish.`,
      },
      {
        label: `Should I buy ${tag}?`,
        prompt: `I'm thinking about a position in ${tag}. Pull the latest quote, recent bars, and the Signa signal, then tell me what a sensible entry, stop, and target would look like.`,
      },
      {
        label: `News & catalysts for ${tag}`,
        prompt: `What's moving ${tag} today? Cite filings or news and tell me if the move looks sustainable.`,
      },
      {
        label: `Trade idea for ${tag}`,
        prompt: `Use ticker_trade_idea to build a concise trade-idea readout for ${tag}: trend, where it sits in its recent range, recent news, and any signals. Keep it to a short readout.`,
      },
      {
        label: `Draft a starter order in ${tag}`,
        prompt: `Draft a small starter buy in ${tag}: pull the latest quote, pick a sensible stop, size it to about $100 of risk, and pre-fill the trade ticket so I can review it. Do not submit anything.`,
      },
    ];
  }
  return [
    {
      label: "Grade my holdings with Signa",
      prompt: "Pull my Alpaca positions, then run signa_get_signal on each ticker. Rank them by Signa's confluence score and tell me which look strongest and which look weakest.",
    },
    {
      label: "Today's top bullish setups",
      prompt: "Use signa_scan_symbols to find today's strongest bullish setups across the market. For the top 3, include the trade plan (entry/stop/target) and a one-line rationale.",
    },
    {
      label: "Account & buying power",
      prompt: "Pull my Alpaca account summary and open positions. How much buying power do I have versus my current exposure?",
    },
    {
      label: "Unusual options flow",
      prompt: "Show me the most notable unusual options flow happening right now. Focus on large sweeps and blocks, and group by ticker so I can see where conviction is concentrated.",
    },
    {
      label: "Morning briefing",
      prompt: "Give me my morning briefing. Pull my account summary, open positions, and Signa's top picks for today. Highlight anything urgent and end with three things I should consider this session.",
    },
  ];
}

/**
 * Slash-command sugar: typing `/scan`, `/briefing`, etc. into the textarea
 * shows a quick-pick menu. Selecting one replaces the input with a fully-
 * formed natural-language prompt - the agent then uses its tools to answer.
 * No special server handling needed; these are pure prompt prefills.
 */
interface SlashCommand {
  /** Trigger token (with leading slash). */
  trigger: string;
  /** Short human label shown in the picker. */
  label: string;
  /** One-line explanation rendered as the dropdown item's secondary text. */
  hint: string;
  /** Build the prompt the user will send. `symbol` is the active ticker, if any. */
  build(symbol: string | undefined): string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    trigger: "/briefing",
    label: "/briefing",
    hint: "Morning briefing: account, positions, top Signa picks, news for held tickers",
    build: () =>
      "Give me my morning briefing. Use your tools to pull my account summary, open positions, open orders, watchlist, and Signa's best picks for today. Highlight anything urgent and end with three things I should consider this session.",
  },
  {
    trigger: "/positions",
    label: "/positions",
    hint: "Review my open positions and flag anything needing attention",
    build: () =>
      "Pull my open positions and walk me through them. Flag anything where the unrealized P&L looks unusual, where my stop is at risk, or where today's price action diverges from my thesis.",
  },
  {
    trigger: "/scan",
    label: "/scan",
    hint: "Scan my watchlist for setups using Signa",
    build: () =>
      "Scan my watchlist with Signa's tools and surface the strongest LONG setups right now. For the top 3, include the trade plan (entry/stop/target) and a one-line rationale.",
  },
  {
    trigger: "/position",
    label: "/position $SYM",
    hint: "Deep dive on a single position (current symbol if one is selected)",
    build: (symbol) =>
      symbol
        ? `Deep dive on my $${symbol} position. Use your tools to get the position details, the latest quote, recent bars, and any Signa signal. Tell me what's working, what's at risk, and whether I should adjust my stop or take profit.`
        : "Deep dive on a specific position. Tell me which ticker you'd like me to analyze.",
  },
  {
    trigger: "/signal",
    label: "/signal $SYM",
    hint: "Pull a Signa signal for the current symbol and explain it",
    build: (symbol) =>
      symbol
        ? `Pull the Signa signal for $${symbol} and explain it. What's the multi-agent consensus, where's the trade plan (entry/stop/target), and what would invalidate the setup?`
        : "Pull a Signa signal. Tell me which ticker.",
  },
  {
    trigger: "/idea",
    label: "/idea $SYM",
    hint: "Concise trade-idea readout: trend, news, and signals for a ticker",
    build: (symbol) =>
      symbol
        ? `Use ticker_trade_idea to give me a concise trade-idea readout for $${symbol}: trend, distance from the recent range, recent news, and any signals.`
        : "Build a trade-idea readout. Tell me which ticker.",
  },
  {
    trigger: "/risk",
    label: "/risk",
    hint: "What-if risk & R:R calculator for an entry/stop/target",
    build: (symbol) =>
      `Use risk_calculator to run the risk and reward on a trade${
        symbol ? ` in $${symbol}` : ""
      }. Ask me for the entry, stop, target, and either a share count or a max-risk budget if I haven't given them.`,
  },
  {
    trigger: "/draft",
    label: "/draft $SYM",
    hint: "Draft an order and pre-fill the ticket (you still review & submit)",
    build: (symbol) =>
      symbol
        ? `Draft an order in $${symbol} and pre-fill the trade ticket for me to review. Ask me for side, size (or a max-risk budget), and a stop/target if I haven't said. Do not submit it.`
        : "Draft an order and pre-fill the ticket. Tell me the ticker, side, and size (or a risk budget). Do not submit it.",
  },
];

function matchSlashCommand(input: string): SlashCommand[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];
  const lower = trimmed.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.trigger.startsWith(lower));
}

/** Inline list of tool calls under the streaming assistant message. */
function ToolCallList({ calls }: { calls: ToolCallEntry[] }) {
  return (
    <div className="mt-3 divide-y divide-border/50 border-y border-border/50">
      {calls.map((c) => {
        const inflight = c.ok === undefined;
        const failed = c.ok === false;
        return (
          <div
            key={c.id}
            className="flex items-start gap-2 py-2 text-2xs leading-snug"
          >
            {inflight ? (
              <Wrench className="mt-0.5 h-3 w-3 animate-pulse text-primary" />
            ) : failed ? (
              <AlertCircle className="mt-0.5 h-3 w-3 text-destructive" />
            ) : (
              <Check className="mt-0.5 h-3 w-3 text-green-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-mono text-3xs text-muted-foreground">
                {c.name}
              </div>
              <div className="break-words text-foreground/90">
                {failed
                  ? c.error || "Tool failed."
                  : c.display || (inflight ? "Running…" : "Done.")}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Copy-to-clipboard button shown on hover of an assistant message. */
function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked by the browser (e.g. insecure context);
      // there's nothing useful we can do - silently no-op.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-60 transition-[color,opacity] duration-150 hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function ChatPanelState({
  cardHeight,
  description,
  actionHref,
  loading = false,
  onClose,
}: {
  cardHeight: string;
  description: string;
  actionHref?: "/settings" | "/settings?t=models";
  loading?: boolean;
  onClose?: () => void;
}) {
  return (
    <Card className={cn("relative flex items-center justify-center gap-0 py-0", cardHeight)}>
      {onClose && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          title="Close AI assistant"
          aria-label="Close AI assistant"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
      <div
        className="flex max-w-sm flex-col items-center gap-3 px-6 py-10 text-center"
        role={loading ? "status" : undefined}
        aria-live={loading ? "polite" : undefined}
      >
        {loading ? (
          <LoaderCircle className="h-5 w-5 animate-spin text-primary" />
        ) : (
          <Bot className="h-5 w-5 text-muted-foreground" />
        )}
        <div className="space-y-1">
          <div className="font-display text-sm font-medium">AI Chat</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        {actionHref && (
          <Button asChild size="sm" variant="outline">
            <Link href={actionHref}>
              <Settings className="h-3.5 w-3.5" />
              Open Settings
            </Link>
          </Button>
        )}
      </div>
    </Card>
  );
}

export function StockChatPanel({
  isSignedIn,
  selectedSignal,
  activeSymbol: activeSymbolOverride,
  activeCredentialId,
  activeAccountType,
  activeAccountLabel,
  draftPrompt,
  onDraftOrder,
  embedded = false,
  onClose,
}: StockChatPanelProps) {
  const cardHeight = embedded ? EMBED_CARD_HEIGHT : PAGE_CARD_HEIGHT;
  // BYOK removed: platform provides gpt-4o-mini for all users.
  // const [selectedLlmCredentialId, setSelectedLlmCredentialId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [providerInfo, setProviderInfo] = useState<{ provider: string; model: string } | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  /**
   * Index of the currently-highlighted slash-command suggestion. Arrow keys
   * cycle through it; Enter/Tab confirms. Resets to 0 whenever the visible
   * suggestion list changes (e.g. user types more characters to narrow it).
   */
  const [slashIndex, setSlashIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutoDraftRef = useRef<string | null>(null);
  const trpcUtils = trpc.useUtils();
  // Token-id of the currently in-flight stream. Switching conversations or
  // starting a new chat increments this; the SSE handler below ignores
  // payloads tagged with a stale id so a slow tail can't graft tokens onto
  // a freshly loaded transcript.
  const streamSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // BYOK disabled: platform supplies the LLM key. Re-enable this query when
  // user-supplied keys return (and restore llmCredentialId in the fetch body).
  // const llmCredentialsQuery = trpc.llmCredentials.list.useQuery(undefined, {
  //   enabled: isSignedIn && !!activeCredentialId,
  // });
  // const llmCredentials = llmCredentialsQuery.data ?? [];
  // const selectedLlmCredential = useMemo(() => {
  //   return llmCredentials.find((c) => c.id === selectedLlmCredentialId) || llmCredentials[0];
  // }, [llmCredentials, selectedLlmCredentialId]);

  // The API schema allows OPENAI_API_KEY to be unset, in which case
  // createStockChatStream fails only after the user submits a message. Check
  // status up front so the panel can show an unavailable state instead.
  const modelStatusQuery = trpc.llmCredentials.platformStatus.useQuery(undefined, {
    enabled: isSignedIn,
  });

  // Saved-conversation sidebar. The query is intentionally non-blocking: the
  // panel renders whether or not the conversations router exists yet (server
  // simply returns an empty list), so this stays robust if the rollout
  // hits the client before the API is upgraded.
  const conversationsQuery = trpc.chatConversations.list.useQuery(undefined, {
    enabled: isSignedIn,
  });
  const conversations = conversationsQuery.data ?? [];

  const canSend = Boolean(input.trim() && !isStreaming);
  const activeSymbol = activeSymbolOverride || selectedSignal?.symbol;
  const promptChips = useMemo(() => suggestedPrompts(activeSymbol), [activeSymbol]);
  const showPromptSuggestions = shouldShowChatSuggestions(messages);
  // Slash-command quick-pick. Empty array hides the popover.
  const slashMatches = useMemo(() => matchSlashCommand(input), [input]);

  // Keep the highlighted slash index in range whenever the visible suggestion
  // list changes (typing more characters narrows it). Without this clamp the
  // arrow-key handler could point past the end of the list.
  useEffect(() => {
    setSlashIndex((index) => {
      if (slashMatches.length === 0) return 0;
      return Math.min(index, slashMatches.length - 1);
    });
  }, [slashMatches.length]);

  /**
   * Confirm the highlighted slash suggestion: swap the input with the canned
   * prompt and refocus the textarea so the user can immediately edit or send.
   * Returns false if there's nothing to pick (caller can fall through to the
   * default key behavior).
   */
  const applySlashSuggestion = useCallback(
    (cmd: SlashCommand) => {
      const prompt = cmd.build(activeSymbol);
      setInput(prompt);
      // Defer focus so the new value is committed before we move the caret to
      // the end - otherwise the caret can land before the inserted text.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(prompt.length, prompt.length);
      });
    },
    [activeSymbol]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isStreaming, sources, warnings]);

  useEffect(() => {
    if (draftPrompt?.text) {
      // Insert generated prompts when the box is empty, and replace the
      // previous generated prompt when the user switches symbols. Preserve
      // anything the user has manually typed over the suggestion.
      setInput((current) => {
        const result = applyGeneratedDraft(
          current,
          lastAutoDraftRef.current,
          draftPrompt.text,
        );
        if (result.accepted) {
          lastAutoDraftRef.current = draftPrompt.text;
        }
        return result.value;
      });
    }
  }, [draftPrompt]);

  /**
   * Cancel any in-flight stream and bump the seq so its still-arriving
   * tokens don't graft onto whatever transcript we just switched to.
   * Called before every navigation away from the current chat.
   */
  const stopActiveStream = useCallback(() => {
    streamSeqRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const startNewConversation = useCallback(() => {
    stopActiveStream();
    setConversationId(null);
    setMessages([]);
    setSources([]);
    setWarnings([]);
    setProviderInfo(null);
    setError(null);
  }, [stopActiveStream]);

  const loadConversation = useCallback(
    async (id: string) => {
      if (id === conversationId) return;
      stopActiveStream();
      try {
        const full = await trpcUtils.chatConversations.get.fetch({ id });
        if (!full) return;
        setConversationId(full.id);
        setMessages(
          full.messages.map((m) => ({ role: m.role, content: m.content }))
        );
        // Sources/warnings are per-turn; previous turns' source list was
        // already rendered inline. Clear so we don't display stale "Sources
        // available to cite" against a loaded transcript.
        setSources([]);
        setWarnings([]);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load conversation");
      }
    },
    [conversationId, trpcUtils.chatConversations.get, stopActiveStream]
  );

  const deleteConversationMutation = trpc.chatConversations.delete.useMutation({
    onSuccess: () => {
      conversationsQuery.refetch();
    },
  });

  async function handleSend(maybeText?: string) {
    const draft = (maybeText ?? input).trim();
    if (!draft || isStreaming) return;

    const userMessage: ChatMessage = { role: "user", content: draft };
    const nextMessages = [...messages, userMessage];

    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setSources([]);
    setWarnings([]);
    setProviderInfo(null);
    setIsStreaming(true);

    // Mint a per-request token. Any state mutation inside this stream's
    // handler bails when the token no longer matches the current one -
    // that's how we keep a slow tail from grafting onto a freshly loaded
    // conversation when the user clicks a sidebar entry mid-stream.
    const seq = ++streamSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrent = () => streamSeqRef.current === seq;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // llmCredentialId removed: platform provides the model key (BYOK disabled)
          messages: nextMessages,
          alpacaCredentialId: activeCredentialId,
          activeAccountType,
          activeSymbol,
          conversationId,
          selectedSignal: selectedSignal
            ? {
                signalId: selectedSignal.signalId,
                symbol: selectedSignal.symbol,
                content: selectedSignal.content,
              }
            : undefined,
        }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Chat request failed with ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handlePayload = (payload: StreamPayload) => {
        // Bail early if the user navigated away (loadConversation,
        // startNewConversation) while this stream was still arriving.
        if (!isCurrent()) return;

        if (payload.type === "meta") {
          setSources(payload.sources || []);
          setWarnings(payload.warnings || []);
          // The server returns the (possibly newly-created) conversation id
          // on the meta frame so the first turn of a new chat is persisted.
          if (payload.conversationId) setConversationId(payload.conversationId);
          setProviderInfo({ provider: payload.provider, model: payload.model });
          return;
        }

        if (payload.type === "delta") {
          setMessages((current) => {
            const updated = [...current];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                content: `${last.content}${payload.delta}`,
              };
            }
            return updated;
          });
          return;
        }

        if (payload.type === "tool_call") {
          // The agent is invoking a tool. Append a placeholder to the
          // current assistant bubble; the matching `tool_result` frame
          // arrives next and fills it in.
          setMessages((current) => {
            const updated = [...current];
            const last = updated[updated.length - 1];
            if (last?.role !== "assistant") return current;
            const calls = [...(last.toolCalls ?? [])];
            // De-dupe by id in case a result lands before the call frame
            // (paranoid; shouldn't happen).
            const existingIdx = calls.findIndex((c) => c.id === payload.id);
            const entry: ToolCallEntry = {
              id: payload.id,
              name: payload.name,
              args: payload.args ?? null,
            };
            if (existingIdx >= 0) calls[existingIdx] = { ...calls[existingIdx], ...entry };
            else calls.push(entry);
            updated[updated.length - 1] = { ...last, toolCalls: calls };
            return updated;
          });
          return;
        }

        if (payload.type === "tool_result") {
          setMessages((current) => {
            const updated = [...current];
            const last = updated[updated.length - 1];
            if (last?.role !== "assistant") return current;
            const calls = (last.toolCalls ?? []).map((c) =>
              c.id === payload.id
                ? { ...c, ok: payload.ok, display: payload.display, error: payload.error }
                : c
            );
            updated[updated.length - 1] = { ...last, toolCalls: calls };
            return updated;
          });
          // An order-draft tool result carries a prefill directive. Hand it to
          // the parent so it fills the trade ticket. This NEVER submits: the
          // user reviews the pre-filled form and submits it themselves.
          if (payload.ui?.type === "order_draft" && onDraftOrder) {
            onDraftOrder(payload.ui.draft);
          }
          return;
        }

        if (payload.type === "error") {
          setError(payload.message);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseBuffer(buffer, handlePayload);
      }
      parseSseBuffer(`${buffer}\n\n`, handlePayload);
      // Refresh the sidebar list so a brand-new conversation appears (with
      // its server-generated auto-title) without a manual reload. Skip when
      // a more-recent request has superseded us - there's nothing new from
      // this stream to highlight.
      if (isCurrent()) conversationsQuery.refetch();
    } catch (err) {
      // An AbortError is intentional (the user navigated away mid-stream).
      // Treat it as a no-op rather than surfacing a scary error toast.
      const aborted =
        err instanceof DOMException
          ? err.name === "AbortError"
          : (err as { name?: string } | null)?.name === "AbortError";
      if (!aborted && isCurrent()) {
        setError(err instanceof Error ? err.message : "Chat request failed");
        // Drop the empty assistant placeholder from the failed turn. Leaving it
        // in state would send an empty-content message on the next turn, which
        // the server rejects ("Invalid chat request") - poisoning the chat.
        setMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === "assistant" && !last.content && !last.toolCalls?.length) {
            return current.slice(0, -1);
          }
          return current;
        });
      }
    } finally {
      if (isCurrent()) {
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  }

  if (!isSignedIn) {
    return (
      <ChatPanelState
        cardHeight={cardHeight}
        description="Sign in to use AI Chat."
        onClose={onClose}
      />
    );
  }

  if (!activeCredentialId) {
    return (
      <ChatPanelState
        cardHeight={cardHeight}
        description="Set your trading credentials in Settings to use AI Chat."
        actionHref="/settings"
        onClose={onClose}
      />
    );
  }

  // BYOK removed: no credential loading state needed — platform key is always available.
  // Re-add the llmCredentialsQuery loading/empty guards here when BYOK returns.

  if (modelStatusQuery.isSuccess && modelStatusQuery.data?.configured === false) {
    return (
      <ChatPanelState
        cardHeight={cardHeight}
        description="AI Chat is not configured yet. Contact support."
        onClose={onClose}
      />
    );
  }

  return (
    <Card className={cn("terminal-ai-panel flex flex-col gap-0 py-0", cardHeight)}>
      {embedded ? (
        <div className="terminal-ai-header flex min-h-10 shrink-0 items-center gap-1 border-b bg-muted/15 px-2 sm:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">AI analyst</span>
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
            <span
              className={cn(
                "shrink-0 font-mono text-3xs font-semibold",
                activeAccountType === "LIVE"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {activeAccountType || "No account"}
            </span>
            {activeAccountLabel && (
              <span
                className="hidden min-w-0 max-w-28 truncate text-2xs text-muted-foreground sm:inline"
                title={activeAccountLabel}
              >
                {activeAccountLabel}
              </span>
            )}
            {activeSymbol && (
              <span className="shrink-0 border-l pl-2 font-mono text-2xs font-medium text-foreground">
                ${activeSymbol}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={startNewConversation}
            disabled={messages.length === 0 && !conversationId}
            title="Clear chat"
            aria-label="Clear chat"
          >
            <Eraser className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Chat settings"
                aria-label="Chat settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-[min(16rem,calc(100vw-1rem))]"
            >
              {/* BYOK removed: model selector hidden. Platform provides gpt-4o-mini. */}
              {/* Re-add the DropdownMenuRadioGroup here when user key selection returns. */}
              <DropdownMenuItem asChild>
                <Link href="/settings?t=models" className="text-xs">
                  Open full settings…
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onClose}
              title="Close AI assistant"
              aria-label="Close AI assistant"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ) : (
        <CardHeader className="shrink-0 gap-3 border-b px-3 py-3 sm:px-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardTitle>AI Chat</CardTitle>
              <CardDescription className="leading-snug">
                Read-only stock research with portfolio, filings, and news context.
              </CardDescription>
            </div>
            <Badge variant="outline" className="w-fit shrink-0">
              Read-only
            </Badge>
          </div>

          {/* BYOK removed: model selector hidden. Platform provides gpt-4o-mini. */}
          {/* Re-add the Select + llmCredentials map here when user key selection returns. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={activeAccountType === "LIVE" ? "destructive" : "secondary"}>
                {activeAccountType || "No account"}
              </Badge>
              {activeAccountLabel && <span className="truncate">{activeAccountLabel}</span>}
              {activeSymbol && <Badge variant="outline">${activeSymbol}</Badge>}
            </div>
          </div>
        </CardHeader>
      )}

      <CardContent className="flex min-h-0 flex-1 gap-0 p-0">
        {!embedded && (
          <aside className="hidden w-48 shrink-0 flex-col border-r bg-muted/10 lg:flex">
            <div className="p-2">
              <button
                type="button"
                onClick={startNewConversation}
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium transition-colors duration-150 hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New chat
              </button>
            </div>
            <ScrollArea className="min-h-0 flex-1 border-t">
              <div className="space-y-1 p-2">
                {conversationsQuery.isLoading && (
                  <div
                    className="space-y-2 px-1 py-2"
                    role="status"
                    aria-label="Loading conversations"
                  >
                    <div className="h-3 w-4/5 animate-pulse rounded-sm bg-muted" />
                    <div className="h-3 w-3/5 animate-pulse rounded-sm bg-muted" />
                    <div className="h-3 w-2/3 animate-pulse rounded-sm bg-muted" />
                  </div>
                )}
                {!conversationsQuery.isLoading && conversations.length === 0 && (
                  <div className="px-1.5 py-2 text-2xs leading-snug text-muted-foreground">
                    Your saved chats will appear here.
                  </div>
                )}
                {conversations.map((c) => {
                  const active = c.id === conversationId;
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "group flex min-h-7 items-center gap-1 rounded-md px-1.5 text-xs transition-colors duration-150",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/60",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => loadConversation(c.id)}
                        className="min-w-0 flex-1 truncate text-left"
                        title={c.title || "Untitled chat"}
                      >
                        {c.title || "Untitled chat"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm("Delete this conversation?")) return;
                          if (c.id === conversationId) startNewConversation();
                          deleteConversationMutation.mutate({ id: c.id });
                        }}
                        title="Delete conversation"
                        aria-label="Delete conversation"
                        className="rounded-sm p-1 opacity-0 transition-[color,opacity] duration-150 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <ScrollArea
            className="min-h-0 flex-1 bg-muted/5"
            aria-busy={isStreaming}
          >
            <div
              className={cn(
                "min-h-full px-3 py-4 sm:px-4",
                showPromptSuggestions
                  ? "flex flex-col justify-center"
                  : "space-y-5",
              )}
            >
              {showPromptSuggestions && (
                <div className="mx-auto w-full max-w-xl space-y-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        Suggested prompts
                      </p>
                      {activeSymbol && (
                        <p className="truncate font-mono text-2xs text-muted-foreground">
                          Current context: ${activeSymbol}
                        </p>
                      )}
                    </div>
                  </div>
                  <div
                    className="flex flex-wrap gap-2"
                    aria-label="Suggested prompts"
                  >
                    {promptChips.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() => handleSend(chip.prompt)}
                        disabled={isStreaming}
                        title={chip.prompt}
                        className="min-h-8 max-w-full rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-left text-xs leading-snug text-foreground transition-[background-color,border-color,color] duration-150 hover:border-primary/40 hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="whitespace-normal [overflow-wrap:anywhere]">
                          {chip.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message, index) => {
                const isAssistant = message.role === "assistant";
                const isLast = index === messages.length - 1;
                const hasToolCalls =
                  isAssistant && (message.toolCalls?.length ?? 0) > 0;
                const showThinking =
                  isAssistant &&
                  !message.content &&
                  !hasToolCalls &&
                  isStreaming &&
                  isLast;

                if (isAssistant && !message.content && !hasToolCalls && !showThinking) {
                  return null;
                }

                return (
                  <div
                    key={`${message.role}-${index}`}
                    className={cn(
                      "group flex w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150",
                      isAssistant ? "items-start gap-2" : "justify-end",
                    )}
                  >
                    {isAssistant && (
                      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
                        <Bot className="h-4 w-4" />
                      </div>
                    )}
                    <div
                      className={cn(
                        "flex min-w-0 flex-col gap-1",
                        isAssistant
                          ? "max-w-[calc(100%-2rem)] flex-1"
                          : "max-w-[90%] sm:max-w-[82%]",
                      )}
                    >
                      <div
                        className={cn(
                          "text-sm leading-relaxed [overflow-wrap:anywhere]",
                          chatMessageBodyClassName(isAssistant),
                        )}
                      >
                        {isAssistant ? (
                          showThinking ? (
                            <span
                              className="inline-flex items-center gap-2 text-xs text-muted-foreground"
                              role="status"
                              aria-live="polite"
                            >
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" />
                              Analyzing context...
                            </span>
                          ) : (
                            <>
                              {message.content && (
                                <ChatMarkdown content={message.content} />
                              )}
                              {hasToolCalls && (
                                <ToolCallList calls={message.toolCalls!} />
                              )}
                            </>
                          )
                        ) : (
                          message.content
                        )}
                      </div>
                      {isAssistant && message.content && (
                        <div className="self-start">
                          <CopyMessageButton text={message.content} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {(sources.length > 0 || warnings.length > 0 || error) && (
            <section
              aria-label="Chat status and sources"
              className="max-h-36 shrink-0 overflow-y-auto border-t bg-muted/10 px-3 py-2 text-xs sm:px-4"
            >
              <div className="space-y-2">
                {error && (
                  <div
                    className="flex items-start gap-2 border-l-2 border-destructive pl-2"
                    role="alert"
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-destructive">
                        Something went wrong
                      </div>
                      <div className="break-words text-muted-foreground">
                        {error}
                      </div>
                      {providerInfo && (
                        <div className="mt-0.5 font-mono text-3xs text-muted-foreground/80">
                          {providerInfo.provider} / {providerInfo.model}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {warnings.length > 0 && (
                  <div className="space-y-1 text-muted-foreground">
                    {warnings.map((warning) => (
                      <div key={warning} className="break-words">
                        {warning}
                      </div>
                    ))}
                  </div>
                )}
                {sources.length > 0 && (
                  <div className="space-y-1 border-t border-border/60 pt-2">
                    <div className="font-medium text-foreground">Sources</div>
                    {sources.map((source) => (
                      <a
                        key={source.id}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-w-0 items-center gap-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        <span className="shrink-0 font-mono">[{source.id}]</span>
                        <span className="truncate">{source.title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          <div className="terminal-ai-composer relative sticky bottom-0 z-10 shrink-0 border-t border-border/70 bg-background/90 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 supports-backdrop-filter:bg-background/75 supports-backdrop-filter:backdrop-blur-xl sm:px-3 sm:pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
            {slashMatches.length > 0 && (
              <div
                role="listbox"
                aria-label="Slash command suggestions"
                className="absolute inset-x-2 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-md border bg-popover/95 shadow-floating supports-backdrop-filter:backdrop-blur-xl sm:inset-x-3"
              >
                {slashMatches.map((cmd, idx) => {
                  const active = idx === slashIndex;
                  return (
                    <button
                      key={cmd.trigger}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setSlashIndex(idx)}
                      onClick={() => applySlashSuggestion(cmd)}
                      className={cn(
                        "flex min-h-9 w-full items-center gap-2 border-b px-2.5 text-left text-xs transition-colors duration-150 last:border-b-0",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/60 hover:text-accent-foreground",
                      )}
                    >
                      <span className="shrink-0 font-mono font-semibold text-primary">
                        {cmd.label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {cmd.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="relative">
              <Textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                aria-label="Message AI analyst"
                placeholder={
                  activeSymbol
                    ? `Ask about $${activeSymbol}, risk, or a market setup...`
                    : "Ask about a position, risk, or a market setup..."
                }
                className="min-h-11 max-h-32 resize-none rounded-md bg-background/90 py-2.5 pl-3 pr-12 transition-[border-color,box-shadow]"
                onKeyDown={(event) => {
                  // Slash-command keyboard nav. When the picker is open, the
                  // arrow keys move the highlight and Enter/Tab confirm.
                  if (slashMatches.length > 0) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setSlashIndex((i) => (i + 1) % slashMatches.length);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setSlashIndex(
                        (i) => (i - 1 + slashMatches.length) % slashMatches.length,
                      );
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      const picked = slashMatches[slashIndex] ?? slashMatches[0];
                      if (picked) applySlashSuggestion(picked);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setInput("");
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
              />
              <Button
                type="button"
                size="icon-lg"
                className="absolute bottom-1.5 right-1.5"
                onClick={() => handleSend()}
                disabled={!canSend}
                title={isStreaming ? "Response in progress" : "Send (Enter)"}
                aria-label={isStreaming ? "Response in progress" : "Send message"}
              >
                {isStreaming ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
