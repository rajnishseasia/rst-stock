import { describe, expect, test } from "bun:test";
import {
  ERROR_BURST_COOLDOWN_MS,
  ERROR_BURST_MAX_EVENTS,
  ErrorBurstAlerter,
  InMemoryAlertCooldownStore,
  clearAlertCooldownStore,
  formatSuppressionWindow,
  setAlertCooldownStore,
  withErrorBurstAlerts,
  type AlertCooldownStore,
} from "../extensions/error-burst-alert";
import type { Logger } from "../types";

function makeLogger(warnings: Array<{ message: string; context?: Record<string, unknown> }>): Logger {
  const logger = {
    error: () => {},
    warn: (_service: string, message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
    notice: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger,
    withDefaultService: () => logger,
    raw: {} as Logger["raw"],
  } satisfies Logger;
  return logger;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ErrorBurstAlerter", () => {
  test("alerts after more than 20 errors in a rolling hour and omits error details", async () => {
    let now = 1_000_000;
    const requests: Array<{ url: string; body: string }> = [];
    const base = makeLogger([]);
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://discord.example/secret-hook",
      logger: base,
      now: () => now,
      fetch: (async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const logger = withErrorBurstAlerts(base, alerter);

    for (let index = 0; index < 20; index += 1) {
      logger.error("paste.trade", "upstream failed", { token: "must-not-leak" });
    }
    expect(requests).toHaveLength(0);

    logger.error("discord", "auth failed", { authorization: "must-not-leak" });
    await flushAsyncWork();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://discord.example/secret-hook");
    // The alert channel carries more than this deployment, so both the webhook
    // name and the message body have to say which product they came from.
    // Discord hides the username on consecutive posts from the same webhook.
    const payload = JSON.parse(requests[0]!.body) as {
      username: string;
      content: string;
    };
    expect(payload.username).toBe("RST TradeBot Worker Alerts");
    expect(payload.content.startsWith("RST ")).toBe(true);
    expect(requests[0]?.body).toContain("21 errors in the last hour");
    expect(payload.content).toContain("Further alerts are suppressed for 1 day.");
    expect(requests[0]?.body).toContain("paste.trade: 20");
    expect(requests[0]?.body).toContain("discord: 1");
    expect(requests[0]?.body).not.toContain("must-not-leak");

    now += 1;
    logger.error("worker", "another failure");
    await flushAsyncWork();
    expect(requests).toHaveLength(1);
  });

  test("prunes old errors and permits a new alert after cooldown", async () => {
    let now = 0;
    let requestCount = 0;
    const base = makeLogger([]);
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://discord.example/hook",
      logger: base,
      now: () => now,
      fetch: (async () => {
        requestCount += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

    for (let index = 0; index < 20; index += 1) alerter.record("worker");
    now += 60 * 60 * 1_000 + 1;
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(0);

    for (let index = 0; index < 20; index += 1) alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(1);

    // An hour of new errors is no longer enough to alert again: a known,
    // unfixed error source would otherwise post 24 identical alerts a day.
    now += 60 * 60 * 1_000;
    for (let index = 0; index < 21; index += 1) alerter.record("paste.trade");
    await flushAsyncWork();
    expect(requestCount).toBe(1);

    now += ERROR_BURST_COOLDOWN_MS;
    for (let index = 0; index < 21; index += 1) alerter.record("paste.trade");
    await flushAsyncWork();
    expect(requestCount).toBe(2);
  });

  test("suppresses for a day, and says so in the words a human reads at 3am", () => {
    expect(ERROR_BURST_COOLDOWN_MS).toBe(24 * 60 * 60 * 1_000);
    expect(formatSuppressionWindow(ERROR_BURST_COOLDOWN_MS)).toBe("1 day");
    expect(formatSuppressionWindow(48 * 60 * 60 * 1_000)).toBe("2 days");
    expect(formatSuppressionWindow(60 * 60 * 1_000)).toBe("1 hour");
    expect(formatSuppressionWindow(90 * 60 * 1_000)).toBe("90 minutes");
    expect(formatSuppressionWindow(60_000)).toBe("1 minute");
  });

  test("logs a warning without recursively counting webhook failures", async () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const base = makeLogger(warnings);
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://discord.example/hook",
      logger: base,
      threshold: 0,
      fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });

    alerter.record("worker");
    await flushAsyncWork();

    expect(warnings).toEqual([
      { message: "Error burst alert webhook rejected", context: { status: 503 } },
    ]);
  });

  test("starts cooldown only after successful delivery and backs off HTTP retries", async () => {
    let now = 0;
    let requestCount = 0;
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://discord.example/hook",
      logger: makeLogger([]),
      now: () => now,
      threshold: 0,
      cooldownMs: 1_000,
      retryDelayMs: 100,
      fetch: (async () => {
        requestCount += 1;
        return new Response(null, { status: requestCount === 1 ? 503 : 204 });
      }) as typeof fetch,
    });

    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(1);

    now = 99;
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(1);

    now = 100;
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(2);

    now = 1_099;
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(2);

    now = 1_100;
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(3);
  });

  test("retries network delivery failures after the bounded backoff", async () => {
    let now = 0;
    let requestCount = 0;
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://discord.example/hook",
      logger: makeLogger([]),
      now: () => now,
      threshold: 0,
      retryDelayMs: 50,
      fetch: (async () => {
        requestCount += 1;
        if (requestCount === 1) throw new Error("offline");
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

    alerter.record("worker");
    await flushAsyncWork();
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(1);

    now = 50;
    alerter.record("worker");
    await flushAsyncWork();
    expect(requestCount).toBe(2);
  });

  test("caps retained events during a sustained error burst", () => {
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://discord.example/hook",
      logger: makeLogger([]),
      threshold: Number.MAX_SAFE_INTEGER,
    });

    for (let index = 0; index < ERROR_BURST_MAX_EVENTS + 10; index += 1) {
      alerter.record("worker");
    }

    expect(
      (alerter as unknown as { events: unknown[] }).events,
    ).toHaveLength(ERROR_BURST_MAX_EVENTS);
  });
});

