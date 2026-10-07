import { describe, it, expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { HttpRequestError } from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import {
  HyperliquidClient,
  toCloid,
  clampLeverage,
  aggressivePrice,
  buildPerpAssetSnapshot,
  buildPerpL2Book,
  PERP_L2_BOOK_DEFAULT_DEPTH,
  PERP_L2_BOOK_MAX_DEPTH,
  buildPerpAssetCache,
  buildPerpMarketStats,
  mapPositionRow,
  normalizePerpFill,
  mapOpenOrderRow,
  isAgentApproved,
  isTradableOnHl,
  buildTpSlLegs,
  latestPortfolioAccountValue,
  hyperliquidRestBudget,
  hyperliquidRestWeightSnapshot,
  RateLimitedHyperliquidTransport,
  REST_WEIGHT_BACKGROUND_BUDGET,
  TpSlPartialError,
} from "./client.js";
import type { PerpAssetMeta } from "./types.js";

// A throwaway key — never a real secret. Deterministic so tests are stable.
const THROWAWAY_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const BUILDER_ADDRESS = "0x1234567890123456789012345678901234567890";

interface FakeTimer {
  id: number;
  at: number;
  callback: () => void;
  cancelled: boolean;
}

async function withFakeRestClock<T>(
  run: (input: {
    advance: (ms: number) => Promise<void>;
    calls: string[];
    pendingTimerCount: () => number;
    firedTimerCount: () => number;
  }) => Promise<T>,
): Promise<T> {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalFetch = globalThis.fetch;
  let now = originalNow();
  let nextTimerId = 1;
  const timers: FakeTimer[] = [];
  const calls: string[] = [];
  let firedTimerCount = 0;

  Date.now = () => now;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer: FakeTimer = {
      id: nextTimerId++,
      at: now + Math.max(0, Number(delay) || 0),
      callback: () => callback(...args),
      cancelled: false,
    };
    timers.push(timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const timer = timers.find((item) => item.id === Number(handle));
    if (timer) timer.cancelled = true;
  }) as typeof clearTimeout;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = new URL(String(input)).pathname.split("/").at(-1);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (endpoint === "info") {
      calls.push(typeof body.type === "string" ? body.type : "info");
    } else {
      const action = typeof body.action === "object" && body.action !== null
        ? body.action as Record<string, unknown>
        : body;
      const orders = Array.isArray(action.orders) ? action.orders : [];
      const first = orders[0] as Record<string, unknown> | undefined;
      calls.push(
        typeof first?.tag === "string"
          ? first.tag
          : first?.r === true
            ? "close"
            : first?.r === false
              ? "open"
              : "exchange",
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const advance = async (ms: number) => {
    now += ms;
    while (true) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= now)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      next.cancelled = true;
      firedTimerCount++;
      next.callback();
      await Promise.resolve();
    }
    await Promise.resolve();
  };

  try {
    return await run({
      advance,
      calls,
      pendingTimerCount: () => timers.filter((timer) => !timer.cancelled).length,
      firedTimerCount: () => firedTimerCount,
    });
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.fetch = originalFetch;
  }
}

function fakeRestTransport(
  trafficClass: "standard" | "background" = "standard",
  timeout: number | null = null,
) {
  return new RateLimitedHyperliquidTransport(
    { isTestnet: true, timeout },
    trafficClass,
  );
}

function trackAbortListeners(signal: AbortSignal): () => number {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type, listener, options) => {
    if (type === "abort" && listener) listeners.add(listener);
    add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type, listener, options) => {
    if (type === "abort" && listener) listeners.delete(listener);
    remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];
  return () => listeners.size;
}

describe("Hyperliquid REST traffic priority", () => {
  it("reserves most read capacity for order-critical work", () => {
    expect(hyperliquidRestBudget("info", "background")).toBe(
      REST_WEIGHT_BACKGROUND_BUDGET,
    );
    expect(hyperliquidRestBudget("info", "background")).toBeLessThan(
      hyperliquidRestBudget("info", "standard"),
    );
    expect(hyperliquidRestBudget("info", "standard")).toBeLessThan(
      hyperliquidRestBudget("info", "order-critical"),
    );
    expect(hyperliquidRestBudget("exchange", "background")).toBe(
      REST_WEIGHT_BACKGROUND_BUDGET,
    );
    expect(hyperliquidRestBudget("exchange", "background")).toBeLessThan(
      hyperliquidRestBudget("exchange", "order-critical"),
    );
  });

  it("keeps background traffic out of the reserved close capacity", async () => {
    await withFakeRestClock(async ({ advance, calls }) => {
      const background = fakeRestTransport("background");
      for (let index = 0; index < 6; index++) {
        await background.request("info", { type: "userRole" });
      }
      await background.request("explorer", {});

      const controller = new AbortController();
      const waiting = background.request(
        "info",
        { type: "userRole" },
        controller.signal,
      );
      await Promise.resolve();

      expect(hyperliquidRestWeightSnapshot("background").estimatedWeight).toBe(400);
      expect(calls).toHaveLength(7);
      controller.abort(new Error("test waiter cancelled"));
      await expect(waiting).rejects.toThrow("test waiter cancelled");

      await advance(60_000);
      hyperliquidRestWeightSnapshot("background");
    });
  });

  it("keeps signing-client reads ordinary while reduce-only writes use the reserve", async () => {
    await withFakeRestClock(async ({ advance, calls }) => {
      const standard = fakeRestTransport();
      const signing = new RateLimitedHyperliquidTransport(
        { isTestnet: true, timeout: null },
        "order-critical",
      );
      for (let index = 0; index < 15; index++) {
        await standard.request("info", { type: "userRole" });
      }

      const start = calls.length;
      const read = signing.request("info", { type: "userRole" });
      const close = signing.request("exchange", {
        action: { orders: [{ r: true }] },
      });
      await Promise.resolve();

      expect(calls.slice(start)).toEqual(["close"]);
      expect(hyperliquidRestWeightSnapshot("order-critical").estimatedWeight).toBe(901);

      await advance(60_000);
      await Promise.all([read, close]);
      expect(calls.slice(start)).toEqual(["close", "userRole"]);
      await advance(60_000);
      hyperliquidRestWeightSnapshot("order-critical");
    });
  });

  it("holds opens while a waiting close cannot yet fit, then admits the close first", async () => {
    await withFakeRestClock(async ({ advance, calls }) => {
      const transport = fakeRestTransport();
      for (let index = 0; index < 15; index++) {
        await transport.request("info", { type: "userRole" });
      }
      const start = calls.length;
      const open = transport.request("exchange", {
        action: { orders: [{ r: false }] },
      });
      const close = transport.request("exchange", {
        action: { orders: Array.from({ length: 11_960 }, () => ({ r: true })) },
      });
      await Promise.resolve();
      const callsBeforeRelease = calls.slice(start);
      const weightBeforeRelease = hyperliquidRestWeightSnapshot().estimatedWeight;

      await advance(60_000);
      await Promise.all([open, close]);
      const callsAfterRelease = calls.slice(start);
      expect(hyperliquidRestWeightSnapshot().estimatedWeight).toBeLessThanOrEqual(1_100);

      await advance(60_000);
      hyperliquidRestWeightSnapshot();

      expect(callsBeforeRelease).toEqual([]);
      expect(weightBeforeRelease).toBe(900);
      expect(callsAfterRelease).toEqual(["close", "open"]);
    });
  });

  it("orders queued closes before opens and background reads after capacity returns", async () => {
    await withFakeRestClock(async ({ advance, calls }) => {
      const standard = fakeRestTransport();
      const background = fakeRestTransport("background");
      for (let index = 0; index < 15; index++) {
        await standard.request("info", { type: "userRole" });
      }
      for (let index = 0; index < 200; index++) {
        await standard.request("exchange", { action: { orders: [{ r: true }] } });
      }
      expect(hyperliquidRestWeightSnapshot().estimatedWeight).toBe(1_100);

      const start = calls.length;
      const controller = new AbortController();
      const abortedBackground = background.request(
        "info",
        { type: "userRole" },
        controller.signal,
      );
      const open = standard.request("exchange", {
        action: { orders: [{ r: false }] },
      });
      const close = standard.request("exchange", {
        action: { orders: [{ r: true }] },
      });
      await Promise.resolve();
      controller.abort(new Error("remove queued background read"));
      await expect(abortedBackground).rejects.toThrow("remove queued background read");

      await advance(60_000);
      await Promise.all([open, close]);
      expect(calls.slice(start)).toEqual(["close", "open"]);
      expect(hyperliquidRestWeightSnapshot().estimatedWeight).toBeLessThanOrEqual(1_100);

      await advance(60_000);
      hyperliquidRestWeightSnapshot();
    });
  });

  it("keeps a heavier close at the head of its priority class until it fits", async () => {
    await withFakeRestClock(async ({ advance, calls }) => {
      const transport = fakeRestTransport();
      for (let index = 0; index < 15; index++) {
        await transport.request("info", { type: "userRole" });
      }
      for (let index = 0; index < 199; index++) {
        await transport.request("exchange", { action: { orders: [{ r: true }] } });
      }

      const start = calls.length;
      const heavyClose = transport.request("exchange", {
        action: { orders: Array.from({ length: 40 }, (_, index) => ({
          r: true,
          ...(index === 0 ? { tag: "heavy-close" } : {}),
        })) },
      });
      const lightClose = transport.request("exchange", {
        action: { orders: [{ r: true, tag: "light-close" }] },
      });
      await Promise.resolve();
      const beforeCapacity = calls.slice(start);

      await advance(60_000);
      await Promise.all([heavyClose, lightClose]);
      const afterCapacity = calls.slice(start);
      await advance(60_000);
      hyperliquidRestWeightSnapshot();

      expect(beforeCapacity).toEqual([]);
      expect(afterCapacity).toEqual(["heavy-close", "light-close"]);
    });
  });

  it("rejects queued requests at timeout and detaches their abort listeners", async () => {
    await withFakeRestClock(async ({ advance, calls, pendingTimerCount, firedTimerCount }) => {
      const transport = fakeRestTransport("standard", 50);
      for (let index = 0; index < 15; index++) {
        await transport.request("info", { type: "userRole" });
      }

      const controller = new AbortController();
      const activeAbortListeners = trackAbortListeners(controller.signal);
      const start = calls.length;
      const waiting = transport.request(
        "exchange",
        { action: { orders: Array.from({ length: 8_000 }, () => ({ r: true })) } },
        controller.signal,
      );
      const settlement = waiting.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await Promise.resolve();
      const queuedTimerCount = pendingTimerCount();

      await advance(50);
      const timeoutTimerCount = pendingTimerCount();
      const timeoutFires = firedTimerCount();
      const result = await Promise.race([
        settlement,
        Promise.resolve({ status: "pending" as const }),
      ]);
      if (result.status === "pending") controller.abort(new Error("fixture cleanup"));
      await advance(60_000);
      hyperliquidRestWeightSnapshot();

      expect(queuedTimerCount).toBe(2);
      expect(timeoutTimerCount).toBe(0);
      expect(timeoutFires).toBe(1);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.error).toBeInstanceOf(HttpRequestError);
        expect((result.error as Error).message).toContain("Request timed out after 50 ms");
      }
      expect(calls.slice(start)).toEqual([]);
      expect(activeAbortListeners()).toBe(0);
      expect(pendingTimerCount()).toBe(0);
    });
  });

  it("re-wakes for staggered capacity and leaves no timer after the queue drains", async () => {
    await withFakeRestClock(async ({ advance, calls, pendingTimerCount, firedTimerCount }) => {
      const background = fakeRestTransport("background");
      for (let index = 0; index < 5; index++) {
        await background.request("explorer", {});
      }
      await advance(30_000);
      for (let index = 0; index < 5; index++) {
        await background.request("explorer", {});
      }

      const start = calls.length;
      const waiting = background.request("exchange", {
        action: { orders: Array.from({ length: 8_000 }, () => ({ r: false })) },
      });
      await Promise.resolve();
      expect(pendingTimerCount()).toBe(1);

      await advance(30_000);
      expect(calls.slice(start)).toEqual([]);
      expect(firedTimerCount()).toBe(1);
      expect(pendingTimerCount()).toBe(1);

      await advance(30_000);
      await waiting;
      expect(calls.slice(start)).toEqual(["open"]);
      expect(firedTimerCount()).toBe(2);
      expect(pendingTimerCount()).toBe(0);

      await advance(60_000);
      expect(firedTimerCount()).toBe(2);
      expect(pendingTimerCount()).toBe(0);
      hyperliquidRestWeightSnapshot("background");
    });
  });
});

interface StubCalls {
  order: any[];
  cancel: any[];
  modify: any[];
  updateLeverage: any[];
  approveAgent: any[];
  approveBuilderFee: any[];
  agentEnableDexAbstraction: any[];
  agentSetAbstraction: any[];
  orderThrows: Error | null;
}

interface StubOptions {
  /** Attach a builder code to the client. Defaults to true. */
  builder?: boolean;
  /**
   * Mids returned by the stubbed `allMids`. When set, the client's `allMids`
   * (used by marketClose when no markPrice is supplied) is stubbed to return it.
   */
  mids?: Record<string, string>;
}

/**
 * Build a real HyperliquidClient with a throwaway viem wallet, then pre-seed
 * the asset cache and swap the private `exchange` for a stub that records the
 * payloads it was called with. This exercises the REAL rounding / cloid /
 * builder-attachment / no-retry code paths without any network call.
 */
