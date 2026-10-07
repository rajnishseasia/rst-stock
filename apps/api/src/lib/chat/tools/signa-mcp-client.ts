/**
 * Signa MCP Client
 *
 * Bridges the chat agent to the Signa multi-agent signal service over its
 * SSE-based MCP server at https://app.getsigna.ai/api/mcp/sse. Each of
 * Signa's MCP tools is exposed to our LLM as a `signa_*`-prefixed
 * function-calling tool so the agent can ask "what's the best LONG setup
 * for $X" or "scan these tickers" mid-conversation without leaving the
 * chat.
 *
 * Implementation note: Signa speaks a simplified MCP-over-SSE dialect that
 * the stock `@modelcontextprotocol/sdk` `SSEClientTransport` can't consume
 * directly. Specifically Signa
 *  - emits `event: server_info`, `event: tools`, and `event: endpoint`
 *    on the *initial* SSE GET (so the tool list is delivered without a
 *    follow-up JSON-RPC `tools/list`), and
 *  - returns `data: {"uri":"https://..."}` (a JSON object) where the
 *    standard MCP SSE spec expects a bare URL string.
 *
 * Rather than fight the SDK, we speak Signa's protocol directly here:
 *  - On startup we GET the SSE endpoint once, parse `event: tools` to
 *    capture the tool catalog, then close the stream.
 *  - On each tool call we POST a JSON-RPC `tools/call` body to the same
 *    URL and parse the `event: message` SSE frame in the response body.
 *
 * Why a wrapper rather than calling Signa from the chat panel directly:
 *  - The Signa bearer key never leaves the server. Today this is read from
 *    `SIGNA_API_KEY` (same path used by `apps/api/src/routers/signa.ts`);
 *    when we add per-user Signa keys, the resolver here will swap in the
 *    user's decrypted key without any change to the chat loop.
 *  - We can namespace and curate tools (rename, hide noisy ones) before
 *    handing them to the LLM.
 *
 * Caching: we capture the tool list once per process. Tool execution is a
 * stateless POST so we don't need to keep a persistent connection alive.
 */

import type {
  ToolDefinition,
  ToolHandler,
  ToolResult,
  ToolExecutionContext,
} from "./types.js";

const SIGNA_MCP_URL = "https://app.getsigna.ai/api/mcp/sse";
/** Prefix used to namespace Signa tools alongside our `alpaca_*` set. */
const SIGNA_TOOL_PREFIX = "signa_";
/** Cap on how long we wait for the initial SSE tool list. */
const INITIAL_HANDSHAKE_TIMEOUT_MS = 8000;
/** Cap on per-tool-call HTTP time. */
const TOOL_CALL_TIMEOUT_MS = 20000;

interface SignaMcpToolMeta {
  /** Original (un-prefixed) name as the MCP server defined it. */
  originalName: string;
  /** Namespaced name the LLM sees, e.g. `signa_get_signal`. */
  exposedName: string;
  description: string;
  /** JSON Schema for the parameters. */
  parameters: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface CachedCatalog {
  tools: SignaMcpToolMeta[];
}

let cachePromise: Promise<CachedCatalog | null> | null = null;

/**
 * Resolve a Signa bearer key. Today we have one server-side key; this
 * indirection means a future per-user key fetch slots in here without
 * touching callers.
 */
function resolveSignaApiKey(): string | null {
  return process.env.SIGNA_API_KEY ?? null;
}

/** Coerce whatever the MCP server sent into the loose JSON-Schema-ish shape
 *  the LLM tool definition needs. Most Signa tools should already match. */
function normalizeParameters(input: unknown): SignaMcpToolMeta["parameters"] {
  if (
    input &&
    typeof input === "object" &&
    "type" in (input as Record<string, unknown>)
  ) {
    const i = input as Record<string, unknown>;
    if (i.type === "object") {
      return {
        type: "object",
        properties: (i.properties as Record<string, unknown>) ?? {},
        required: Array.isArray(i.required) ? (i.required as string[]) : undefined,
      };
    }
  }
  return { type: "object", properties: {} };
}

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Read an SSE stream from a Response body and yield decoded events. Stops
 * when the stream ends or the caller's `until` predicate returns true.
 */
async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  until: (e: SseEvent) => boolean,
  timeoutMs: number,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pendingEvent = "message";
  let pendingData: string[] = [];

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const tick = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true }), remaining),
        ),
      ]);
      if (tick.done) break;
      buf += decoder.decode(tick.value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          // Frame boundary.
          if (pendingData.length > 0) {
            const event: SseEvent = {
              event: pendingEvent,
              data: pendingData.join("\n"),
            };
            events.push(event);
            pendingEvent = "message";
            pendingData = [];
            if (until(event)) return events;
          }
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value =
          colon < 0
            ? ""
            : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") pendingEvent = value;
        else if (field === "data") pendingData.push(value);
        // id/retry intentionally ignored
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return events;
}

/**
 * One-time handshake: GET the SSE endpoint and read events until we see
 * `event: tools` (which Signa emits eagerly), then close. Returns null
 * if Signa isn't configured or the handshake fails.
 */