/**
 * The suppression window used to live on the alerter object, so it died with
 * the process. These cover the durable-store behaviour that replaced it.
 */
describe("cooldown store", () => {
  function makeAlerter(
    posts: unknown[],
    store: AlertCooldownStore,
    now: () => number,
  ): ErrorBurstAlerter {
    return new ErrorBurstAlerter({
      webhookUrl: "https://example.invalid/hook",
      logger: makeLogger([]),
      now,
      cooldownStore: store,
      fetch: (async () => {
        posts.push(1);
        return new Response("", { status: 204 });
      }) as unknown as typeof fetch,
    });
  }

  function burst(alerter: ErrorBurstAlerter): void {
    for (let i = 0; i < 21; i += 1) alerter.record("svc");
  }

  // The regression: a restarted worker got a brand new alerter, and with the
  // cooldown held in that object it alerted again immediately.
  test("a fresh alerter sharing a store stays suppressed across a restart", async () => {
    const posts: unknown[] = [];
    const store = new InMemoryAlertCooldownStore(() => 1_000);

    burst(makeAlerter(posts, store, () => 1_000));
    await flushAsyncWork();
    expect(posts).toHaveLength(1);

    // Same store, new alerter: this is what a process restart looks like.
    burst(makeAlerter(posts, store, () => 1_000));
    await flushAsyncWork();
    expect(posts).toHaveLength(1);
  });

  test("alerts again once the window has elapsed", async () => {
    const posts: unknown[] = [];
    let clock = 1_000;
    const store = new InMemoryAlertCooldownStore(() => clock);

    burst(makeAlerter(posts, store, () => clock));
    await flushAsyncWork();
    expect(posts).toHaveLength(1);

    clock += ERROR_BURST_COOLDOWN_MS + 1;
    burst(makeAlerter(posts, store, () => clock));
    await flushAsyncWork();
    expect(posts).toHaveLength(2);
  });

  // A burnt window with nothing delivered is the worst of both worlds.
  test("releases the claim when delivery fails", async () => {
    const store = new InMemoryAlertCooldownStore(() => 1_000);
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://example.invalid/hook",
      logger: makeLogger([]),
      now: () => 1_000,
      cooldownStore: store,
      fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });

    burst(alerter);
    await flushAsyncWork();

    expect(await store.claim(ERROR_BURST_COOLDOWN_MS)).toBe(true);
  });

  test("a throwing store warns and does not propagate", async () => {
    const warnings: Array<{ message: string }> = [];
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://example.invalid/hook",
      logger: makeLogger(warnings),
      now: () => 1_000,
      cooldownStore: {
        claim: async () => {
          throw new Error("redis down");
        },
        release: async () => {},
      },
      fetch: (async () => new Response("", { status: 204 })) as unknown as typeof fetch,
    });

    burst(alerter);
    await flushAsyncWork();

    expect(warnings.map((w) => w.message)).toContain("Error burst cooldown store failed");
  });

  test("falls back to a process-local window when no store is installed", async () => {
    clearAlertCooldownStore();
    const posts: unknown[] = [];
    const alerter = new ErrorBurstAlerter({
      webhookUrl: "https://example.invalid/hook",
      logger: makeLogger([]),
      now: () => 1_000,
      fetch: (async () => {
        posts.push(1);
        return new Response("", { status: 204 });
      }) as unknown as typeof fetch,
    });

    burst(alerter);
    await flushAsyncWork();
    burst(alerter);
    await flushAsyncWork();

    expect(posts).toHaveLength(1);
  });

  test("uses the shared store when one is installed", async () => {
    const store = new InMemoryAlertCooldownStore(() => 1_000);
    setAlertCooldownStore(store);
    try {
      const posts: unknown[] = [];
      const alerter = new ErrorBurstAlerter({
        webhookUrl: "https://example.invalid/hook",
        logger: makeLogger([]),
        now: () => 1_000,
        fetch: (async () => {
          posts.push(1);
          return new Response("", { status: 204 });
        }) as unknown as typeof fetch,
      });

      burst(alerter);
      await flushAsyncWork();

      expect(posts).toHaveLength(1);
      expect(await store.claim(ERROR_BURST_COOLDOWN_MS)).toBe(false);
    } finally {
      clearAlertCooldownStore();
    }
  });
});