function clientWithStub(assets: PerpAssetMeta[], options: StubOptions = {}) {
  const wallet = privateKeyToAccount(THROWAWAY_KEY);
  const client = new HyperliquidClient({
    network: "testnet",
    wallet,
    ...(options.builder === false
      ? {}
      : { builder: { address: BUILDER_ADDRESS, feeTenthsBps: 50 } }),
  });

  // Pre-seed the coin → meta cache so resolveAsset() never hits the network.
  const cache = new Map<string, PerpAssetMeta>();
  for (const a of assets) cache.set(a.coin, a);
  (client as unknown as { assetCache: Map<string, PerpAssetMeta> }).assetCache =
    cache;

  if (options.mids) {
    const mids = options.mids;
    (
      client as unknown as { allMids: () => Promise<Record<string, string>> }
    ).allMids = async () => mids;
  }

  const calls: StubCalls = {
    order: [],
    cancel: [],
    modify: [],
    updateLeverage: [],
    approveAgent: [],
    approveBuilderFee: [],
    agentEnableDexAbstraction: [],
    agentSetAbstraction: [],
    orderThrows: null,
  };
  (client as unknown as { exchange: unknown }).exchange = {
    async order(params: any) {
      calls.order.push(params);
      if (calls.orderThrows) throw calls.orderThrows;
      return {
        status: "ok",
        response: { type: "order", data: { statuses: [] } },
      };
    },
    async cancel(params: any) {
      calls.cancel.push(params);
      return {
        status: "ok",
        response: { type: "cancel", data: { statuses: [] } },
      };
    },
    async modify(params: any) {
      calls.modify.push(params);
      return { status: "ok", response: { type: "default" } };
    },
    async updateLeverage(params: any) {
      calls.updateLeverage.push(params);
      return { status: "ok", response: { type: "default" } };
    },
    async approveAgent(params: any) {
      calls.approveAgent.push(params);
      return { status: "ok", response: { type: "default" } };
    },
    async approveBuilderFee(params: any) {
      calls.approveBuilderFee.push(params);
      return { status: "ok", response: { type: "default" } };
    },
    async agentEnableDexAbstraction(params: any) {
      calls.agentEnableDexAbstraction.push(params);
      return { status: "ok", response: { type: "default" } };
    },
    async agentSetAbstraction(params: any) {
      calls.agentSetAbstraction.push(params);
      return { status: "ok", response: { type: "default" } };
    },
  };

  return { client, calls };
}

const BTC: PerpAssetMeta = {
  coin: "BTC",
  assetIndex: 0,
  szDecimals: 3,
  maxLeverage: 40,
};

const XYZ_JPY: PerpAssetMeta = {
  coin: "xyz:JPY",
  assetIndex: 110000,
  szDecimals: 2,
  maxLeverage: 50,
  dex: "xyz",
  isolatedOnly: true,
};

describe("toCloid", () => {
  it("is deterministic for the same seed", () => {
    expect(toCloid("order-abc")).toBe(toCloid("order-abc"));
  });

  it("produces distinct cloids for distinct seeds", () => {
    expect(toCloid("order-abc")).not.toBe(toCloid("order-def"));
  });

  it("returns a 0x-prefixed 34-char (128-bit) hex string the SDK accepts", () => {
    const cloid = toCloid("some-client-order-id");
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(cloid.length).toBe(34);
  });
});

describe("clampLeverage", () => {
  it("clamps above the asset max down to the max", () => {
    expect(clampLeverage(100, 40)).toBe(40);
  });

  it("floors fractional leverage to an integer", () => {
    expect(clampLeverage(9.9, 40)).toBe(9);
  });

  it("never goes below 1", () => {
    expect(clampLeverage(0, 40)).toBe(1);
    expect(clampLeverage(-5, 40)).toBe(1);
  });

  it("respects a per-asset max that is lower than requested", () => {
    expect(clampLeverage(20, 5)).toBe(5);
  });
});

describe("aggressivePrice", () => {
  it("marks the price up for a long (buy pays up)", () => {
    // 100 * 1.05 = 105, truncated to tick rules for szDecimals=3
    expect(parseFloat(aggressivePrice(100, "long", 3, 0.05))).toBeGreaterThan(
      100,
    );
  });

  it("marks the price down for a short (sell hits down)", () => {
    expect(parseFloat(aggressivePrice(100, "short", 3, 0.05))).toBeLessThan(
      100,
    );
  });

  it("still crosses on a coarse-tick asset where ROUND_DOWN would erase the buffer", () => {
    // szDecimals=6 → perp price truncates to 0 decimals (ROUND_DOWN). mark=11.4:
    // 11.4*1.05=11.97 → naive formatPrice → "11" (BELOW mark, would NOT fill).
    // The cross-invariant guard must widen the buffer until the price is strictly
    // above the (formatted) mark of 11.
    const buy = parseFloat(aggressivePrice(11.4, "long", 6, 0.05));
    expect(buy).toBeGreaterThan(11);
    // Sell stays strictly below the formatted mark.
    const sell = parseFloat(aggressivePrice(11.4, "short", 6, 0.05));
    expect(sell).toBeLessThan(11);
  });

  it("crosses when the mark sits exactly on a tick (equal-price case)", () => {
    // mark=19, szDecimals=6 → 19*1.05=19.95 → naive "19" (EQUAL, does not cross).
    expect(parseFloat(aggressivePrice(19.0, "long", 6, 0.05))).toBeGreaterThan(
      19,
    );
  });
});

describe("HyperliquidClient.placeOrder", () => {
  it("rounds size to szDecimals and attaches the builder code when configured", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "0.00123456789",
      orderType: "Limit",
      limitPrice: "97123.456789",
      clientOrderId: "co-1",
    });

    expect(calls.order.length).toBe(1);
    const payload = calls.order[0];
    // Builder code attached when configured.
    expect(payload.builder).toEqual({ b: BUILDER_ADDRESS, f: 50 });
    // Size truncated to szDecimals=3 → "0.001".
    expect(payload.orders[0].s).toBe("0.001");
    expect(payload.orders[0].a).toBe(0);
    expect(payload.orders[0].b).toBe(true);
    // cloid derived deterministically from clientOrderId.
    expect(payload.orders[0].c).toBe(toCloid("co-1"));
  });

  it("passes the 10 bps default fee (f=100) through to the SDK when that fee is configured", async () => {
    // Mirrors builderCodeFromEnv's default: address set, fee defaulted to 100
    // tenths-of-bp (= 10 bps). The exact fee value must reach the SDK payload.
    const wallet = privateKeyToAccount(THROWAWAY_KEY);
    const client = new HyperliquidClient({
      network: "testnet",
      wallet,
      builder: { address: BUILDER_ADDRESS, feeTenthsBps: 100 },
    });
    const cache = new Map<string, PerpAssetMeta>([[BTC.coin, BTC]]);
    (
      client as unknown as { assetCache: Map<string, PerpAssetMeta> }
    ).assetCache = cache;
    const orders: any[] = [];
    (client as unknown as { exchange: unknown }).exchange = {
      async order(params: any) {
        orders.push(params);
        return {
          status: "ok",
          response: { type: "order", data: { statuses: [] } },
        };
      },
    };
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "1",
      orderType: "Limit",
      limitPrice: "50000",
    });
    expect(orders[0].builder).toEqual({ b: BUILDER_ADDRESS, f: 100 });
  });

  it("places an order fine with NO builder and never sends a builder field", async () => {
    const { client, calls } = clientWithStub([BTC], { builder: false });
    expect(client.hasBuilder).toBe(false);
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "1",
      orderType: "Limit",
      limitPrice: "50000",
    });
    expect(calls.order.length).toBe(1);
    const payload = calls.order[0];
    // Never send builder: undefined — the key must be absent entirely.
    expect("builder" in payload).toBe(false);
    expect(payload.builder).toBeUndefined();
  });

  it("does NOT auto-retry a failed order (a resubmit after a fill doubles the position)", async () => {
    const { client, calls } = clientWithStub([BTC]);
    calls.orderThrows = new HttpRequestError({
      detail: "network blip after a possible fill",
    });
    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "Limit",
        limitPrice: "50000",
      }),
    ).rejects.toThrow("network blip");
    // Exactly ONE submission attempt — no withRetry resubmit.
    expect(calls.order.length).toBe(1);
  });

  it("classifies local SDK failures as definite preparation failures", async () => {
    const { client, calls } = clientWithStub([BTC]);
    calls.orderThrows = new Error("agent wallet signing failed");
    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "Limit",
        limitPrice: "50000",
      }),
    ).rejects.toMatchObject({
      name: "HyperliquidOrderPreparationError",
      message: "agent wallet signing failed",
    });
  });

  it("throws a definitive rejection when Hyperliquid returns an order error status", async () => {
    const { client } = clientWithStub([BTC]);
    // The real SDK calls assertSuccessResponse() and throws ApiRequestError for
    // statuses[].error, so the stub must throw rather than resolve.
    (client as unknown as { exchange: unknown }).exchange = {
      async order() {
        throw new ApiRequestError(
          {
            status: "ok",
            response: {
              type: "order",
              data: { statuses: [{ error: "Insufficient margin" }] },
            },
          },
          "Insufficient margin",
        );
      },
    };

    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "Limit",
        limitPrice: "50000",
      }),
    ).rejects.toMatchObject({
      name: "HyperliquidOrderRejectedError",
      message: "Insufficient margin",
    });
  });

  it("throws a definitive rejection for a top-level Hyperliquid error response", async () => {
    const { client } = clientWithStub([BTC]);
    // The real SDK calls assertSuccessResponse() and throws ApiRequestError for
    // top-level { status: "err", ... }, so the stub must throw rather than resolve.
    (client as unknown as { exchange: unknown }).exchange = {
      async order() {
        throw new ApiRequestError(
          {
            status: "err",
            response: "User or API Wallet 0x123 does not exist.",
          },
          "User or API Wallet 0x123 does not exist.",
        );
      },
    };

    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "Limit",
        limitPrice: "50000",
      }),
    ).rejects.toMatchObject({
      name: "HyperliquidOrderRejectedError",
      message: "User or API Wallet 0x123 does not exist.",
    });
  });

  it("uses a Gtc limit tif by default and Alo when post-only", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "1",
      orderType: "Limit",
      limitPrice: "50000",
    });
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "1",
      orderType: "Limit",
      limitPrice: "50000",
      postOnly: true,
    });
    expect(calls.order[0].orders[0].t).toEqual({ limit: { tif: "Gtc" } });
    expect(calls.order[1].orders[0].t).toEqual({ limit: { tif: "Alo" } });
  });

  it("synthesizes an IoC aggressive price for a market order", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "1",
      orderType: "Market",
      markPrice: "50000",
    });
    const o = calls.order[0].orders[0];
    expect(o.t).toEqual({ limit: { tif: "Ioc" } });
    // Long market → price marked up above mark.
    expect(parseFloat(o.p)).toBeGreaterThan(50000);
  });

  it("marks the order reduce-only and opposite-side for marketClose of a long", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.marketClose({
      coin: "BTC",
      positionSize: "2.5",
      markPrice: "50000",
    });
    const o = calls.order[0].orders[0];
    expect(o.r).toBe(true);
    // Long position (positive szi) closes with a SELL (b=false).
    expect(o.b).toBe(false);
    expect(o.s).toBe("2.5");
  });
});

