import { describe, it, expect } from "bun:test";
import { AlpacaClient } from "./client.js";

/**
 * Builds an AlpacaClient with its underlying SDK swapped for a stub whose
 * getBarsV2 records the options it was called with and yields the supplied bars.
 */
function clientWithStubBars(bars: Array<{ t: string; c: number }>) {
  const client = new AlpacaClient({ keyId: "k", secretKey: "s", paper: true });
  const calls: any[] = [];
  // `alpaca` is a private `any` field — override it with a stub for the test.
  (client as any).alpaca = {
    async *getBarsV2(_symbol: string, options: any) {
      calls.push(options);
      for (const bar of bars) yield bar;
    },
  };
  return { client, calls };
}

describe("AlpacaClient.getBars", () => {
  it("requests the most recent bars (sort desc) so the limit is anchored to now, not the window start", async () => {
    const { client, calls } = clientWithStubBars([]);
    await client.getBars("AAPL", "1Min", 300);
    expect(calls[0].sort).toBe("desc");
    expect(calls[0].limit).toBe(300);
  });

  it("returns bars in ascending chronological order regardless of API sort", async () => {
    // Alpaca yields newest-first when sort=desc; getBars must reverse to ascending.
    const { client } = clientWithStubBars([
      { t: "2026-06-09T15:00:00Z", c: 3 },
      { t: "2026-06-09T14:59:00Z", c: 2 },
      { t: "2026-06-09T14:58:00Z", c: 1 },
    ]);
    const out = await client.getBars("AAPL", "1Min", 300);
    const times = out.map((b: any) => new Date(b.t).getTime());
    const ascending = [...times].sort((a, b) => a - b);
    expect(times).toEqual(ascending);
  });

  it("propagates an abort signal and deterministic as-of through the bounded bars request", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ bars: [{ t: "2026-08-20T23:59:59Z", c: 100 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const asOf = new Date("2026-08-21T12:00:00.000Z");
      const client = new AlpacaClient({ keyId: "k", secretKey: "s", paper: true });
      const out = await client.getBars("AAPL", "1D", 300, {
        asOf,
        signal: controller.signal,
      });

      expect(requestedSignal).toBe(controller.signal);
      expect(requestedUrl).toContain("end=2026-08-21T12%3A00%3A00.000Z");
      expect(out).toEqual([{ t: "2026-08-20T23:59:59Z", c: 100 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AlpacaClient market intelligence endpoints", () => {
  it("requests stock movers and most-actives from Alpaca's screener API", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ gainers: [], losers: [], most_actives: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new AlpacaClient({ keyId: "k", secretKey: "s", paper: true });
    await client.getStockMovers(12);
    await client.getMostActiveStocks(18);

    expect(urls[0]).toContain("/v1beta1/screener/stocks/movers?top=12");
    expect(urls[1]).toContain("/v1beta1/screener/stocks/most-actives?by=volume&top=18");
    globalThis.fetch = originalFetch;
  });

  it("batches snapshots and requests recent sourced news", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ snapshots: {}, news: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new AlpacaClient({ keyId: "k", secretKey: "s", paper: true });
    await client.getStockSnapshots(["AAPL", "NVDA"]);
    await client.getMarketNews(15);

    expect(urls[0]).toContain("/v2/stocks/snapshots?");
    expect(urls[0]).toContain("symbols=AAPL%2CNVDA");
    expect(urls[0]).toContain("feed=iex");
    expect(urls[1]).toContain("/v1beta1/news?");
    expect(urls[1]).toContain("limit=15");
    expect(urls[1]).toContain("exclude_contentless=true");
    globalThis.fetch = originalFetch;
  });
});

describe("AlpacaClient.getLatestOptionQuote", () => {
  it("lets Alpaca pick the entitled feed on a live client, forcing neither opra nor indicative", async () => {
    // docs.alpaca.markets/us/reference/optionlatestquotes: the `feed` param
    // defaults to `opra` when the account is subscribed and `indicative`
    // otherwise. Omitting it is therefore strictly better than naming either.
    //
    // This assertion USED to require `feed=opra` on a live client. That was
    // half right and half wrong, and the wrong half is a real failure:
    //
    //  - Right: never hardcode `indicative` for a live account. copy-mirror
    //    prices a mirrored option SELL's actual limit_price off this quote's
    //    bid (alpaca-16), so a delayed indicative bid moved real money on a
    //    number that need not match the live OPRA NBBO. That is still pinned,
    //    by the `not.toContain("feed=indicative")` below.
    //
    //  - Wrong: a live TRADING account does not imply an OPRA MARKET-DATA
    //    subscription, and `config.ts` defaults `paper: false`, so a client
    //    built without an explicit flag lands here too. Forcing `opra` on an
    //    unsubscribed account returns an entitlement error, so option quotes
    //    and copy-mirror option pricing fail outright where the older
    //    indicative request at least returned a price.
    //
    // Omitting the parameter satisfies both: subscribed accounts still get
    // OPRA, unsubscribed ones degrade to indicative instead of erroring.
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ quotes: { AAPL240119C00150000: { bp: 3.4, ap: 3.6 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const liveClient = new AlpacaClient({ keyId: "k", secretKey: "s", paper: false });
    await liveClient.getLatestOptionQuote("AAPL240119C00150000");

    expect(urls[0]).toContain("/v1beta1/options/quotes/latest?");
    // The alpaca-16 guarantee, unchanged: a live account is never silently
    // pinned to the delayed indicative feed.
    expect(urls[0]).not.toContain("feed=indicative");
    // And no feed is forced at all, so an unsubscribed live account gets
    // Alpaca's own fallback rather than an entitlement error.
    expect(urls[0]).not.toContain("feed=");
    globalThis.fetch = originalFetch;
  });

  it("still requests the free indicative feed on a paper client", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ quotes: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const paperClient = new AlpacaClient({ keyId: "k", secretKey: "s", paper: true });
    await paperClient.getLatestOptionQuote("AAPL240119C00150000");

    expect(urls[0]).toContain("feed=indicative");
    globalThis.fetch = originalFetch;
  });
});

function clientWithStubOrders(stub: Record<string, unknown>) {
  const client = new AlpacaClient({ keyId: "k", secretKey: "s", paper: true });
  (client as any).alpaca = stub;
  return client;
}

const acceptedOrder = {
  id: "order-1",
  client_order_id: "ord-timeout",
  status: "accepted",
};

describe("AlpacaClient idempotent order creation", () => {
  it("derives deterministic leg IDs without exceeding Alpaca's 48-character limit", async () => {
    const alpaca = (await import("./index.js")) as Record<string, unknown>;
    expect(typeof alpaca.deriveClientOrderId).toBe("function");

    const deriveClientOrderId = alpaca.deriveClientOrderId as (
      base: string,
      suffix: string,
    ) => string;
    const base = "ord_12345678-1234-1234-1234-123456789012";
    const first = deriveClientOrderId(base, "tp0");
    const second = deriveClientOrderId(base, "tp1");

    expect(first).toBe(deriveClientOrderId(base, "tp0"));
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(48);
  });

  it("hashes truncated leg IDs so distinct long bases cannot collide", async () => {
    const alpaca = (await import("./index.js")) as Record<string, unknown>;
    const deriveClientOrderId = alpaca.deriveClientOrderId as (
      base: string,
      suffix: string,
    ) => string;
    const sharedPrefix = "x".repeat(60);

    const first = deriveClientOrderId(`${sharedPrefix}a`, "tp0");
    const second = deriveClientOrderId(`${sharedPrefix}b`, "tp0");

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(48);
    expect(second.length).toBeLessThanOrEqual(48);
  });

  it("derives opaque tenant-owned broker IDs within Alpaca's limit", async () => {
    const alpaca = (await import("./index.js")) as Record<string, unknown>;
    expect(typeof alpaca.createBrokerClientOrderId).toBe("function");
    const createBrokerClientOrderId = alpaca.createBrokerClientOrderId as (
      ownerId: string,
      logicalId: string,
      namespace?: string,
    ) => string;

    const first = createBrokerClientOrderId("user-a", "same-browser-key");
    const repeat = createBrokerClientOrderId("user-a", "same-browser-key");
    const otherTenant = createBrokerClientOrderId("user-b", "same-browser-key");

    expect(first).toBe(repeat);
    expect(first).not.toBe(otherTenant);
    expect(first.length).toBeLessThanOrEqual(48);
    expect(first).not.toContain("user-a");
    expect(first).not.toContain("same-browser-key");
  });

  it("recovers a timeout-after-acceptance by client order ID without a second POST", async () => {
    const events: string[] = [];
    let createCalls = 0;
    const timeout = Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" });
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        events.push("create");
        throw timeout;
      },
      getOrderByClientId: async (clientOrderId: string) => {
        events.push(`lookup:${clientOrderId}`);
        return acceptedOrder;
      },
    });

    const result = await client.createOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "day",
      client_order_id: "ord-timeout",
    });

    expect(result).toBe(acceptedOrder as any);
    expect(createCalls).toBe(1);
    expect(events).toEqual(["create", "lookup:ord-timeout"]);
  });

  it("only retries an ambiguous create after a 404 client-ID lookup", async () => {
    const events: string[] = [];
    let createCalls = 0;
    const timeout = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const notFound = Object.assign(new Error("not found"), { response: { status: 404 } });
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        events.push(`create:${createCalls}`);
        if (createCalls === 1) throw timeout;
        return acceptedOrder;
      },
      getOrderByClientId: async () => {
        events.push("lookup");
        throw notFound;
      },
    });

    const result = await client.createOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "day",
      client_order_id: "ord-timeout",
    });

    expect(result).toBe(acceptedOrder as any);
    expect(events).toEqual(["create:1", "lookup", "create:2"]);
  });

  it("does not retry a definite broker rejection or query by client ID", async () => {
    let createCalls = 0;
    let lookupCalls = 0;
    const rejection = Object.assign(new Error("unprocessable order"), {
      response: { status: 422 },
    });
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        throw rejection;
      },
      getOrderByClientId: async () => {
        lookupCalls++;
        return acceptedOrder;
      },
    });

    await expect(
      client.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "market",
        time_in_force: "day",
        client_order_id: "ord-rejected",
      }),
    ).rejects.toBe(rejection);
    expect(createCalls).toBe(1);
    expect(lookupCalls).toBe(0);
  });

  it("stops when recovery lookup is inconclusive instead of risking another POST", async () => {
    let createCalls = 0;
    const timeout = Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" });
    const lookupFailure = Object.assign(new Error("lookup timed out"), { code: "ETIMEDOUT" });
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        throw timeout;
      },
      getOrderByClientId: async () => {
        throw lookupFailure;
      },
    });

    const error = await client.createOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "day",
      client_order_id: "ord-unknown",
    }).catch((caught) => caught);

    expect(error).not.toBe(lookupFailure);
    expect(error).toMatchObject({
      code: "ALPACA_AMBIGUOUS_ORDER",
      operation: "create_order",
      clientOrderId: "ord-unknown",
      cause: lookupFailure,
    });
    expect(createCalls).toBe(1);
  });

  it("retries a transient failure on the recovery lookup itself instead of giving up immediately (alpaca-01)", async () => {
    // The failure this reproduces: POST /v2/orders 429s, and the very NEXT
    // request on the same rate-limited account (the recovery lookup) 429s
    // too. Before this fix the lookup was a raw, unretried SDK call, so that
    // second 429 alone was enough to declare the create outcome permanently
    // ambiguous even though a broker order may never have existed.
    const events: string[] = [];
    let createCalls = 0;
    let lookupCalls = 0;
    const rateLimited = Object.assign(new Error("too many requests"), {
      response: { status: 429 },
    });
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        events.push("create");
        throw rateLimited;
      },
      getOrderByClientId: async (clientOrderId: string) => {
        lookupCalls++;
        events.push(`lookup:${lookupCalls}`);
        if (lookupCalls === 1) throw rateLimited;
        return acceptedOrder;
      },
    });

    const result = await client.createOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "day",
      client_order_id: "ord-lookup-429",
    });

    expect(result).toBe(acceptedOrder as any);
    // The outer retry (which would re-POST) must never fire: the SAME
    // deterministic client_order_id is still in flight, and a second create
    // attempt is only safe as a last resort, not the first response to a
    // rate limit on the read side.
    expect(createCalls).toBe(1);
    expect(lookupCalls).toBe(2);
    expect(events).toEqual(["create", "lookup:1", "lookup:2"]);
  });

  it("recovers an already-submitted duplicate client ID with the real SDK lookup method", async () => {
    const events: string[] = [];
    const duplicate = Object.assign(new Error("client_order_id must be unique"), {
      response: { status: 422, data: { message: "client_order_id must be unique" } },
    });
    const client = clientWithStubOrders({
      createOrder: async () => {
        events.push("create");
        throw duplicate;
      },
      getOrderByClientId: async (clientOrderId: string) => {
        events.push(`lookup:${clientOrderId}`);
        return acceptedOrder;
      },
    });

    const result = await client.createOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "day",
      client_order_id: "ord-timeout",
    });

    expect(result).toBe(acceptedOrder as any);
    expect(events).toEqual(["create", "lookup:ord-timeout"]);
  });

  it("rejects overlong broker IDs before calling the SDK", async () => {
    let createCalls = 0;
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        return acceptedOrder;
      },
    });

    await expect(
      client.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "market",
        time_in_force: "day",
        client_order_id: "x".repeat(49),
      }),
    ).rejects.toThrow("48");
    expect(createCalls).toBe(0);
  });

  it("forwards client IDs through bracket, OCO, and trailing-stop wrappers", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = clientWithStubOrders({
      createOrder: async (request: Record<string, unknown>) => {
        requests.push(request);
        return acceptedOrder;
      },
    });

    await client.createBracketOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "gtc",
      order_class: "bracket",
      take_profit: { limit_price: 210 },
      stop_loss: { stop_price: 190 },
      client_order_id: "ord-bracket",
    });
    await client.createOCOOrder({
      symbol: "AAPL",
      qty: 1,
      side: "sell",
      type: "limit",
      time_in_force: "gtc",
      order_class: "oco",
      take_profit: { limit_price: 210 },
      stop_loss: { stop_price: 190 },
      client_order_id: "ord-oco",
    });
    await client.createTrailingStopOrder({
      symbol: "AAPL",
      qty: 1,
      side: "sell",
      type: "trailing_stop",
      time_in_force: "gtc",
      trail_percent: 2,
      client_order_id: "ord-trailing",
    });

    expect(requests.map((request) => request.client_order_id)).toEqual([
      "ord-bracket",
      "ord-oco",
      "ord-trailing",
    ]);
  });
});

