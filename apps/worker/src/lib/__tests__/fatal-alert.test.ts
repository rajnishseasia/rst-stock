import { describe, expect, it } from "bun:test";

import { WORKER_ORDER_ID_MIGRATION } from "@trade-bot/db";

import { sendFatalStartupAlert } from "../fatal-alert";

const WEBHOOK = "https://discord.example/api/webhooks/1/token";

function captureFetch(response: Partial<Response> = { ok: true }) {
  const calls: Array<{ url: string; body: unknown; signal: AbortSignal | null }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      signal: (init?.signal as AbortSignal | undefined) ?? null,
    });
    return response as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("sendFatalStartupAlert", () => {
  it("does nothing when no webhook is configured", async () => {
    const { calls, fetchFn } = captureFetch();
    const sent = await sendFatalStartupAlert(new Error("boom"), { env: {}, fetch: fetchFn });

    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("posts once with the error and the deploy identity", async () => {
    const { calls, fetchFn } = captureFetch();
    const error = new Error(
      `[worker schema compatibility] ${WORKER_ORDER_ID_MIGRATION} is required`,
    );

    const sent = await sendFatalStartupAlert(error, {
      fetch: fetchFn,
      env: {
        WORKER_ERROR_ALERT_WEBHOOK_URL: WEBHOOK,
        RAILWAY_GIT_COMMIT_SHA: "2dee74adba43d010b877b57147a8741854290b28",
        RAILWAY_SERVICE_NAME: "olympus",
        NODE_ENV: "production",
      },
    });

    expect(sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK);

    const content = (calls[0]!.body as { content: string }).content;
    // The alert channel carries more than this deployment, so both the webhook
    // name and the message body have to say which product they came from.
    expect((calls[0]!.body as { username: string }).username).toBe(
      "RST TradeBot Worker Alerts",
    );
    expect(content.startsWith("RST ")).toBe(true);
    expect(content).toContain(`${WORKER_ORDER_ID_MIGRATION} is required`);
    expect(content).toContain("olympus");
    expect(content).toContain("production");
    expect(content).toContain("2dee74a");
    // Bounded, so a hung webhook cannot keep a doomed process alive.
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("masks credentials embedded in a connection error", async () => {
    const { calls, fetchFn } = captureFetch();
    await sendFatalStartupAlert(
      new Error("connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/tradebot"),
      { fetch: fetchFn, env: { WORKER_ERROR_ALERT_WEBHOOK_URL: WEBHOOK } },
    );

    const content = (calls[0]!.body as { content: string }).content;
    expect(content).not.toContain("hunter2");
    expect(content).toContain("[REDACTED]");
  });

  it("reports a rejected webhook without throwing", async () => {
    const { fetchFn } = captureFetch({ ok: false, status: 429 });
    const sent = await sendFatalStartupAlert(new Error("boom"), {
      fetch: fetchFn,
      env: { WORKER_ERROR_ALERT_WEBHOOK_URL: WEBHOOK },
    });
    expect(sent).toBe(false);
  });

  it("swallows a network failure so it cannot mask the real diagnostic", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const sent = await sendFatalStartupAlert(new Error("boom"), {
      fetch: fetchFn,
      env: { WORKER_ERROR_ALERT_WEBHOOK_URL: WEBHOOK },
    });
    expect(sent).toBe(false);
  });

  it("handles a non-Error throw", async () => {
    const { calls, fetchFn } = captureFetch();
    await sendFatalStartupAlert(
      { message: "rejected with a plain object" },
      { fetch: fetchFn, env: { WORKER_ERROR_ALERT_WEBHOOK_URL: WEBHOOK } },
    );

    const content = (calls[0]!.body as { content: string }).content;
    expect(content).toContain("rejected with a plain object");
  });
});

describe("sendFatalStartupAlert build identity", () => {
  it("falls back to 'unknown' for an unset Railway variable, which arrives empty", () => {
    // An unset Railway variable is an empty string, not undefined, so a plain
    // `?? "unknown"` leaves the line reading "commit ." at exactly the moment
    // someone needs to know which build is crash-looping.
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    return sendFatalStartupAlert(new Error("boom"), {
      fetch: fetchFn,
      env: {
        WORKER_ERROR_ALERT_WEBHOOK_URL: WEBHOOK,
        RAILWAY_GIT_COMMIT_SHA: "",
        RAILWAY_SERVICE_NAME: "   ",
        NODE_ENV: "",
      },
    }).then(() => {
      expect(String(body.content)).toContain("commit unknown");
      expect(String(body.content)).toContain("worker");
      expect(String(body.content)).not.toContain("commit .");
    });
  });
});