describe("HIP-3 asset resolution", () => {
  it("reads keyless daily candle history with the exact provider coin", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    const calls: unknown[] = [];
    (client as unknown as { info: unknown }).info = {
      async candleSnapshot(params: unknown) {
        calls.push(params);
        return [
          {
            t: 1,
            T: 2,
            s: "xyz:GOOGL",
            i: "1d",
            o: "100",
            c: "110",
            h: "111",
            l: "99",
            v: "1",
            n: 1,
          },
        ];
      },
    };

    const candles = await client.candleHistory({
      coin: "xyz:GOOGL",
      startTime: 0,
      endTime: 10,
    });

    expect(candles[0]?.c).toBe("110");
    expect(calls).toEqual([
      {
        coin: "xyz:GOOGL",
        interval: "1d",
        startTime: 0,
        endTime: 10,
      },
    ]);
  });

  it("propagates an abort signal through daily candle history", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    let receivedSignal: AbortSignal | undefined;
    (client as unknown as { info: unknown }).info = {
      async candleSnapshot(_params: unknown, signal?: AbortSignal) {
        receivedSignal = signal;
        return [];
      },
    };
    const signal = new AbortController().signal;

    await client.candleHistory(
      { coin: "BTC", startTime: 0, endTime: 10 },
      signal,
    );

    expect(receivedSignal).toBe(signal);
  });

  it("builds builder-deployed asset IDs from the perp DEX and local indexes", () => {
    const cache = buildPerpAssetCache([
      {
        universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }],
      },
      {
        universe: [
          {
            name: "xyz:JPY",
            szDecimals: 2,
            maxLeverage: 50,
            onlyIsolated: true,
            marginMode: "noCross",
          },
          { name: "xyz:GOOGL", szDecimals: 3, maxLeverage: 20 },
        ],
      },
    ]);

    expect(cache.get("BTC")).toMatchObject({ assetIndex: 0, dex: "" });
    expect(cache.get("xyz:JPY")).toMatchObject({
      assetIndex: 110000,
      dex: "xyz",
      isolatedOnly: true,
    });
    expect(cache.get("xyz:GOOGL")).toMatchObject({
      assetIndex: 110001,
      dex: "xyz",
      isolatedOnly: false,
    });
  });

  it("queries the owning DEX for a namespaced coin snapshot and mids", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    const calls: Array<{ method: string; params: unknown }> = [];
    (client as unknown as { info: unknown }).info = {
      async metaAndAssetCtxs(params?: { dex?: string }) {
        calls.push({ method: "metaAndAssetCtxs", params });
        return [
          {
            universe: [
              {
                name: "xyz:JPY",
                szDecimals: 2,
                maxLeverage: 50,
                onlyIsolated: true,
                marginMode: "noCross",
              },
            ],
          },
          [
            {
              markPx: "163.685",
              midPx: "163.685",
              oraclePx: "163.68",
              prevDayPx: "163.50",
              funding: "0.00001",
              dayNtlVlm: "1000000",
            },
          ],
        ];
      },
      async l2Book(params: { coin: string }) {
        calls.push({ method: "l2Book", params });
        return { levels: [[{ px: "163.68" }], [{ px: "163.69" }]] };
      },
      async allMids(params?: { dex?: string }) {
        calls.push({ method: "allMids", params });
        return { "xyz:JPY": "163.685" };
      },
    };

    const snapshot = await client.assetSnapshot("xyz:JPY");
    const mids = await client.allMids("xyz:JPY");

    expect(snapshot).toMatchObject({
      coin: "xyz:JPY",
      markPx: "163.685",
      szDecimals: 2,
      maxLeverage: 50,
      isolatedOnly: true,
    });
    expect(mids["xyz:JPY"]).toBe("163.685");
    expect(calls).toContainEqual({
      method: "metaAndAssetCtxs",
      params: { dex: "xyz" },
    });
    expect(calls).toContainEqual({ method: "allMids", params: { dex: "xyz" } });
  });

  it("aggregates market stats across the main and discovered HIP-3 DEXes", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    const calls: Array<{ dex?: string }> = [];
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          {
            universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }],
          },
          {
            universe: [{ name: "xyz:GOOGL", szDecimals: 3, maxLeverage: 20 }],
          },
        ];
      },
      async metaAndAssetCtxs(params?: { dex?: string }) {
        calls.push(params ?? {});
        if (params?.dex === "xyz") {
          return [
            { universe: [{ name: "xyz:GOOGL", maxLeverage: 20 }] },
            [
              {
                markPx: "190",
                midPx: "190",
                oraclePx: "190",
                prevDayPx: "185",
                funding: "0.0001",
                dayNtlVlm: "500000",
              },
            ],
          ];
        }
        return [
          { universe: [{ name: "BTC", maxLeverage: 40 }] },
          [
            {
              markPx: "60000",
              midPx: "60000",
              oraclePx: "60000",
              prevDayPx: "59000",
              funding: "0.0001",
              dayNtlVlm: "1000000",
            },
          ],
        ];
      },
    };

    const stats = await client.getUniverseStats();

    expect(stats.map((row) => row.coin)).toEqual(["BTC", "xyz:GOOGL"]);
    expect(calls).toEqual([{}, { dex: "xyz" }]);
  });

  it("preserves healthy DEX stats while reporting unavailable partitions", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          { universe: [{ name: "xyz:GOOGL", szDecimals: 3, maxLeverage: 20 }] },
        ];
      },
      async metaAndAssetCtxs(params?: { dex?: string }) {
        if (params?.dex === "xyz") throw new Error("xyz unavailable");
        return [
          { universe: [{ name: "BTC", maxLeverage: 40 }] },
          [{ markPx: "60000", prevDayPx: "59000", dayNtlVlm: "1000000" }],
        ];
      },
    };

    const result = await client.getUniverseStatsWithStatus();

    expect(result.stats.map((row) => row.coin)).toEqual(["BTC"]);
    expect(result.unavailableDexes).toEqual(["xyz"]);
  });

  it("fails closed for legacy market-stat callers when a DEX partition is unavailable", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          { universe: [{ name: "xyz:GOOGL", szDecimals: 3, maxLeverage: 20 }] },
        ];
      },
      async metaAndAssetCtxs(params?: { dex?: string }) {
        if (params?.dex === "xyz") throw new Error("xyz unavailable");
        return [
          { universe: [{ name: "BTC", maxLeverage: 40 }] },
          [{ markPx: "60000", prevDayPx: "59000", dayNtlVlm: "1000000" }],
        ];
      },
    };

    await expect(client.getUniverseStats()).rejects.toThrow(
      "Hyperliquid market stats are incomplete; unavailable DEXes: xyz",
    );
  });

  it.each(["default", "disabled"] as const)(
    "uses the approved agent to transition a HIP-3 account in %s mode",
    async (mode) => {
      const { client, calls } = clientWithStub([BTC]);
      let readCount = 0;
      (client as unknown as { info: unknown }).info = {
        async userAbstraction() {
          readCount += 1;
          return readCount < 3 ? mode : "unifiedAccount";
        },
      };

      await client.ensureDexAbstraction(
        "0xdef0000000000000000000000000000000000abc",
        { waitForPropagation: async () => {} },
      );

      expect(calls.agentSetAbstraction).toEqual([{ abstraction: "u" }]);
      expect(calls.agentEnableDexAbstraction).toHaveLength(0);
    },
  );

  it.each(["unifiedAccount", "portfolioMargin", "dexAbstraction"] as const)(
    "does not change an account already ready for HIP-3 in %s mode",
    async (mode) => {
      const { client, calls } = clientWithStub([BTC]);
      (client as unknown as { info: unknown }).info = {
        async userAbstraction() {
          return mode;
        },
      };

      await client.ensureDexAbstraction(
        "0xdef0000000000000000000000000000000000abc",
      );
      expect(calls.agentSetAbstraction).toHaveLength(0);
    },
  );

  it("accepts a concurrent transition that becomes visible after the agent call", async () => {
    const { client, calls } = clientWithStub([BTC]);
    const states = ["disabled", "unifiedAccount"] as const;
    let readIndex = 0;
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return states[Math.min(readIndex++, states.length - 1)];
      },
    };

    await client.ensureDexAbstraction(
      "0xdef0000000000000000000000000000000000abc",
    );
    expect(readIndex).toBe(2);
    expect(calls.agentSetAbstraction).toEqual([{ abstraction: "u" }]);
  });

  it("accepts a lost agent response when unified mode becomes visible", async () => {
    const { client, calls } = clientWithStub([BTC]);
    let readCount = 0;
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        readCount += 1;
        return readCount < 3 ? "disabled" : "unifiedAccount";
      },
    };
    (
      client as unknown as {
        exchange: { agentSetAbstraction: () => Promise<never> };
      }
    ).exchange.agentSetAbstraction = async () => {
      calls.agentSetAbstraction.push({ abstraction: "u" });
      throw new Error("response lost");
    };

    await client.ensureDexAbstraction(
      "0xdef0000000000000000000000000000000000abc",
      { waitForPropagation: async () => {} },
    );

    expect(calls.agentSetAbstraction).toEqual([{ abstraction: "u" }]);
  });

  it("surfaces a definitive top-level agent transition rejection", async () => {
    const { client, calls } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "disabled";
      },
    };
    (
      client as unknown as {
        exchange: {
          agentSetAbstraction: (
            params: unknown,
          ) => Promise<{ status: "err"; response: string }>;
        };
      }
    ).exchange.agentSetAbstraction = async (params) => {
      calls.agentSetAbstraction.push(params);
      return {
        status: "err",
        response: "Abstraction transition not allowed.",
      };
    };

    await expect(
      client.ensureDexAbstraction(
        "0xdef0000000000000000000000000000000000abc",
        { waitForPropagation: async () => {}, maxReadyChecks: 2 },
      ),
    ).rejects.toThrow(
      "Hyperliquid could not enable unified account mode with the approved trading agent: Abstraction transition not allowed.",
    );
  });

  it("fails closed when an agent transition never becomes visible", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "disabled";
      },
    };

    await expect(
      client.ensureDexAbstraction(
        "0xdef0000000000000000000000000000000000abc",
        { waitForPropagation: async () => {}, maxReadyChecks: 2 },
      ),
    ).rejects.toThrow("not visible yet");
  });

  it("reads a unified account's USDC balance from spot state", async () => {
    const { client } = clientWithStub([BTC]);
    let perpStateReads = 0;
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "unifiedAccount";
      },
      async spotClearinghouseState() {
        return {
          balances: [
            { coin: "HYPE", token: 150, total: "1", hold: "0", entryNtl: "0" },
            {
              coin: "USDC",
              token: 0,
              total: "125.75",
              hold: "5",
              entryNtl: "0",
            },
          ],
        };
      },
      async clearinghouseState() {
        perpStateReads += 1;
        throw new Error(
          "unified accounts should not use per-DEX balance state",
        );
      },
    };

    await expect(
      client.accountBalanceUsd("0xdef0000000000000000000000000000000000abc"),
    ).resolves.toBe("125.75");
    expect(perpStateReads).toBe(0);
  });

  it("values eligible portfolio-margin collateral in USD", async () => {
    const { client } = clientWithStub([BTC]);
    let perpStateReads = 0;
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "portfolioMargin";
      },
      async spotClearinghouseState() {
        return {
          balances: [
            { coin: "USDC", token: 0, total: "7.25", hold: "0", entryNtl: "0" },
            { coin: "USDH", token: 111, total: "5", hold: "0", entryNtl: "0" },
            {
              coin: "HYPE",
              token: 150,
              total: "2",
              hold: "0",
              entryNtl: "0",
              ltv: "0.5",
            },
          ],
        };
      },
      async allBorrowLendReserveStates() {
        return [
          [0, { oraclePx: "1", ltv: "0" }],
          [111, { oraclePx: "1", ltv: "0" }],
          [150, { oraclePx: "40", ltv: "0.5" }],
        ];
      },
      async clearinghouseState() {
        perpStateReads += 1;
        throw new Error(
          "portfolio-margin accounts should use spot balance state",
        );
      },
    };

    await expect(
      client.accountBalanceUsd("0xdef0000000000000000000000000000000000abc"),
    ).resolves.toBe("92.25");
    expect(perpStateReads).toBe(0);
  });

  it("does not count ineligible spot assets as portfolio collateral", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "portfolioMargin";
      },
      async spotClearinghouseState() {
        return {
          balances: [
            { coin: "USDC", token: 0, total: "10", hold: "0", entryNtl: "0" },
            {
              coin: "PURR",
              token: 1,
              total: "1000",
              hold: "0",
              entryNtl: "0",
              ltv: "0.0",
            },
          ],
        };
      },
      async allBorrowLendReserveStates() {
        return [
          [0, { oraclePx: "1", ltv: "0" }],
          [1, { oraclePx: "1", ltv: "0" }],
        ];
      },
    };

    await expect(
      client.accountBalanceUsd("0xdef0000000000000000000000000000000000abc"),
    ).resolves.toBe("10");
  });

  it("keeps legacy/default account balance reads on perp state", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "default";
      },
      async clearinghouseState() {
        return { marginSummary: { accountValue: "42.50" } };
      },
    };

    await expect(
      client.accountBalanceUsd("0xdef0000000000000000000000000000000000abc"),
    ).resolves.toBe("42.50");
  });
});

describe("latestPortfolioAccountValue", () => {
  /** Shape of a real `portfolio` response, trimmed to the fields we read. */
  const period = (name: string, points: [number, string][]) =>
    [name, { accountValueHistory: points }] as const;

  it("takes the newest whole-account point across periods", () => {
    expect(
      latestPortfolioAccountValue([
        period("week", [
          [1_000, "100.0"],
          [2_000, "200.0"],
        ]),
        period("day", [
          [1_000, "100.0"],
          [3_000, "300.0"],
        ]),
        period("month", [
          [1_000, "100.0"],
          [2_500, "250.0"],
        ]),
      ]),
    ).toBe("300.0");
  });

  it("never reads a perp-only period as the account total", () => {
    // Measured on a live unified account: the whole account was $35,086 while
    // its perp series read $1,113. Preferring the perp twin because it happened
    // to be newer would silently drop every spot holding.
    expect(
      latestPortfolioAccountValue([
        period("day", [[1_000, "35086.32"]]),
        period("perpDay", [[9_999, "1113.104306"]]),
        period("perpAllTime", [[9_999, "1113.104306"]]),
      ]),
    ).toBe("35086.32");
  });

  it("survives a missing or empty day series", () => {
    expect(
      latestPortfolioAccountValue([
        period("day", []),
        period("allTime", [[2_000, "77.25"]]),
      ]),
    ).toBe("77.25");
  });

  it("returns null when no period carries a usable point", () => {
    expect(latestPortfolioAccountValue([])).toBeNull();
    expect(latestPortfolioAccountValue([period("day", [])])).toBeNull();
    expect(
      latestPortfolioAccountValue([period("day", [[1_000, "not-a-number"]])]),
    ).toBeNull();
  });

  it("keeps the value verbatim rather than round-tripping through Number", () => {
    // Large real accounts carry more precision than a float renders back.
    expect(
      latestPortfolioAccountValue([period("day", [[1, "698066.3743349999"]])]),
    ).toBe("698066.3743349999");
  });
});