describe("AlpacaClient position close safety", () => {
  it("does not repeat an ambiguous single-position DELETE and reconciles with safe reads", async () => {
    const events: string[] = [];
    const timeout = Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" });
    const client = clientWithStubOrders({
      closePosition: async (symbol: string) => {
        events.push(`close:${symbol}`);
        throw timeout;
      },
      getPosition: async (symbol: string) => {
        events.push(`position:${symbol}`);
        return { symbol, qty: "5" };
      },
      getOrders: async () => {
        events.push("orders");
        return [];
      },
    });

    const error = await client.closePosition("AAPL").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "ALPACA_AMBIGUOUS_ORDER",
      operation: "close_position",
      cause: timeout,
    });
    expect(events).toEqual(["close:AAPL", "position:AAPL", "orders"]);
  });

  it("does not repeat an ambiguous close-all DELETE and reconciles positions and orders", async () => {
    const events: string[] = [];
    const timeout = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const client = clientWithStubOrders({
      // closeAllPositions now calls sendRequest directly (alpaca-07) rather
      // than the SDK's argument-dropping closeAllPositions() wrapper.
      sendRequest: async () => {
        events.push("close-all");
        throw timeout;
      },
      getPositions: async () => {
        events.push("positions");
        return [];
      },
      getOrders: async () => {
        events.push("orders");
        return [];
      },
    });

    const error = await client.closeAllPositions(true).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "ALPACA_AMBIGUOUS_ORDER",
      operation: "close_all_positions",
      cause: timeout,
    });
    expect(events).toEqual(["close-all", "positions", "orders"]);
  });

  it("does not tag or reconcile a definite close rejection", async () => {
    let reads = 0;
    let closeCalls = 0;
    const forbidden = Object.assign(new Error("forbidden"), { response: { status: 403 } });
    const client = clientWithStubOrders({
      closePosition: async () => {
        closeCalls++;
        throw forbidden;
      },
      getPosition: async () => {
        reads++;
      },
      getOrders: async () => {
        reads++;
      },
    });

    await expect(client.closePosition("AAPL")).rejects.toBe(forbidden);
    expect(closeCalls).toBe(1);
    expect(reads).toBe(0);
  });
});