async function fetchSignaCatalog(): Promise<CachedCatalog | null> {
  const apiKey = resolveSignaApiKey();
  if (!apiKey) {
    console.warn("[signa-mcp] No SIGNA_API_KEY set; Signa tools disabled.");
    return null;
  }

  let resp: Response;
  try {
    resp = await fetch(SIGNA_MCP_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
    });
  } catch (err) {
    console.error("[signa-mcp] handshake fetch failed:", err);
    return null;
  }

  if (!resp.ok || !resp.body) {
    console.error(
      `[signa-mcp] handshake bad response: HTTP ${resp.status} ${resp.statusText}`,
    );
    return null;
  }

  const events = await readSseEvents(
    resp.body,
    (e) => e.event === "tools",
    INITIAL_HANDSHAKE_TIMEOUT_MS,
  );

  const toolsEvent = events.find((e) => e.event === "tools");
  if (!toolsEvent) {
    console.error(
      "[signa-mcp] handshake did not deliver `event: tools` within budget",
    );
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolsEvent.data);
  } catch (err) {
    console.error("[signa-mcp] could not parse tools payload:", err);
    return null;
  }

  const rawList = Array.isArray((raw as { tools?: unknown[] }).tools)
    ? ((raw as { tools: unknown[] }).tools)
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];

  const tools: SignaMcpToolMeta[] = rawList
    .map((entry) => {
      const t = entry as {
        name?: string;
        description?: string;
        inputSchema?: unknown;
      };
      if (!t.name) return null;
      return {
        originalName: t.name,
        exposedName: `${SIGNA_TOOL_PREFIX}${t.name}`,
        description: t.description || `Signa tool: ${t.name}`,
        parameters: normalizeParameters(t.inputSchema),
      } as SignaMcpToolMeta;
    })
    .filter((t): t is SignaMcpToolMeta => t !== null);

  if (tools.length === 0) {
    console.warn("[signa-mcp] handshake delivered empty tool catalog");
    return null;
  }

  return { tools };
}

async function resolveSignaCatalog(): Promise<{
  cached: CachedCatalog | null;
  sourcePromise: Promise<CachedCatalog | null>;
}> {
  if (cachePromise) {
    const existing = cachePromise;
    const cached = await existing;
    return { cached, sourcePromise: existing };
  }
  const local = fetchSignaCatalog();
  cachePromise = local;
  local.then((v) => {
    if (v === null) invalidateSignaCache(local);
  });
  const cached = await local;
  return { cached, sourcePromise: local };
}

/** Safely retire the singleton from a tool-execution failure. Same race
 *  guard as the factory-side reset above. */
function invalidateSignaCache(forPromise: Promise<CachedCatalog | null>) {
  if (cachePromise === forPromise) cachePromise = null;
}

/**
 * Execute a single Signa tool. POSTs a JSON-RPC `tools/call` body and
 * parses the SSE response (one `event: message` frame containing the
 * standard MCP CallToolResult).
 */
async function callSignaTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = resolveSignaApiKey();
  if (!apiKey) throw new Error("Signa API key missing");

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOOL_CALL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(SIGNA_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Signa POST failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }

  // Signa replies as SSE: a single `event: message` frame carrying the
  // JSON-RPC response. Pull just that one frame.
  const contentType = resp.headers.get("content-type") ?? "";
  if (contentType.includes("event-stream") && resp.body) {
    const events = await readSseEvents(
      resp.body,
      (e) => e.event === "message",
      TOOL_CALL_TIMEOUT_MS,
    );
    const messageEvent = events.find((e) => e.event === "message");
    if (!messageEvent) {
      throw new Error("Signa POST: no `event: message` frame in response");
    }
    const payload = JSON.parse(messageEvent.data) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (payload.error) {
      throw new Error(
        `Signa JSON-RPC error: ${payload.error.message ?? "unknown"}`,
      );
    }
    return payload.result;
  }

  // Fallback: plain JSON response.
  const json = (await resp.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(
      `Signa JSON-RPC error: ${json.error.message ?? "unknown"}`,
    );
  }
  return json.result;
}

/**
 * Build a `ToolHandler` for each Signa MCP tool. The `execute` closure
 * forwards the call to Signa over a stateless POST.
 */
export async function buildSignaTools(): Promise<ToolHandler[]> {
  const { cached, sourcePromise } = await resolveSignaCatalog();
  if (!cached) return [];

  return cached.tools.map((meta) => buildOne(meta, sourcePromise));
}

function buildOne(
  meta: SignaMcpToolMeta,
  sourcePromise: Promise<CachedCatalog | null>,
): ToolHandler {
  const definition: ToolDefinition = {
    type: "function",
    function: {
      name: meta.exposedName,
      description: meta.description,
      parameters: meta.parameters,
    },
  };

  return {
    trustDomain: "external",
    definition,
    async execute(
      args: Record<string, unknown>,
      _ctx: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const result = (await callSignaTool(meta.originalName, args)) as
          | {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
              structuredContent?: unknown;
            }
          | undefined;

        const contentArray = Array.isArray(result?.content) ? result.content : [];
        const text = contentArray
          .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
          .filter(Boolean)
          .join("\n");

        if (result?.isError === true) {
          return { ok: false, error: text || "Signa tool returned an error" };
        }

        return {
          ok: true,
          data: result?.structuredContent ?? { text },
          display: `Signa: ${meta.originalName}`,
        };
      } catch (err) {
        // Transport errors retire the catalog so a fresh handshake runs on
        // the next call. Only nulls the singleton if it still points at the
        // same promise we were built against, so a concurrent reconnect
        // isn't clobbered.
        invalidateSignaCache(sourcePromise);
        return {
          ok: false,
          error:
            err instanceof Error
              ? `Signa MCP call failed: ${err.message}`
              : "Signa MCP call failed",
        };
      }
    },
  };
}