describe("HyperliquidClient.accountEquityUsd", () => {
  const ADDRESS = "0xdef0000000000000000000000000000000000abc" as const;

  it("reports total account value, including spot the collateral read misses", async () => {
    // Modelled on live unified account 0xe0e8..c7a7, which held $3.9k of USDC
    // against $35.1k of total account value: the rest sat in spot tokens.
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "unifiedAccount";
      },
      async spotClearinghouseState() {
        return {
          balances: [
            {
              coin: "USDC",
              token: 0,
              total: "3912.86172679",
              hold: "0",
              entryNtl: "0",
            },
            {
              coin: "HBOOST",
              token: 31,
              total: "9407.83909",
              hold: "0",
              entryNtl: "0",
            },
          ],
        };
      },
      async portfolio() {
        return [
          ["day", { accountValueHistory: [[1_000, "35086.32"]] }],
          ["perpDay", { accountValueHistory: [[1_000, "1113.104306"]] }],
        ];
      },
    };

    await expect(client.accountEquityUsd(ADDRESS)).resolves.toBe("35086.32");
    // The collateral read is deliberately unchanged, and still much smaller.
    await expect(client.accountBalanceUsd(ADDRESS)).resolves.toBe(
      "3912.86172679",
    );
  });

  it("does not add unrealized PnL on top of a unified balance", async () => {
    // The load-bearing regression guard. In unifiedAccount and portfolioMargin
    // the spot USDC balance ALREADY moves with unrealized PnL (verified against
    // live accounts: with no fills between samples, d(USDC) equalled d(uPnL) to
    // four decimals). "collateral + unrealizedPnl" would double-count it.
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "unifiedAccount";
      },
      async spotClearinghouseState() {
        return {
          balances: [
            {
              coin: "USDC",
              token: 0,
              total: "14252.6719",
              hold: "0",
              entryNtl: "0",
            },
          ],
        };
      },
      async clearinghouseState() {
        return {
          marginSummary: { accountValue: "14252.6719" },
          assetPositions: [
            {
              type: "oneWay",
              position: { coin: "BTC", szi: "1", unrealizedPnl: "1300.7236" },
            },
          ],
        };
      },
      async portfolio() {
        return [["day", { accountValueHistory: [[1_000, "14252.6719"]] }]];
      },
    };

    const equity = await client.accountEquityUsd(ADDRESS);
    expect(equity).toBe("14252.6719");
    expect(Number(equity)).not.toBeCloseTo(14252.6719 + 1300.7236, 4);
  });

  it("does not double-count on the default path either", async () => {
    // `marginSummary.accountValue` already includes unrealized PnL, and on
    // default-mode accounts it matched HL's own reported account value to the
    // cent across 12 live samples.
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "default";
      },
      async clearinghouseState() {
        return {
          marginSummary: { accountValue: "332696.793914" },
          assetPositions: [
            {
              type: "oneWay",
              position: { coin: "BTC", szi: "1", unrealizedPnl: "5000" },
            },
          ],
        };
      },
      async portfolio() {
        return [["day", { accountValueHistory: [[1_000, "332696.793914"]] }]];
      },
    };

    await expect(client.accountEquityUsd(ADDRESS)).resolves.toBe(
      "332696.793914",
    );
  });

  it("falls back to collateral rather than blanking a funded account", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "default";
      },
      async clearinghouseState() {
        return { marginSummary: { accountValue: "42.50" } };
      },
      async portfolio() {
        return [["day", { accountValueHistory: [] }]];
      },
    };

    await expect(client.accountEquityUsd(ADDRESS)).resolves.toBe("42.50");
  });

  it("propagates a hard portfolio failure instead of substituting collateral", async () => {
    // The fallback above is for a series that came back UNUSABLE, where the
    // shape changed under us and collateral is the best remaining guess. A
    // request that failed outright is a different case and must not be
    // answered with collateral: on an account holding spot that number is
    // known to understate (measured 88.9% low), and quietly serving it would
    // present a wrong total as final, which is the whole bug this method
    // exists to fix. Rejecting instead leaves `hyperliquid.status` to log it
    // and report `hlEquityUsd: null`, which the portfolio renders as a partial
    // total ("~$X so far") rather than a complete one.
    const { client } = clientWithStub([BTC]);
    let collateralReads = 0;
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        collateralReads += 1;
        return "default";
      },
      async clearinghouseState() {
        return { marginSummary: { accountValue: "42.50" } };
      },
      async portfolio() {
        throw new Error("hyperliquid unreachable");
      },
    };

    await expect(client.accountEquityUsd(ADDRESS)).rejects.toThrow(
      "hyperliquid unreachable",
    );
    expect(collateralReads).toBe(0);
    // withRetry defaults to 3 attempts with ~1s then ~2s backoff.
  }, 15_000);
});

describe("HyperliquidClient.placeOrder (trigger orders)", () => {
  it("StopMarket → trigger { isMarket:true, tpsl:'sl' } with aggressive p from triggerPx", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "1",
      orderType: "StopMarket",
      triggerPx: "60000",
      clientOrderId: "sm-1",
    });
    const o = calls.order[0].orders[0];
    expect(o.t).toEqual({
      trigger: { isMarket: true, triggerPx: "60000", tpsl: "sl" },
    });
    // isMarket → aggressive p derived from triggerPx; a long (buy) marks up.
    expect(parseFloat(o.p)).toBeGreaterThan(60000);
    expect(o.b).toBe(true);
    expect(o.c).toBe(toCloid("sm-1"));
  });

  it("StopLimit → trigger { isMarket:false, tpsl:'sl' } with p = user limitPrice", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "short",
      size: "0.5",
      orderType: "StopLimit",
      triggerPx: "58000",
      limitPrice: "57900",
    });
    const o = calls.order[0].orders[0];
    expect(o.t).toEqual({
      trigger: { isMarket: false, triggerPx: "58000", tpsl: "sl" },
    });
    // Non-market trigger → p is the user's explicit limit price (rounded), NOT aggressive.
    expect(o.p).toBe("57900");
    expect(o.b).toBe(false);
  });

  it("TakeProfitMarket → trigger { isMarket:true, tpsl:'tp' } with aggressive p", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "short",
      size: "1",
      orderType: "TakeProfitMarket",
      triggerPx: "70000",
    });
    const o = calls.order[0].orders[0];
    expect(o.t).toEqual({
      trigger: { isMarket: true, triggerPx: "70000", tpsl: "tp" },
    });
    // isMarket sell → aggressive p marked DOWN from triggerPx.
    expect(parseFloat(o.p)).toBeLessThan(70000);
  });

  it("TakeProfitLimit → trigger { isMarket:false, tpsl:'tp' } with p = user limitPrice", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.placeOrder({
      coin: "BTC",
      side: "long",
      size: "2",
      orderType: "TakeProfitLimit",
      triggerPx: "72000",
      limitPrice: "72100",
    });
    const o = calls.order[0].orders[0];
    expect(o.t).toEqual({
      trigger: { isMarket: false, triggerPx: "72000", tpsl: "tp" },
    });
    expect(o.p).toBe("72100");
  });

  it("throws when a trigger order is missing its triggerPx", async () => {
    const { client } = clientWithStub([BTC]);
    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "StopMarket",
      }),
    ).rejects.toThrow(/require a triggerPx/);
  });

  it("throws when a limit trigger order is missing its limitPrice", async () => {
    const { client } = clientWithStub([BTC]);
    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "StopLimit",
        triggerPx: "60000",
      }),
    ).rejects.toThrow(/require a limitPrice/);
  });
});

describe("buildTpSlLegs (reduce-only opposite-side triggers)", () => {
  it("protects a LONG with SELL (short-side) reduce-only triggers", () => {
    const legs = buildTpSlLegs({
      coin: "BTC",
      positionSide: "long",
      size: "1.5",
      stopLossPx: "58000",
      takeProfitPx: "70000",
    });
    expect(legs.length).toBe(2);
    // Both legs on the OPPOSITE side (short) and reduce-only.
    for (const leg of legs) {
      expect(leg.side).toBe("short");
      expect(leg.reduceOnly).toBe(true);
      expect(leg.size).toBe("1.5");
    }
    // SL leg first, then TP.
    expect(legs[0].orderType).toBe("StopMarket");
    expect(legs[0].triggerPx).toBe("58000");
    expect(legs[1].orderType).toBe("TakeProfitMarket");
    expect(legs[1].triggerPx).toBe("70000");
  });

  it("protects a SHORT with BUY (long-side) reduce-only triggers", () => {
    const legs = buildTpSlLegs({
      coin: "ETH",
      positionSide: "short",
      size: "3",
      stopLossPx: "4000",
    });
    expect(legs.length).toBe(1);
    expect(legs[0].side).toBe("long");
    expect(legs[0].reduceOnly).toBe(true);
    expect(legs[0].orderType).toBe("StopMarket");
  });

  it("uses limit trigger types + a limitPrice when isMarket is false", () => {
    const legs = buildTpSlLegs({
      coin: "BTC",
      positionSide: "long",
      size: "1",
      takeProfitPx: "70000",
      isMarket: false,
    });
    expect(legs[0].orderType).toBe("TakeProfitLimit");
    // Non-market trigger carries a limitPrice = the trigger price.
    expect(legs[0].limitPrice).toBe("70000");
  });

  it("derives a per-leg cloid that folds in the leg's own trigger price", () => {
    const legs = buildTpSlLegs({
      coin: "BTC",
      positionSide: "long",
      size: "1",
      stopLossPx: "58000",
      takeProfitPx: "70000",
      clientOrderId: "pos-xyz",
    });
    // Each leg's cloid includes its OWN price so editing one leg's price and
    // retrying leaves the other leg's cloid stable (HL dedupes the unchanged leg).
    expect(legs[0].clientOrderId).toBe("pos-xyz:sl:58000");
    expect(legs[1].clientOrderId).toBe("pos-xyz:tp:70000");
  });

  it("keeps the SL cloid stable when only the TP price changes", () => {
    const common = {
      coin: "BTC" as const,
      positionSide: "long" as const,
      size: "1",
      stopLossPx: "58000",
      clientOrderId: "pos-xyz",
    };
    const a = buildTpSlLegs({ ...common, takeProfitPx: "70000" });
    const b = buildTpSlLegs({ ...common, takeProfitPx: "72000" });
    // SL leg unchanged → same cloid → HL dedupes (no duplicate stop).
    expect(a[0].clientOrderId).toBe(b[0].clientOrderId);
    // TP leg changed → distinct cloid.
    expect(a[1].clientOrderId).not.toBe(b[1].clientOrderId);
  });

  it("returns no legs when neither SL nor TP is supplied", () => {
    expect(
      buildTpSlLegs({ coin: "BTC", positionSide: "long", size: "1" }),
    ).toEqual([]);
  });
});

describe("HyperliquidClient.setPositionTpSl", () => {
  it("places both reduce-only opposite-side legs in one position-linked group", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.setPositionTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "1",
      stopLossPx: "58000",
      takeProfitPx: "70000",
    });
    expect(calls.order.length).toBe(1);
    expect(calls.order[0].grouping).toBe("positionTpsl");
    const sl = calls.order[0].orders[0];
    const tp = calls.order[0].orders[1];
    // Long protected by SELL triggers, reduce-only.
    expect(sl.b).toBe(false);
    expect(sl.r).toBe(true);
    expect(sl.t).toEqual({
      trigger: { isMarket: true, triggerPx: "58000", tpsl: "sl" },
    });
    expect(tp.b).toBe(false);
    expect(tp.r).toBe(true);
    expect(tp.t).toEqual({
      trigger: { isMarket: true, triggerPx: "70000", tpsl: "tp" },
    });
  });

  it("throws when neither SL nor TP is supplied", async () => {
    const { client } = clientWithStub([BTC]);
    await expect(
      client.setPositionTpSl({ coin: "BTC", positionSide: "long", size: "1" }),
    ).rejects.toThrow(/at least one of/i);
  });

  it("fails the grouped request without a partial-leg state", async () => {
    const { client, calls } = clientWithStub([BTC]);
    calls.orderThrows = new Error("TP/SL group rejected by venue");
    await expect(
      client.setPositionTpSl({
        coin: "BTC",
        positionSide: "long",
        size: "1",
        stopLossPx: "58000",
        takeProfitPx: "70000",
      }),
    ).rejects.toThrow(/group rejected/i);
    expect(calls.order).toHaveLength(1);
  });

  it("propagates the raw error (not partial) when the FIRST leg fails", async () => {
    const { client, calls } = clientWithStub([BTC]);
    calls.orderThrows = new Error("SL leg rejected");
    await expect(
      client.setPositionTpSl({
        coin: "BTC",
        positionSide: "long",
        size: "1",
        stopLossPx: "58000",
        takeProfitPx: "70000",
      }),
    ).rejects.not.toBeInstanceOf(TpSlPartialError);
  });
});

describe("HyperliquidClient.modifyPositionTpSl", () => {
  it("atomically modifies a long position's stop with the same oid", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.modifyPositionTpSl({
      coin: "BTC",
      orderId: 8123,
      positionSide: "long",
      size: "0.125",
      triggerPx: "59000",
      kind: "sl",
      isMarket: true,
    });

    expect(calls.modify).toHaveLength(1);
    expect(calls.modify[0]).toEqual({
      oid: 8123,
      order: {
        a: 0,
        b: false,
        p: "56050",
        s: "0.125",
        r: true,
        t: {
          trigger: { isMarket: true, triggerPx: "59000", tpsl: "sl" },
        },
      },
    });
  });
});

describe("HyperliquidClient.marketClose (mid fallback)", () => {
  it("fetches a fresh mid via allMids when no markPrice is supplied", async () => {
    // No markPrice on the request; the client must fetch the mid rather than throw.
    const { client, calls } = clientWithStub([BTC], { mids: { BTC: "60000" } });
    await client.marketClose({
      coin: "BTC",
      positionSize: "1",
      markPrice: undefined as unknown as string,
    });
    expect(calls.order.length).toBe(1);
    const o = calls.order[0].orders[0];
    // Closing a long → SELL, IoC, priced aggressively DOWN from the fetched mid.
    expect(o.t).toEqual({ limit: { tif: "Ioc" } });
    expect(o.b).toBe(false);
    expect(parseFloat(o.p)).toBeLessThan(60000);
    expect(o.r).toBe(true);
  });

  it("throws only when no markPrice is supplied AND the mid is unavailable", async () => {
    const { client } = clientWithStub([BTC], { mids: {} });
    await expect(
      client.marketClose({
        coin: "BTC",
        positionSize: "1",
        markPrice: undefined as unknown as string,
      }),
    ).rejects.toThrow(/no mid available/);
  });

  it("accepts a fetched mid exactly at the shared inclusive ceiling", async () => {
    const { client, calls } = clientWithStub([BTC], {
      mids: { BTC: "90071992.54740991" },
    });

    await client.placeOrder({
      coin: "BTC",
      side: "short",
      size: "1",
      orderType: "Market",
    });

    expect(calls.order).toHaveLength(1);
  });

  it("rejects the first fetched mid above the shared ceiling before submission", async () => {
    const { client, calls } = clientWithStub([BTC], {
      mids: { BTC: "90071992.54740992" },
    });

    await expect(
      client.placeOrder({
        coin: "BTC",
        side: "long",
        size: "1",
        orderType: "Market",
      }),
    ).rejects.toThrow(/safe|price|mid/i);
    expect(calls.order).toHaveLength(0);
  });

  it("protects a markless market close from an unsafe fetched mid", async () => {
    const { client, calls } = clientWithStub([BTC], {
      mids: { BTC: "90071992.54740992" },
    });

    await expect(
      client.marketClose({
        coin: "BTC",
        positionSize: "1",
        markPrice: undefined as unknown as string,
      }),
    ).rejects.toThrow(/unsafe positive mid/);
    expect(calls.order).toHaveLength(0);
  });

  it("scopes a HIP-3 close fallback to the coin's owning DEX", async () => {
    const { client } = clientWithStub([XYZ_JPY]);
    const requestedCoins: Array<string | undefined> = [];
    (
      client as unknown as {
        allMids: (coin?: string) => Promise<Record<string, string>>;
      }
    ).allMids = async (coin) => {
      requestedCoins.push(coin);
      return { "xyz:JPY": "163.685" };
    };

    await client.marketClose({
      coin: "xyz:JPY",
      positionSize: "1",
      markPrice: undefined as unknown as string,
    });

    expect(requestedCoins).toEqual(["xyz:JPY"]);
  });
});