describe("AlpacaClient.closeAllPositions transmits cancel_orders (alpaca-07)", () => {
  /**
   * The installed SDK (@alpacahq/alpaca-trade-api 3.1.3) binds
   * `alpaca.closeAllPositions` directly to the vendor's closeAll():
   *   function closeAll() { return this.sendRequest("/positions", null, null, "DELETE"); }
   * It takes zero parameters and hard-codes queryParams to null, so whatever
   * AlpacaClient passes to `this.alpaca.closeAllPositions(cancelOrders)` is
   * discarded before it reaches the query string. This stub reproduces that
   * real, documented shape (not a repo-source regex) so a test against it
   * fails the same way the live SDK does: cancel_orders never reaches the
   * wire unless the caller talks to sendRequest directly.
   */
  function stubSdkWithRealCloseAllShape() {
    const captured: Array<{ endpoint: string; queryParams: unknown; body: unknown; method: string }> = [];
    return {
      captured,
      stub: {
        closeAllPositions(this: any, _ignoredCancelOrders?: boolean) {
          return this.sendRequest("/positions", null, null, "DELETE");
        },
        sendRequest: async (endpoint: string, queryParams: unknown, body: unknown, method: string) => {
          captured.push({ endpoint, queryParams, body, method });
          return [];
        },
      },
    };
  }

  it("reaches Alpaca with cancel_orders=true in the query params instead of being silently dropped", async () => {
    const { captured, stub } = stubSdkWithRealCloseAllShape();
    const client = clientWithStubOrders(stub);

    await client.closeAllPositions(true);

    expect(captured).toHaveLength(1);
    expect(captured[0].endpoint).toBe("/positions");
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].queryParams).toMatchObject({ cancel_orders: true });
  });

  it("reaches Alpaca with cancel_orders=false when the caller opts out", async () => {
    const { captured, stub } = stubSdkWithRealCloseAllShape();
    const client = clientWithStubOrders(stub);

    await client.closeAllPositions(false);

    expect(captured[0].queryParams).toMatchObject({ cancel_orders: false });
  });
});

describe("AlpacaClient recovery error tagging", () => {
  it("does not let a recovery-lookup 403 trigger the stop-order GTC-to-DAY fallback", async () => {
    let createCalls = 0;
    const timeout = Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" });
    const lookupForbidden = Object.assign(new Error("lookup forbidden"), {
      response: { status: 403 },
    });
    const client = clientWithStubOrders({
      createOrder: async () => {
        createCalls++;
        throw timeout;
      },
      getOrderByClientId: async () => {
        throw lookupForbidden;
      },
    });

    const error = await client.createExitStrategy({
      client_order_id: "ord-exit",
      symbol: "AAPL",
      takeProfits: [],
      stopLoss: { stopPrice: 190, qty: 1 },
    }).catch((caught) => caught);

    expect(createCalls).toBe(1);
    expect(error).toMatchObject({
      code: "ALPACA_AMBIGUOUS_ORDER",
      operation: "create_order",
    });
  });
});