describe("HyperliquidClient HIP-3 mid lookup scoping", () => {
  it("scopes a market-order fallback to the requested HIP-3 coin", async () => {
    const { client } = clientWithStub([XYZ_JPY]);
    const requestedCoins: Array<string | undefined> = [];
    (
      client as unknown as {
        allMids: (coin?: string) => Promise<Record<string, string>>;
      }
    ).allMids = async (coin) => {
      requestedCoins.push(coin);
      return { "xyz:JPY": "163.685" };
    };

    await client.placeOrder({
      coin: "xyz:JPY",
      side: "long",
      size: 1,
      orderType: "Market",
    });

    expect(requestedCoins).toEqual(["xyz:JPY"]);
  });

  /** A client whose clearinghouseState returns exactly `state` for the main dex. */
  function clientReturningState(state: Record<string, unknown>) {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
        ];
      },
      async clearinghouseState() {
        return state;
      },
    };
    (
      client as unknown as {
        allMids: () => Promise<Record<string, string>>;
      }
    ).allMids = async () => ({ BTC: "60000" });
    return client;
  }

  const BTC_POSITION = {
    coin: "BTC",
    szi: "1",
    leverage: { type: "cross" as const, value: 5 },
    entryPx: "100",
    liquidationPx: null,
    unrealizedPnl: "0",
    marginUsed: "20",
    cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
  };

  it("returns the CROSS margin summary alongside positions", async () => {
    // Cross, not `marginSummary`: the latter folds in isolated positions whose
    // equity is locked to their own asset and cannot back a new order.
    const client = clientReturningState({
      assetPositions: [{ position: BTC_POSITION }],
      marginSummary: { accountValue: "9999", totalMarginUsed: "8888" },
      crossMarginSummary: { accountValue: "1000", totalMarginUsed: "250" },
    });

    const snapshot = await client.perpAccountSnapshot(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(snapshot.crossMargin).toEqual({
      accountValueUsd: "1000",
      totalMarginUsedUsd: "250",
    });
    expect(snapshot.positions.map((position) => position.coin)).toEqual([
      "BTC",
    ]);
  });

  it("degrades the summary to null rather than throwing a positions read", async () => {
    // listPositions is on the copy-mirror and order-submission paths. A field
    // that only the ticket's size chips read must never be able to break it.
    for (const state of [
      { assetPositions: [{ position: BTC_POSITION }] },
      {
        assetPositions: [{ position: BTC_POSITION }],
        crossMarginSummary: { accountValue: "1000" },
      },
      {
        assetPositions: [{ position: BTC_POSITION }],
        crossMarginSummary: { accountValue: 1000, totalMarginUsed: 250 },
      },
    ]) {
      const client = clientReturningState(state);
      const snapshot = await client.perpAccountSnapshot(
        "0xdef0000000000000000000000000000000000abc",
      );
      expect(snapshot.crossMargin).toBeNull();
      expect(snapshot.positions).toHaveLength(1);
    }
  });

  it("listPositions still returns just rows, for its existing callers", async () => {
    const client = clientReturningState({
      assetPositions: [{ position: BTC_POSITION }],
      crossMarginSummary: { accountValue: "1000", totalMarginUsed: "250" },
    });

    const positions = await client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(Array.isArray(positions)).toBe(true);
    expect(positions[0]?.coin).toBe("BTC");
  });

  it("aborts the authoritative account-state read when its caller deadline expires", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [{ universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] }];
      },
      async clearinghouseState(_params: unknown, signal?: AbortSignal) {
        return await new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const controller = new AbortController();
    const snapshot = client.perpAccountSnapshot(
      "0xdef0000000000000000000000000000000000abc",
      controller.signal,
    );

    controller.abort(new Error("leaderboard deadline"));

    await expect(snapshot).rejects.toThrow("leaderboard deadline");
  });

  it("queries every discovered DEX and loads mids for all returned positions", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    const requestedDexes: Array<string | undefined> = [];
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          {
            universe: [{ name: "xyz:JPY", szDecimals: 2, maxLeverage: 50 }],
          },
        ];
      },
      async clearinghouseState({ dex }: { dex?: string }) {
        requestedDexes.push(dex);
        const position = (coin: string) => ({
          coin,
          szi: "1",
          leverage: { type: "cross" as const, value: 5 },
          entryPx: "100",
          liquidationPx: null,
          unrealizedPnl: "0",
          marginUsed: "20",
          cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
        });
        return {
          assetPositions: [
            { position: position(dex === "xyz" ? "xyz:JPY" : "BTC") },
          ],
        };
      },
    };
    const requestedMids: Array<{
      coin: string | undefined;
      signal: AbortSignal | undefined;
    }> = [];
    (
      client as unknown as {
        allMids: (
          coin?: string,
          signal?: AbortSignal,
        ) => Promise<Record<string, string>>;
      }
    ).allMids = async (coin, signal) => {
      requestedMids.push({ coin, signal });
      return coin === "xyz:JPY" ? { "xyz:JPY": "163.685" } : { BTC: "60000" };
    };

    const positions = await client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(requestedDexes).toEqual([undefined, "xyz"]);
    expect(requestedMids.map(({ coin }) => coin)).toEqual(["BTC", "xyz:JPY"]);
    expect(requestedMids[0]?.signal).toBeUndefined();
    expect(requestedMids[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(positions.map((position) => position.markPx)).toEqual([
      "60000",
      "163.685",
    ]);
  });

  it("preserves main-DEX positions when the main mids read fails", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
        ];
      },
      async clearinghouseState() {
        return {
          assetPositions: [
            {
              position: {
                coin: "BTC",
                szi: "1",
                leverage: { type: "cross" as const, value: 5 },
                entryPx: "60000",
                liquidationPx: null,
                unrealizedPnl: "100",
                marginUsed: "12000",
                cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
              },
            },
          ],
        };
      },
    };
    let receivedSignal: AbortSignal | undefined;
    (
      client as unknown as {
        allMids: (
          coin?: string,
          signal?: AbortSignal,
        ) => Promise<Record<string, string>>;
      }
    ).allMids = async (_coin, signal) => {
      receivedSignal = signal;
      throw new Error("main mids unavailable");
    };

    const positions = await client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(receivedSignal).toBeUndefined();
    expect(positions).toEqual([
      expect.objectContaining({ coin: "BTC", markPx: null }),
    ]);
  });

  it("keeps successful positions when an unrelated HIP-3 state request fails", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          {
            universe: [{ name: "xyz:JPY", szDecimals: 2, maxLeverage: 50 }],
          },
          {
            universe: [{ name: "broken:ABC", szDecimals: 2, maxLeverage: 20 }],
          },
        ];
      },
    };
    const requestedDexes: Array<string | undefined> = [];
    (
      client as unknown as {
        clearinghouseState: (
          address: `0x${string}`,
          dex?: string,
        ) => Promise<unknown>;
      }
    ).clearinghouseState = async (_address, dex) => {
      requestedDexes.push(dex);
      if (dex === "broken") throw new Error("HIP-3 state unavailable");
      return {
        assetPositions: [
          {
            position: {
              coin: dex === "xyz" ? "xyz:JPY" : "BTC",
              szi: "1",
              leverage: { type: "cross" as const, value: 5 },
              entryPx: "100",
              liquidationPx: null,
              unrealizedPnl: "0",
              marginUsed: "20",
              cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
            },
          },
        ],
      };
    };
    (
      client as unknown as {
        allMids: (coin?: string) => Promise<Record<string, string>>;
      }
    ).allMids = async (coin) =>
      coin === "xyz:JPY" ? { "xyz:JPY": "163.685" } : { BTC: "60000" };

    const positions = await client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(requestedDexes).toEqual([undefined, "xyz", "broken"]);
    expect(positions.map((position) => position.coin)).toEqual([
      "BTC",
      "xyz:JPY",
    ]);
    expect(positions.map((position) => position.markPx)).toEqual([
      "60000",
      "163.685",
    ]);
  });

  it("returns main positions while an additive HIP-3 state request remains pending", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    let hip3WasAborted = false;
    let releaseHip3: (() => void) | undefined;
    const hip3Gate = new Promise<void>((resolve) => {
      releaseHip3 = resolve;
    });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          {
            universe: [{ name: "xyz:JPY", szDecimals: 2, maxLeverage: 50 }],
          },
        ];
      },
      async clearinghouseState(
        { dex }: { dex?: string },
        signal?: AbortSignal,
      ) {
        if (dex === "xyz") {
          await new Promise<void>((resolve, reject) => {
            void hip3Gate.then(resolve);
            signal?.addEventListener(
              "abort",
              () => {
                hip3WasAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }
        return {
          assetPositions: [
            {
              position: {
                coin: dex === "xyz" ? "xyz:JPY" : "BTC",
                szi: "1",
                leverage: { type: "cross" as const, value: 5 },
                entryPx: "100",
                liquidationPx: null,
                unrealizedPnl: "0",
                marginUsed: "20",
                cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
              },
            },
          ],
        };
      },
    };
    (
      client as unknown as {
        allMids: (coin?: string) => Promise<Record<string, string>>;
      }
    ).allMids = async () => ({ BTC: "60000" });

    const positionsPromise = client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );
    const result = await Promise.race([
      positionsPromise,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 750);
      }),
    ]);
    releaseHip3?.();
    await positionsPromise;

    expect(result).not.toBe("timed-out");
    expect(hip3WasAborted).toBe(true);
    expect(result).toEqual([
      expect.objectContaining({ coin: "BTC", markPx: "60000" }),
    ]);
  });

  it("returns positions while an additive HIP-3 mid lookup remains pending", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    let hip3MidsWereAborted = false;
    let releaseHip3Mids: (() => void) | undefined;
    const hip3MidsGate = new Promise<void>((resolve) => {
      releaseHip3Mids = resolve;
    });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          {
            universe: [{ name: "xyz:JPY", szDecimals: 2, maxLeverage: 50 }],
          },
        ];
      },
      async clearinghouseState({ dex }: { dex?: string }) {
        return {
          assetPositions: [
            {
              position: {
                coin: dex === "xyz" ? "xyz:JPY" : "BTC",
                szi: "1",
                leverage: { type: "cross" as const, value: 5 },
                entryPx: "100",
                liquidationPx: null,
                unrealizedPnl: "0",
                marginUsed: "20",
                cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
              },
            },
          ],
        };
      },
      async allMids(params?: { dex?: string }, signal?: AbortSignal) {
        if (params?.dex === "xyz") {
          await new Promise<void>((resolve, reject) => {
            void hip3MidsGate.then(resolve);
            signal?.addEventListener(
              "abort",
              () => {
                hip3MidsWereAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
          return { "xyz:JPY": "163.685" };
        }
        return { BTC: "60000" };
      },
    };

    const positionsPromise = client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );
    const result = await Promise.race([
      positionsPromise,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 750);
      }),
    ]);
    releaseHip3Mids?.();
    await positionsPromise;

    expect(result).not.toBe("timed-out");
    expect(hip3MidsWereAborted).toBe(true);
    expect(result).toEqual([
      expect.objectContaining({ coin: "BTC", markPx: "60000" }),
      expect.objectContaining({ coin: "xyz:JPY", markPx: null }),
    ]);
  });

  it("falls back to main-DEX positions when HIP-3 metadata discovery fails", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        throw new Error("metadata unavailable");
      },
    };
    const requestedDexes: Array<string | undefined> = [];
    (
      client as unknown as {
        clearinghouseState: (
          address: `0x${string}`,
          dex?: string,
        ) => Promise<unknown>;
      }
    ).clearinghouseState = async (_address, dex) => {
      requestedDexes.push(dex);
      return {
        assetPositions: [
          {
            position: {
              coin: "BTC",
              szi: "1",
              leverage: { type: "cross" as const, value: 5 },
              entryPx: "60000",
              liquidationPx: null,
              unrealizedPnl: "100",
              marginUsed: "12000",
              cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
            },
          },
        ],
      };
    };
    (
      client as unknown as {
        allMids: (coin?: string) => Promise<Record<string, string>>;
      }
    ).allMids = async () => ({ BTC: "60100" });

    const positions = await client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(requestedDexes).toEqual([undefined]);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.coin).toBe("BTC");
    expect(positions[0]?.markPx).toBe("60100");
  });

  it("returns main-DEX positions while metadata discovery remains pending", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    let metadataWasAborted = false;
    let releaseMetadata: (() => void) | undefined;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas(signal?: AbortSignal) {
        await new Promise<void>((resolve, reject) => {
          void metadataGate.then(resolve);
          signal?.addEventListener(
            "abort",
            () => {
              metadataWasAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
        ];
      },
    };
    const requestedDexes: Array<string | undefined> = [];
    (
      client as unknown as {
        clearinghouseState: (
          address: `0x${string}`,
          dex?: string,
        ) => Promise<unknown>;
      }
    ).clearinghouseState = async (_address, dex) => {
      requestedDexes.push(dex);
      return { assetPositions: [] };
    };

    (
      client as unknown as {
        allMids: (coin?: string) => Promise<Record<string, string>>;
      }
    ).allMids = async () => ({ BTC: "60100" });

    const positionsPromise = client.listPositions(
      "0xdef0000000000000000000000000000000000abc",
    );
    const result = await Promise.race([
      positionsPromise,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 750);
      }),
    ]);
    releaseMetadata?.();

    expect(result).not.toBe("timed-out");
    expect(metadataWasAborted).toBe(true);
    expect(result).toEqual([]);
    expect(requestedDexes).toEqual([undefined]);
  });

  it("surfaces a main-DEX state failure when a HIP-3 state succeeds", async () => {
    const client = new HyperliquidClient({ network: "mainnet" });
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        return [
          { universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] },
          {
            universe: [{ name: "xyz:JPY", szDecimals: 2, maxLeverage: 50 }],
          },
        ];
      },
    };
    (
      client as unknown as {
        clearinghouseState: (
          address: `0x${string}`,
          dex?: string,
        ) => Promise<unknown>;
      }
    ).clearinghouseState = async (_address, dex) => {
      if (dex === undefined) throw new Error("main DEX state unavailable");
      return { assetPositions: [] };
    };

    await expect(
      client.listPositions("0xdef0000000000000000000000000000000000abc"),
    ).rejects.toThrow("main DEX state unavailable");
  });
});

describe("HyperliquidClient setup helpers (master-signed, no retry)", () => {
  it("approveAgent defaults the agent name and forwards the address", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.approveAgent({
      agentAddress: "0xabc0000000000000000000000000000000000001",
    });
    expect(calls.approveAgent.length).toBe(1);
    expect(calls.approveAgent[0]).toEqual({
      agentAddress: "0xabc0000000000000000000000000000000000001",
      agentName: "readysettrade",
    });
  });

  it("approveBuilderFee forwards the builder + maxFeeRate", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.approveBuilderFee({
      builder: "0x1234567890123456789012345678901234567890",
      maxFeeRate: "0.1%",
    });
    expect(calls.approveBuilderFee.length).toBe(1);
    expect(calls.approveBuilderFee[0]).toEqual({
      builder: "0x1234567890123456789012345678901234567890",
      maxFeeRate: "0.1%",
    });
  });
});

describe("HyperliquidClient.updateLeverage", () => {
  it("clamps leverage to the asset max and maps margin mode to isCross", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.updateLeverage({
      coin: "BTC",
      leverage: 100,
      marginMode: "cross",
    });
    expect(calls.updateLeverage[0]).toEqual({
      asset: 0,
      isCross: true,
      leverage: 40,
    });

    await client.updateLeverage({
      coin: "BTC",
      leverage: 5,
      marginMode: "isolated",
    });
    expect(calls.updateLeverage[1]).toEqual({
      asset: 0,
      isCross: false,
      leverage: 5,
    });
  });
});

describe("HyperliquidClient.cancelOrder", () => {
  it("resolves the coin to an asset index and cancels by oid", async () => {
    const { client, calls } = clientWithStub([BTC]);
    await client.cancelOrder({ coin: "BTC", orderId: 12345 });
    expect(calls.cancel[0]).toEqual({ cancels: [{ a: 0, o: 12345 }] });
  });
});

describe("isAgentApproved", () => {
  it("returns true when the agent address is present (exact case)", () => {
    const agents = [
      {
        address: "0xabc0000000000000000000000000000000000001",
        name: "readysettrade",
        validUntil: null,
      },
    ];
    expect(
      isAgentApproved(agents, "0xabc0000000000000000000000000000000000001"),
    ).toBe(true);
  });

  it("matches case-insensitively (checksummed stored vs lowercase HL response)", () => {
    const agents = [
      {
        address: "0xabcdef0000000000000000000000000000000001",
        name: "readysettrade",
        validUntil: null,
      },
    ];
    // Stored/queried address is upper/mixed case; HL response is lowercase.
    expect(
      isAgentApproved(agents, "0xABCDEF0000000000000000000000000000000001"),
    ).toBe(true);
  });

  it("returns false when the agent is not in the approved list (mismatch / never approved)", () => {
    const agents = [
      {
        address: "0xother0000000000000000000000000000000009",
        name: "someone-else",
        validUntil: null,
      },
    ];
    expect(
      isAgentApproved(agents, "0xabc0000000000000000000000000000000000001"),
    ).toBe(false);
  });

  it("returns false for an empty approved list", () => {
    expect(
      isAgentApproved([], "0xabc0000000000000000000000000000000000001"),
    ).toBe(false);
  });
});

describe("HyperliquidClient.extraAgents", () => {
  it("calls the InfoClient extraAgents with the master user and returns the list", async () => {
    const { client } = clientWithStub([BTC]);
    const calls: Array<{ user: string }> = [];
    const stubResponse = [
      {
        address: "0xabc0000000000000000000000000000000000001",
        name: "readysettrade",
        validUntil: null,
      },
    ];
    (client as unknown as { info: unknown }).info = {
      async extraAgents(params: { user: string }) {
        calls.push(params);
        return stubResponse;
      },
    };

    const result = await client.extraAgents(
      "0xdef0000000000000000000000000000000000abc",
    );
    expect(calls).toEqual([
      { user: "0xdef0000000000000000000000000000000000abc" },
    ]);
    expect(result).toEqual(stubResponse);
  });
});

describe("isTradableOnHl", () => {
  const universe: PerpAssetMeta[] = [
    { coin: "BTC", assetIndex: 0, szDecimals: 3, maxLeverage: 40 },
    { coin: "ETH", assetIndex: 1, szDecimals: 4, maxLeverage: 25 },
    {
      coin: "OLD",
      assetIndex: 2,
      szDecimals: 2,
      maxLeverage: 5,
      isDelisted: true,
    },
  ];

  it("returns true for a listed coin", () => {
    expect(isTradableOnHl(universe, "BTC")).toBe(true);
    expect(isTradableOnHl(universe, "ETH")).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isTradableOnHl(universe, "btc")).toBe(true);
    expect(isTradableOnHl(universe, "  Eth  ")).toBe(true);
  });

  it("returns false for a delisted coin (in the universe but not tradable)", () => {
    expect(isTradableOnHl(universe, "OLD")).toBe(false);
  });

  it("returns false for an unknown coin and for an empty symbol", () => {
    expect(isTradableOnHl(universe, "DOGE")).toBe(false);
    expect(isTradableOnHl(universe, "")).toBe(false);
    expect(isTradableOnHl(universe, "   ")).toBe(false);
  });

  it("returns false against an empty universe", () => {
    expect(isTradableOnHl([], "BTC")).toBe(false);
  });
});

describe("normalizePerpFill", () => {
  // A representative raw HL userFills row (extra SDK fields included to prove the
  // normalizer only projects the fields we care about).
  const rawBuy = {
    coin: "BTC",
    px: "50000.5",
    sz: "0.25",
    side: "B" as const,
    time: 1_700_000_000_000,
    startPosition: "0.0",
    dir: "Open Long",
    closedPnl: "0.0",
    hash: "0xhash",
    oid: 123456,
    crossed: true,
    fee: "1.25",
    builderFee: "0.5",
    tid: 987654,
    cloid: "0x11111111111111111111111111111111" as const,
    feeToken: "USDC",
    twapId: null,
  };

  it("maps a bid ('B') fill to buy and projects the display fields", () => {
    expect(normalizePerpFill(rawBuy)).toEqual({
      time: 1_700_000_000_000,
      coin: "BTC",
      side: "buy",
      px: "50000.5",
      sz: "0.25",
      closedPnl: "0.0",
      fee: "1.25",
      dir: "Open Long",
      oid: 123456,
      hash: "0xhash",
      tid: 987654,
      cloid: "0x11111111111111111111111111111111",
    });
  });

  it("normalizes a venue fill without a client order id to null", () => {
    const { cloid: _cloid, ...withoutCloid } = rawBuy;
    expect(normalizePerpFill(withoutCloid).cloid).toBeNull();
  });

  it("maps an ask ('A') fill to sell and preserves signed closedPnl and rebate fee", () => {
    const row = normalizePerpFill({
      ...rawBuy,
      side: "A",
      dir: "Close Long",
      closedPnl: "-42.5",
      fee: "-0.75",
    });
    expect(row.side).toBe("sell");
    expect(row.dir).toBe("Close Long");
    expect(row.closedPnl).toBe("-42.5");
    expect(row.fee).toBe("-0.75");
  });

  it("does not carry through unrelated raw SDK fields", () => {
    const row = normalizePerpFill(rawBuy) as Record<string, unknown>;
    expect(row.startPosition).toBeUndefined();
    expect(row.crossed).toBeUndefined();
    expect(row.builderFee).toBeUndefined();
    expect(row.feeToken).toBeUndefined();
  });
});

describe("HyperliquidClient.listFills", () => {
  it("does not retry a 429 inside the request burst", async () => {
    const { client } = clientWithStub([BTC]);
    let attempts = 0;
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const rateLimited = new HttpRequestError({
      response: new Response(null, {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    });
    (client as unknown as { info: unknown }).info = {
      async userFills() {
        attempts++;
        throw rateLimited;
      },
    };

    globalThis.setTimeout = ((
      handler: (...args: any[]) => void,
      timeout?: number,
      ...args: any[]
    ) => {
      delays.push(Number(timeout ?? 0));
      handler(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      await expect(
        client.listFills("0xabc0000000000000000000000000000000000001"),
      ).rejects.toBe(rateLimited);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it("returns the first 429 to the scheduled caller", async () => {
    const { client } = clientWithStub([BTC]);
    let attempts = 0;
    const originalSetTimeout = globalThis.setTimeout;
    const rateLimited = new HttpRequestError({
      response: new Response(null, {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    });
    (client as unknown as { info: unknown }).info = {
      async userFills() {
        attempts++;
        throw rateLimited;
      },
    };

    globalThis.setTimeout = ((
      handler: (...args: any[]) => void,
      ...args: any[]
    ) => {
      handler(...args.slice(1));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      await expect(
        client.userFills("0xabc0000000000000000000000000000000000001"),
      ).rejects.toBe(rateLimited);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(attempts).toBe(1);
  });

  it("does not retry a non-transient HTTP read failure", async () => {
    const { client } = clientWithStub([BTC]);
    let attempts = 0;
    const badRequest = new HttpRequestError({
      response: new Response(null, { status: 400 }),
    });
    (client as unknown as { info: unknown }).info = {
      async userFills() {
        attempts++;
        throw badRequest;
      },
    };

    await expect(
      client.userFills("0xabc0000000000000000000000000000000000001"),
    ).rejects.toBe(badRequest);
    expect(attempts).toBe(1);
  });

  it("retries timeout and server responses, plus transient transport errors", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      handler: (...args: any[]) => void,
      ...args: any[]
    ) => {
      handler(...args.slice(1));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      for (const status of [408, 500, 503]) {
        const { client } = clientWithStub([BTC]);
        let attempts = 0;
        (client as unknown as { info: unknown }).info = {
          async userFills() {
            attempts++;
            if (attempts === 1) {
              throw new HttpRequestError({
                response: new Response(null, {
                  status,
                  headers: { "Retry-After": "0" },
                }),
              });
            }
            return [];
          },
        };

        await expect(
          client.userFills("0xabc0000000000000000000000000000000000001"),
        ).resolves.toEqual([]);
        expect(attempts).toBe(2);
      }

      const { client: malformedResponseClient } = clientWithStub([BTC]);
      let malformedAttempts = 0;
      (malformedResponseClient as unknown as { info: unknown }).info = {
        async userFills() {
          malformedAttempts++;
          if (malformedAttempts === 1) {
            throw new HttpRequestError({
              response: new Response("not-json", { status: 200 }),
              detail: "Invalid JSON response body",
            });
          }
          return [];
        },
      };
      await expect(
        malformedResponseClient.userFills(
          "0xabc0000000000000000000000000000000000001",
        ),
      ).resolves.toEqual([]);
      expect(malformedAttempts).toBe(2);

      const { client } = clientWithStub([BTC]);
      let attempts = 0;
      (client as unknown as { info: unknown }).info = {
        async userFills() {
          attempts++;
          if (attempts === 1) {
            throw Object.assign(new Error("fetch failed"), {
              code: "ECONNRESET",
            });
          }
          return [];
        },
      };
      await expect(
        client.userFills("0xabc0000000000000000000000000000000000001"),
      ).resolves.toEqual([]);
      expect(attempts).toBe(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("maps userFills rows to normalized fills and applies the limit (newest-first order preserved)", async () => {
    const { client } = clientWithStub([BTC]);
    const calls: Array<{ user: string }> = [];
    const rawFills = [
      {
        coin: "BTC",
        px: "51000",
        sz: "0.1",
        side: "A",
        time: 3,
        startPosition: "0.2",
        dir: "Close Long",
        closedPnl: "10",
        hash: "0xh3",
        oid: 3,
        crossed: true,
        fee: "0.1",
        tid: 30,
        feeToken: "USDC",
        twapId: null,
      },
      {
        coin: "ETH",
        px: "3000",
        sz: "1",
        side: "B",
        time: 2,
        startPosition: "0",
        dir: "Open Long",
        closedPnl: "0",
        hash: "0xh2",
        oid: 2,
        crossed: false,
        fee: "0.2",
        tid: 20,
        feeToken: "USDC",
        twapId: null,
      },
      {
        coin: "BTC",
        px: "50000",
        sz: "0.3",
        side: "B",
        time: 1,
        startPosition: "0",
        dir: "Open Long",
        closedPnl: "0",
        hash: "0xh1",
        oid: 1,
        crossed: true,
        fee: "0.3",
        tid: 10,
        feeToken: "USDC",
        twapId: null,
      },
    ];
    (client as unknown as { info: unknown }).info = {
      async userFills(params: { user: string }) {
        calls.push(params);
        return rawFills;
      },
    };

    const result = await client.listFills(
      "0xabc0000000000000000000000000000000000001",
      2,
    );
    expect(calls).toEqual([
      { user: "0xabc0000000000000000000000000000000000001" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ coin: "BTC", side: "sell", tid: 30 });
    expect(result[1]).toMatchObject({ coin: "ETH", side: "buy", tid: 20 });
  });

  it("returns every normalized fill when no limit is given", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userFills() {
        return [
          {
            coin: "BTC",
            px: "50000",
            sz: "0.3",
            side: "B",
            time: 1,
            startPosition: "0",
            dir: "Open Long",
            closedPnl: "0",
            hash: "0xh1",
            oid: 1,
            crossed: true,
            fee: "0.3",
            tid: 10,
            feeToken: "USDC",
            twapId: null,
          },
        ];
      },
    };
    const result = await client.listFills(
      "0xabc0000000000000000000000000000000000001",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.side).toBe("buy");
  });
});

/** A raw HL `frontendOpenOrders` row, minimal fields the normalizer reads. */
function rawOpenOrder(overrides: Record<string, unknown> = {}) {
  return {
    coin: "BTC",
    side: "A" as "A" | "B",
    limitPx: "51000",
    sz: "0.5",
    oid: 12345,
    timestamp: 1_700_000_000_000,
    origSz: "0.5",
    triggerCondition: "N/A",
    isTrigger: true,
    triggerPx: "49000",
    children: [],
    isPositionTpsl: true,
    reduceOnly: true,
    orderType: "Stop Market",
    tif: null,
    cloid: null,
    ...overrides,
  };
}

describe("mapOpenOrderRow", () => {
  it("normalizes a stop-loss trigger (A→sell, tpsl 'sl', triggerPx kept)", () => {
    const row = mapOpenOrderRow(rawOpenOrder());
    expect(row).toEqual({
      coin: "BTC",
      side: "sell",
      oid: 12345,
      cloid: null,
      sz: "0.5",
      origSz: "0.5",
      limitPx: "51000",
      isTrigger: true,
      triggerPx: "49000",
      tpsl: "sl",
      reduceOnly: true,
      isPositionTpsl: true,
      orderType: "Stop Market",
      timestamp: 1_700_000_000_000,
    });
  });

  it("maps a Take Profit order to tpsl 'tp' and B→buy", () => {
    const row = mapOpenOrderRow(
      rawOpenOrder({
        side: "B",
        orderType: "Take Profit Limit",
        triggerPx: "60000",
      }),
    );
    expect(row.side).toBe("buy");
    expect(row.tpsl).toBe("tp");
    expect(row.triggerPx).toBe("60000");
  });

  it("nulls triggerPx and tpsl for a non-trigger (plain limit) order", () => {
    const row = mapOpenOrderRow(
      rawOpenOrder({
        isTrigger: false,
        orderType: "Limit",
        triggerPx: "0",
        isPositionTpsl: false,
        reduceOnly: false,
      }),
    );
    expect(row.isTrigger).toBe(false);
    expect(row.triggerPx).toBeNull();
    expect(row.tpsl).toBeNull();
    expect(row.reduceOnly).toBe(false);
  });

  it("preserves a cloid when present", () => {
    const row = mapOpenOrderRow(
      rawOpenOrder({ cloid: "0x00000000000000000000000000000001" }),
    );
    expect(row.cloid).toBe("0x00000000000000000000000000000001");
  });
});

describe("HyperliquidClient.openOrders", () => {
  it("scopes protection reads to the requested DEX despite other discovered markets", async () => {
    const { client } = clientWithStub([BTC, XYZ_JPY]);
    const calls: Array<{ user: string; dex?: string }> = [];
    (client as unknown as { info: unknown }).info = {
      async openOrders(params: { user: string; dex?: string }) {
        calls.push(params);
        return [];
      },
    };
    const user = "0xdef0000000000000000000000000000000000abc";
    await client.openOrders(user, [""]);
    expect(calls).toEqual([{ user }]);
    calls.length = 0;
    await client.openOrders(user, ["xyz"]);
    expect(calls).toEqual([{ user, dex: "xyz" }]);
  });
  it("queries only the main dex when no HIP-3 dex is discovered (no regression)", async () => {
    const { client } = clientWithStub([BTC]);
    const calls: Array<{ user: string; dex?: string }> = [];
    (client as unknown as { info: unknown }).info = {
      async openOrders(params: { user: string; dex?: string }) {
        calls.push(params);
        return [rawOpenOrder({ coin: "BTC", oid: 1 })];
      },
    };

    const result = await client.openOrders(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(calls).toEqual([
      { user: "0xdef0000000000000000000000000000000000abc" },
    ]);
    expect(result.map((o: { oid: number }) => o.oid)).toEqual([1]);
  });

  it("merges resting orders from every discovered HIP-3 dex with the main dex, so a resting xyz: order is not invisible to the reconciler", async () => {
    const { client } = clientWithStub([BTC, XYZ_JPY]);
    const requestedDexes: Array<string | undefined> = [];
    (client as unknown as { info: unknown }).info = {
      async openOrders(params: { user: string; dex?: string }) {
        requestedDexes.push(params.dex);
        // Main dex has a resting BTC order; the xyz dex has a resting HIP-3
        // order the pre-fix client never asked about.
        return params.dex === "xyz"
          ? [rawOpenOrder({ coin: "xyz:JPY", oid: 777 })]
          : [rawOpenOrder({ coin: "BTC", oid: 111 })];
      },
    };

    const result = await client.openOrders(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(requestedDexes.map((d) => d ?? "").sort()).toEqual(["", "xyz"]);
    expect(
      result.map((o: { oid: number }) => o.oid).sort((a, b) => a - b),
    ).toEqual([111, 777]);
  });

  it("propagates a HIP-3 dex read failure rather than silently reporting the account as flat there (a false absence would read as CANCELLED)", async () => {
    const { client } = clientWithStub([BTC, XYZ_JPY]);
    (client as unknown as { info: unknown }).info = {
      async openOrders(params: { user: string; dex?: string }) {
        if (params.dex === "xyz") throw new Error("boom");
        return [rawOpenOrder({ coin: "BTC", oid: 111 })];
      },
    };

    await expect(
      client.openOrders("0xdef0000000000000000000000000000000000abc"),
    ).rejects.toThrow("boom");
  });

  it("reports incomplete HIP-3 coverage without turning the unavailable dex into an empty snapshot", async () => {
    const { client } = clientWithStub([BTC, XYZ_JPY]);
    (client as unknown as { info: unknown }).info = {
      async openOrders(params: { user: string; dex?: string }) {
        if (params.dex === "xyz") throw new Error("boom");
        return [rawOpenOrder({ coin: "BTC", oid: 111 })];
      },
    };

    const result = await client.openOrdersWithStatus(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(result.complete).toBe(false);
    expect(result.coveredDexes).toEqual([""]);
    expect(result.orders.map((order) => order.oid)).toEqual([111]);
    expect(result.failures).toEqual([{ source: "xyz", transient: false }]);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("queries only explicitly requested DEX partitions without metadata discovery", async () => {
    const { client } = clientWithStub([BTC, XYZ_JPY]);
    const requestedDexes: Array<string | undefined> = [];
    let metadataReads = 0;
    (client as unknown as { assetCache: unknown }).assetCache = null;
    (client as unknown as { info: unknown }).info = {
      async allPerpMetas() {
        metadataReads++;
        return [];
      },
      async openOrders(params: { user: string; dex?: string }) {
        requestedDexes.push(params.dex);
        return [];
      },
    };

    const result = await client.openOrdersWithStatus(
      "0xdef0000000000000000000000000000000000abc",
      ["", "xyz", "xyz"],
    );

    expect(metadataReads).toBe(0);
    expect(requestedDexes.map((dex) => dex ?? "").sort()).toEqual(["", "xyz"]);
    expect(result.complete).toBe(true);
  });
});

describe("HyperliquidClient.listOpenOrders", () => {
  it("calls frontendOpenOrders with the master user and returns normalized rows", async () => {
    const { client } = clientWithStub([BTC]);
    const calls: Array<{ user: string }> = [];
    (client as unknown as { info: unknown }).info = {
      async frontendOpenOrders(params: { user: string }) {
        calls.push(params);
        return [
          rawOpenOrder(),
          rawOpenOrder({
            side: "B",
            orderType: "Take Profit Market",
            oid: 999,
            triggerPx: "60000",
          }),
        ];
      },
    };

    const result = await client.listOpenOrders(
      "0xdef0000000000000000000000000000000000abc",
    );
    expect(calls).toEqual([
      { user: "0xdef0000000000000000000000000000000000abc" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      coin: "BTC",
      side: "sell",
      tpsl: "sl",
      oid: 12345,
    });
    expect(result[1]).toMatchObject({
      side: "buy",
      tpsl: "tp",
      oid: 999,
      triggerPx: "60000",
    });
  });

  it("also queries every discovered HIP-3 dex, so a resting xyz: order is not invisible to the UI", async () => {
    const { client } = clientWithStub([BTC, XYZ_JPY]);
    const requestedDexes: Array<string | undefined> = [];
    (client as unknown as { info: unknown }).info = {
      async frontendOpenOrders(params: { user: string; dex?: string }) {
        requestedDexes.push(params.dex);
        return params.dex === "xyz"
          ? [rawOpenOrder({ coin: "xyz:JPY", oid: 555 })]
          : [rawOpenOrder({ coin: "BTC", oid: 12345 })];
      },
    };

    const result = await client.listOpenOrders(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(requestedDexes.map((d) => d ?? "").sort()).toEqual(["", "xyz"]);
    expect(result.map((r) => r.oid).sort((a, b) => a - b)).toEqual([
      555, 12345,
    ]);
  });
});

describe("mapPositionRow", () => {
  it("maps a long clearinghouse position to a normalized row with mark price and funding", () => {
    const row = mapPositionRow(
      {
        coin: "BTC",
        szi: "1.5",
        leverage: { type: "cross", value: 10 },
        entryPx: "50000",
        liquidationPx: "45000",
        unrealizedPnl: "123.45",
        marginUsed: "7500",
        cumFunding: { allTime: "10", sinceOpen: "-2.5", sinceChange: "-1" },
      },
      { BTC: "51000" },
    );
    expect(row).toEqual({
      coin: "BTC",
      side: "long",
      size: "1.5",
      entryPx: "50000",
      markPx: "51000",
      liquidationPx: "45000",
      unrealizedPnl: "123.45",
      returnOnEquity: null,
      leverage: 10,
      marginMode: "cross",
      marginUsed: "7500",
      funding: "-2.5",
    });
  });

  it("infers a short side from a negative szi and reports absolute size", () => {
    const row = mapPositionRow(
      {
        coin: "ETH",
        szi: "-3",
        leverage: { type: "isolated", value: 5 },
        entryPx: "3000",
        liquidationPx: null,
        unrealizedPnl: "-50",
        marginUsed: "1800",
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
      {},
    );
    expect(row.side).toBe("short");
    expect(row.size).toBe("3");
    expect(row.markPx).toBeNull();
    expect(row.marginMode).toBe("isolated");
    // A HL-supplied null liquidationPx (no liq, e.g. tiny/cross) must map to
    // null, never 0 or a computed number.
    expect(row.liquidationPx).toBeNull();
  });

  // HL6: the liquidation price must come straight from the venue's
  // `liquidationPx` (authoritative cross/isolated maintenance-margin math),
  // never a client-side formula off entryPx/leverage. These lock that in.
  it("passes the venue liquidationPx through unchanged for a LONG", () => {
    const row = mapPositionRow(
      {
        coin: "BTC",
        szi: "2",
        leverage: { type: "cross", value: 20 },
        entryPx: "60000",
        liquidationPx: "57123.5",
        unrealizedPnl: "0",
        marginUsed: "6000",
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
      { BTC: "60500" },
    );
    expect(row.side).toBe("long");
    // Byte-for-byte the venue value, not a recomputed one.
    expect(row.liquidationPx).toBe("57123.5");
  });

  it("passes the venue liquidationPx through unchanged for a SHORT", () => {
    const row = mapPositionRow(
      {
        coin: "ETH",
        szi: "-10",
        leverage: { type: "isolated", value: 8 },
        entryPx: "3000",
        liquidationPx: "3412.75",
        unrealizedPnl: "0",
        marginUsed: "3750",
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
      { ETH: "2990" },
    );
    expect(row.side).toBe("short");
    expect(row.liquidationPx).toBe("3412.75");
  });

  it("preserves a low-priced coin's liquidationPx without truncation", () => {
    const row = mapPositionRow(
      {
        coin: "kPEPE",
        szi: "1000000",
        leverage: { type: "cross", value: 3 },
        entryPx: "0.0000082",
        liquidationPx: "0.0000075",
        unrealizedPnl: "0",
        marginUsed: "2.7",
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
      { kPEPE: "0.0000081" },
    );
    // Raw string is carried through, so no precision is lost in the mapping.
    expect(row.liquidationPx).toBe("0.0000075");
  });

  it("maps liquidationPx and funding (cumFunding.sinceOpen) from a full clearinghouseState position", () => {
    // Representative `clearinghouseState.assetPositions[].position` payload,
    // including the extra fields the SDK returns (positionValue, maxLeverage,
    // returnOnEquity, isolated leverage rawUsd) that the mapper ignores. This
    // asserts the liq-price + funding plumbing survives the real response shape.
    const row = mapPositionRow(
      {
        coin: "SOL",
        szi: "12.34",
        leverage: { type: "isolated", value: 20, rawUsd: "1500" },
        entryPx: "150.5",
        positionValue: "1857.34",
        unrealizedPnl: "34.21",
        returnOnEquity: "0.45",
        liquidationPx: "128.77",
        marginUsed: "92.86",
        maxLeverage: 20,
        cumFunding: {
          allTime: "5.5",
          sinceOpen: "-0.004321",
          sinceChange: "-0.001",
        },
      } as Parameters<typeof mapPositionRow>[0],
      { SOL: "160.25" },
    );
    // Liquidation price passes through verbatim (presence + plumbing only; the
    // VALUE's correctness is owned elsewhere).
    expect(row.liquidationPx).toBe("128.77");
    // Funding shown is the position's funding since open (sinceOpen), NOT
    // allTime or sinceChange.
    expect(row.funding).toBe("-0.004321");
    expect(row.entryPx).toBe("150.5");
    expect(row.markPx).toBe("160.25");
    expect(row.returnOnEquity).toBe("0.45");
  });

  it("keeps liquidationPx null when the venue reports no liquidation price", () => {
    const row = mapPositionRow(
      {
        coin: "DOGE",
        szi: "1000",
        leverage: { type: "cross", value: 3 },
        entryPx: "0.1234",
        liquidationPx: null,
        unrealizedPnl: "1.2",
        marginUsed: "41.13",
        cumFunding: { allTime: "0.01", sinceOpen: "0.0009", sinceChange: "0" },
      },
      { DOGE: "0.13" },
    );
    // Genuinely-absent liq price stays null so the UI can render a dash.
    expect(row.liquidationPx).toBeNull();
    // A tiny sub-cent funding is preserved verbatim (not rounded/truncated in
    // the mapper); the panel widens display precision so it still renders.
    expect(row.funding).toBe("0.0009");
  });
});

describe("buildPerpAssetSnapshot", () => {
  const ctx = {
    markPx: "109234.5",
    midPx: "109234.0",
    oraclePx: "109230.0",
    prevDayPx: "100000.0",
    funding: "0.0000125",
    dayNtlVlm: "1234567.89",
    openInterest: "1234.5",
  };
  const book = {
    levels: [
      // bids: best (highest) first
      [{ px: "109233.0" }, { px: "109232.0" }],
      // asks: best (lowest) first
      [{ px: "109236.0" }, { px: "109237.0" }],
    ] as [Array<{ px: string }>, Array<{ px: string }>],
  };

  it("maps the ctx fields and extracts top-of-book bid/ask", () => {
    const snap = buildPerpAssetSnapshot("BTC", ctx, book);
    expect(snap).toEqual({
      coin: "BTC",
      szDecimals: 4,
      maxLeverage: 1,
      isolatedOnly: false,
      markPx: "109234.5",
      midPx: "109234.0",
      oraclePx: "109230.0",
      prevDayPx: "100000.0",
      funding: "0.0000125",
      dayNtlVlm: "1234567.89",
      openInterest: "1234.5",
      bid: "109233.0",
      ask: "109236.0",
    });
  });

  it("degrades to null bid/ask when the book is null or has empty sides", () => {
    expect(buildPerpAssetSnapshot("BTC", ctx, null).bid).toBeNull();
    expect(buildPerpAssetSnapshot("BTC", ctx, null).ask).toBeNull();
    const emptyBook = {
      levels: [[], []] as [Array<{ px: string }>, Array<{ px: string }>],
    };
    expect(buildPerpAssetSnapshot("BTC", ctx, emptyBook).bid).toBeNull();
    expect(buildPerpAssetSnapshot("BTC", ctx, emptyBook).ask).toBeNull();
  });

  it("degrades to null price fields when the ctx is absent", () => {
    const snap = buildPerpAssetSnapshot("kPEPE", null, book);
    expect(snap.coin).toBe("kPEPE");
    expect(snap.markPx).toBeNull();
    expect(snap.prevDayPx).toBeNull();
    expect(snap.oraclePx).toBeNull();
    expect(snap.funding).toBeNull();
    expect(snap.openInterest).toBeNull();
    // The book is still read even without a ctx.
    expect(snap.bid).toBe("109233.0");
    expect(snap.ask).toBe("109236.0");
  });
});

describe("buildPerpL2Book", () => {
  const level = (px: string, sz: string, n: number) => ({ px, sz, n });
  const book = (bidCount: number, askCount: number) => ({
    time: 1_700_000_000_000,
    levels: [
      Array.from({ length: bidCount }, (_unused, i) =>
        level(String(100 - i), String(i + 1), i + 1),
      ),
      Array.from({ length: askCount }, (_unused, i) =>
        level(String(101 + i), String(i + 1), i + 1),
      ),
    ] as [
      Array<{ px: string; sz?: string; n?: number }>,
      Array<{ px: string; sz?: string; n?: number }>,
    ],
  });

  it("keeps both sides best-first and carries size + order count", () => {
    const result = buildPerpL2Book("BTC", book(2, 2), 5);
    expect(result.coin).toBe("BTC");
    expect(result.time).toBe(1_700_000_000_000);
    expect(result.bids).toEqual([
      { px: "100", sz: "1", n: 1 },
      { px: "99", sz: "2", n: 2 },
    ]);
    expect(result.asks).toEqual([
      { px: "101", sz: "1", n: 1 },
      { px: "102", sz: "2", n: 2 },
    ]);
  });

  it("truncates each side to the requested depth", () => {
    const result = buildPerpL2Book("BTC", book(9, 9), 3);
    expect(result.bids).toHaveLength(3);
    expect(result.asks).toHaveLength(3);
    expect(result.bids[0]?.px).toBe("100");
    expect(result.asks[0]?.px).toBe("101");
  });

  it("clamps a nonsense depth into the supported range", () => {
    expect(buildPerpL2Book("BTC", book(30, 30), 0).bids).toHaveLength(
      PERP_L2_BOOK_DEFAULT_DEPTH,
    );
    expect(buildPerpL2Book("BTC", book(30, 30), -4).bids).toHaveLength(
      PERP_L2_BOOK_DEFAULT_DEPTH,
    );
    expect(buildPerpL2Book("BTC", book(30, 30), 999).asks).toHaveLength(
      PERP_L2_BOOK_MAX_DEPTH,
    );
    expect(buildPerpL2Book("BTC", book(30, 30), Number.NaN).asks).toHaveLength(
      PERP_L2_BOOK_DEFAULT_DEPTH,
    );
  });

  it("degrades to an empty book rather than throwing", () => {
    const missing = buildPerpL2Book("kPEPE", null);
    expect(missing).toEqual({ coin: "kPEPE", time: null, bids: [], asks: [] });
    const empty = buildPerpL2Book("kPEPE", {
      levels: [[], []] as [
        Array<{ px: string; sz?: string; n?: number }>,
        Array<{ px: string; sz?: string; n?: number }>,
      ],
    });
    expect(empty.bids).toEqual([]);
    expect(empty.asks).toEqual([]);
    expect(empty.time).toBeNull();
  });

  it("defaults missing size / order-count fields instead of emitting undefined", () => {
    const result = buildPerpL2Book("BTC", {
      levels: [[{ px: "100" }], [{ px: "101" }]] as [
        Array<{ px: string; sz?: string; n?: number }>,
        Array<{ px: string; sz?: string; n?: number }>,
      ],
    });
    expect(result.bids[0]).toEqual({ px: "100", sz: "0", n: 0 });
    expect(result.asks[0]).toEqual({ px: "101", sz: "0", n: 0 });
  });
});

describe("buildPerpMarketStats", () => {
  const ctx = (over: Partial<Record<string, string | null>> = {}) => ({
    markPx: "100",
    midPx: "100",
    oraclePx: "100",
    prevDayPx: "90",
    funding: "0",
    dayNtlVlm: "1000",
    openInterest: "10",
    ...over,
  });

  it("joins universe with its parallel ctx by index and keeps coin + maxLeverage", () => {
    const universe = [
      { name: "BTC", maxLeverage: 40 },
      { name: "kPEPE", maxLeverage: 10 },
    ];
    const ctxs = [
      ctx({
        markPx: "64000",
        prevDayPx: "63000",
        dayNtlVlm: "2000000000",
        openInterest: "12000",
        funding: "0.0000125",
      }),
      ctx({
        markPx: "0.008",
        prevDayPx: "0.0075",
        dayNtlVlm: "500000",
        openInterest: "90000000",
        funding: "-0.0000342",
      }),
    ];
    const stats = buildPerpMarketStats(universe, ctxs);
    expect(stats).toEqual([
      {
        coin: "BTC",
        maxLeverage: 40,
        markPx: "64000",
        prevDayPx: "63000",
        dayNtlVlm: "2000000000",
        openInterest: "12000",
        funding: "0.0000125",
      },
      {
        coin: "kPEPE",
        maxLeverage: 10,
        markPx: "0.008",
        prevDayPx: "0.0075",
        dayNtlVlm: "500000",
        openInterest: "90000000",
        // A negative (shorts pay longs) rate survives verbatim; the client
        // widens display precision rather than rounding it to zero.
        funding: "-0.0000342",
      },
    ]);
  });

  it("drops delisted assets but preserves the ctx index for the survivors", () => {
    const universe = [
      { name: "BTC", maxLeverage: 40 },
      { name: "OLD", maxLeverage: 5, isDelisted: true },
      { name: "SOL", maxLeverage: 20 },
    ];
    const ctxs = [
      ctx({ markPx: "64000" }),
      ctx({ markPx: "1" }),
      ctx({ markPx: "150" }),
    ];
    const stats = buildPerpMarketStats(universe, ctxs);
    expect(stats.map((s) => s.coin)).toEqual(["BTC", "SOL"]);
    // SOL must read index 2's ctx, not index 1's (the delisted row).
    expect(stats[1]?.markPx).toBe("150");
  });

  it("degrades a coin with a missing ctx to null prices rather than dropping it", () => {
    const universe = [{ name: "NEW", maxLeverage: 3 }];
    const stats = buildPerpMarketStats(universe, [null]);
    expect(stats).toEqual([
      {
        coin: "NEW",
        maxLeverage: 3,
        markPx: null,
        prevDayPx: null,
        dayNtlVlm: null,
        openInterest: null,
        funding: null,
      },
    ]);
  });

  it("carries the ctx funding rate through instead of dropping it", () => {
    // Regression: the market list needs funding per row, and the ctx already
    // carries it, so the builder must not discard it and force the UI into a
    // per-coin `assetSnapshot` fan-out just to read a rate.
    const stats = buildPerpMarketStats(
      [{ name: "BTC", maxLeverage: 40 }, { name: "SOL", maxLeverage: 20 }],
      [ctx({ funding: "0.0000125" }), ctx({ funding: null })],
    );
    expect(stats.map((stat) => stat.funding)).toEqual(["0.0000125", null]);
  });
});

describe("HyperliquidClient.perpCollateral", () => {
  /**
   * The numbers below are the ones measured on a live mainnet unified account
   * during the audit that found this bug. The old read computed
   * `perp accountValue - perp totalMarginUsed` and returned a NEGATIVE figure
   * on an account with two million dollars of real free collateral, because
   * those two terms come from different ledgers once the account is unified.
   *
   * The spot `hold` matched the perp `totalMarginUsed` to the cent on that
   * account, which is the whole reason `total - hold` is sufficient and no
   * per-dex margin summing is needed.
   */
  const MAINNET = {
    spotTotal: "6504121.0",
    spotHold: "4493691.0",
    perpAccountValue: "3346860.0",
    perpTotalMarginUsed: "4493691.0",
  };

  it("reads free collateral from spot under unifiedAccount, not the perp summary", async () => {
    const { client } = clientWithStub([BTC]);
    let perpStateReads = 0;
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "unifiedAccount";
      },
      async spotClearinghouseState() {
        return {
          balances: [
            {
              coin: "USDC",
              token: 0,
              total: MAINNET.spotTotal,
              hold: MAINNET.spotHold,
              entryNtl: "0",
            },
          ],
        };
      },
      async clearinghouseState() {
        perpStateReads += 1;
        return {
          crossMarginSummary: {
            accountValue: MAINNET.perpAccountValue,
            totalMarginUsed: MAINNET.perpTotalMarginUsed,
          },
          marginSummary: { accountValue: MAINNET.perpAccountValue },
          assetPositions: [],
        };
      },
    };

    const collateral = await client.perpCollateral(
      "0xdef0000000000000000000000000000000000abc",
    );

    expect(collateral).not.toBeNull();
    // 6,504,121 - 4,493,691 = 2,010,430. The old read produced -1,146,831.
    expect(Number(collateral?.freeUsd)).toBeCloseTo(2010430, 0);
    expect(Number(collateral?.freeUsd)).toBeGreaterThan(0);
    expect(collateral?.source).toBe("spot-unified");
    // The perp ledger must not be consulted at all in this mode.
    expect(perpStateReads).toBe(0);
  });

  it("returns null rather than a figure when the spot hold is missing", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "unifiedAccount";
      },
      async spotClearinghouseState() {
        return {
          balances: [{ coin: "USDC", token: 0, total: "1000", entryNtl: "0" }],
        };
      },
    };

    // Absent hold is NOT zero. Reading it as zero would report every committed
    // dollar as free and size an order against margin already posted.
    expect(
      await client.perpCollateral("0xdef0000000000000000000000000000000000abc"),
    ).toBeNull();
  });

  it("keeps the perp cross-margin read for default abstraction", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "default";
      },
      async clearinghouseState() {
        // The two summaries are stubbed at DIFFERENT values on purpose. They
        // were previously both 1000, which made it impossible for this test to
        // tell which one each field was read from, and that blind spot is what
        // let the pct_equity base read the cross-only figure unnoticed.
        // marginSummary is the larger one because it includes the equity locked
        // in isolated positions that crossMarginSummary leaves out.
        return {
          crossMarginSummary: { accountValue: "1000", totalMarginUsed: "250" },
          marginSummary: { accountValue: "1750" },
          assetPositions: [],
        };
      },
    };

    const collateral = await client.perpCollateral(
      "0xdef0000000000000000000000000000000000abc",
    );

    // Free collateral nets committed margin out of the CROSS pool, which is
    // what a cross-margin order actually draws on.
    expect(Number(collateral?.freeUsd)).toBe(750);
    // The pct_equity base is total account value, isolated equity included, so
    // opening an isolated position does not shrink the next mirror.
    expect(Number(collateral?.accountValueUsd)).toBe(1750);
    expect(collateral?.source).toBe("perp-cross-margin");
  });

  it("returns null when marginSummary is unreadable, rather than guessing the equity base", async () => {
    const { client } = clientWithStub([BTC]);
    (client as unknown as { info: unknown }).info = {
      async userAbstraction() {
        return "default";
      },
      async clearinghouseState() {
        return {
          crossMarginSummary: { accountValue: "1000", totalMarginUsed: "250" },
          marginSummary: { accountValue: "not-a-number" },
          assetPositions: [],
        };
      },
    };

    // Falling back to the cross figure here would silently reintroduce the bug
    // for exactly the accounts whose data is least trustworthy.
    expect(
      await client.perpCollateral("0xdef0000000000000000000000000000000000abc"),
    ).toBeNull();
  });
});
