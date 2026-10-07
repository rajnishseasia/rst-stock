import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createDiscordNotificationSender,
  formatOrderLine,
  sendDiscordMirrorSummary,
  sendDiscordNotification,
} from "../discord-notify";

/**
 * Regression tests for the limit-fill silent-miss bug: an in-app limit order is
 * persisted directly as SUBMITTED, so OrderSyncPoller never observes a
 * transition INTO SUBMITTED and the intended submit ping never fires; when the
 * order later fills, the previous suppression rule dropped the FILLED webhook
 * on the theory that the submit ping had already gone out. The fix in
 * discord-notify.ts (see docs/tasks/COPY-TRADE-EXTERNAL-FILLS-SCOPE.md §1.6)
 * allows FILLED through for limit types while still consolidating PARTIALs.
 *
 * We exercise `sendDiscordNotification` end-to-end by stubbing global.fetch and
 * counting the requests it makes. That way we're asserting the OBSERVABLE
 * behavior (was a webhook sent?) rather than re-parsing the private
 * `shouldSuppress` predicate.
 */

interface FetchCall {
  url: string;
  body: unknown;
}

let fetchCalls: FetchCall[];
let originalFetch: typeof fetch;
let originalWebhook: string | undefined;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  originalWebhook = process.env.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = "https://discord.example/hook";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: typeof input === "string" ? input : input.toString(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
});

describe("sendDiscordNotification — limit-fill suppression fix", () => {
  it("does not echo an auto-mirrored fill once per follower", async () => {
    await sendDiscordNotification({
      symbol: "DOGE",
      side: "Buy",
      quantity: 100,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 0.0945,
      orderId: "follower-order-1",
      assetType: "PERP",
      orderType: "Limit",
      copySourceLabel: "SOL Decoder",
    });

    expect(fetchCalls).toHaveLength(0);
  });

  it("loads linked-X identity through the worker database sender", async () => {
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => [
                {
                  name: "Old account name",
                  twitterName: "SOL Decoder",
                  username: "SOL_Decoder",
                  image: "https://example.com/sol-decoder.jpg",
                  twitterAccountId: "twitter-account-1",
                },
              ],
            }),
          }),
        }),
      }),
    } as never;
    const notify = createDiscordNotificationSender(db);

    await notify({
      symbol: "PUMP",
      side: "Buy",
      quantity: 5377,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 0.004652,
      orderId: "o-worker-identity",
      assetType: "PERP",
      orderType: "Market",
      userId: "user-1",
    });

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as { content: string; avatar_url?: string };
    expect(body.content).toContain("from SOL Decoder");
    expect(body.avatar_url).toBe("https://example.com/sol-decoder.jpg");
  });

  it("uses the current linked-X identity even when a stale pseudonym was supplied", async () => {
    await sendDiscordNotification(
      {
        symbol: "PUMP",
        side: "Buy",
        quantity: 4322,
        status: "FILLED",
        previousStatus: "SUBMITTED",
        executedPrice: 0.004629,
        orderId: "o-identity",
        assetType: "PERP",
        orderType: "Market",
        userId: "user-1",
        traderName: "StoicHeron724",
      },
      {
        loadTraderProfile: async () => ({
          twitterLinked: true,
          name: "Old account name",
          twitterName: "SOL Decoder",
          username: "SOL_Decoder",
          image: "https://example.com/sol-decoder.jpg",
        }),
      },
    );

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as { content: string; avatar_url?: string };
    expect(body.content).toContain("from SOL Decoder");
    expect(body.content).not.toContain("StoicHeron724");
    expect(body.avatar_url).toBe("https://example.com/sol-decoder.jpg");
  });

  it("emits a FILLED webhook for a Limit order (bug: previously suppressed)", async () => {
    await sendDiscordNotification({
      symbol: "LIN",
      side: "sell",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 552.73,
      orderId: "o-1",
      assetType: "EQUITY",
      orderType: "Limit",
      limitPrice: 552.73,
    });
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as { content: string };
    expect(body.content).toContain("Sell");
    expect(body.content).toContain("LIN");
    expect(body.content).toContain("$552.73");
    expect(body.content).toContain("(limit)");
  });

  it("emits a FILLED webhook for a StopLimit order", async () => {
    await sendDiscordNotification({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 189.5,
      orderId: "o-2",
      assetType: "EQUITY",
      orderType: "StopLimit",
      limitPrice: 190,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("suppresses PARTIAL for a TakeProfitLimit order, like any other limit type", async () => {
    // It was listed in ORDER_TYPE_SHORT but not in isLimitType, so it fell into
    // the "unknown, let it through" branch and notified on every transition,
    // against this file's one-webhook-per-order rule.
    await sendDiscordNotification({
      symbol: "BTC",
      side: "sell",
      quantity: 1,
      status: "PARTIAL",
      previousStatus: "SUBMITTED",
      orderId: "o-tpl",
      assetType: "PERP",
      orderType: "TakeProfitLimit",
      limitPrice: 70000,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("shows the resting limit price on a submitted TakeProfitLimit", async () => {
    // priceToShow only reads limitPrice for limit types, so the price was
    // silently omitted even though it is known at SUBMITTED.
    await sendDiscordNotification({
      symbol: "BTC",
      side: "sell",
      quantity: 1,
      status: "SUBMITTED",
      previousStatus: "PENDING",
      orderId: "o-tpl-2",
      assetType: "PERP",
      orderType: "TakeProfitLimit",
      limitPrice: 70000,
    });
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as { content: string };
    expect(body.content).toContain("$70000.00");
    expect(body.content).toContain("(take-profit-limit)");
  });

  it("still suppresses PARTIAL for limit orders (consolidate to one FILLED ping)", async () => {
    await sendDiscordNotification({
      symbol: "LIN",
      side: "sell",
      quantity: 1,
      status: "PARTIAL",
      previousStatus: "SUBMITTED",
      executedPrice: 552.73,
      orderId: "o-3",
      assetType: "EQUITY",
      orderType: "Limit",
      limitPrice: 552.73,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("still emits SUBMITTED for a limit order (in case a transition IS observed)", async () => {
    await sendDiscordNotification({
      symbol: "LIN",
      side: "buy",
      quantity: 1,
      status: "SUBMITTED",
      previousStatus: "PENDING",
      executedPrice: null,
      orderId: "o-4",
      assetType: "EQUITY",
      orderType: "Limit",
      limitPrice: 550,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("keeps market-order behavior: SUBMITTED suppressed, FILLED emitted", async () => {
    await sendDiscordNotification({
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      status: "SUBMITTED",
      previousStatus: "PENDING",
      executedPrice: null,
      orderId: "o-5",
      assetType: "EQUITY",
      orderType: "Market",
      limitPrice: null,
    });
    expect(fetchCalls).toHaveLength(0);

    await sendDiscordNotification({
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 420.5,
      orderId: "o-5",
      assetType: "EQUITY",
      orderType: "Market",
      limitPrice: null,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("always emits terminal non-fill states (CANCELLED / REJECTED / EXPIRED)", async () => {
    for (const status of ["CANCELLED", "REJECTED", "EXPIRED"] as const) {
      fetchCalls = [];
      await sendDiscordNotification({
        symbol: "TSLA",
        side: "buy",
        quantity: 2,
        status,
        previousStatus: "SUBMITTED",
        executedPrice: null,
        orderId: `o-${status}`,
        assetType: "EQUITY",
        orderType: "Limit",
        limitPrice: 250,
      });
      expect(fetchCalls).toHaveLength(1);
    }
  });
});

describe("sendDiscordMirrorSummary", () => {
  it("sends one aggregate confirmation without naming followers", async () => {
    await sendDiscordMirrorSummary({ sourceLabel: "SOL Decoder", mirroredCount: 4 });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.body).toEqual({
      username: "TradeBot",
      content: "🪞 4 people mirrored this trade from SOL Decoder",
    });
  });

  it("does not send an aggregate when nobody mirrored", async () => {
    await sendDiscordMirrorSummary({ sourceLabel: "SOL Decoder", mirroredCount: 0 });
    expect(fetchCalls).toHaveLength(0);
  });

  it("prefers the source's current linked-X name over a stale follow label", async () => {
    await sendDiscordMirrorSummary(
      {
        sourceLabel: "StoicHeron724",
        sourceUserId: "source-user",
        mirroredCount: 6,
      },
      {
        loadTraderProfile: async () => ({
          twitterLinked: true,
          twitterName: "SOL Decoder",
          username: "SOL_Decoder",
        }),
      },
    );

    expect(fetchCalls[0]?.body).toEqual({
      username: "TradeBot",
      content: "🪞 6 people mirrored this trade from SOL Decoder",
    });
  });
});

describe("formatOrderLine", () => {
  it("uses the fill price when present, otherwise the limit price", () => {
    const filled = formatOrderLine({
      symbol: "LIN",
      side: "sell",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 552.73,
      orderId: "o",
      orderType: "Limit",
      limitPrice: 550,
    });
    expect(filled).toContain("$552.73");
    const submitted = formatOrderLine({
      symbol: "LIN",
      side: "sell",
      quantity: 1,
      status: "SUBMITTED",
      previousStatus: "PENDING",
      executedPrice: null,
      orderId: "o",
      orderType: "Limit",
      limitPrice: 550,
    });
    expect(submitted).toContain("$550.00");
  });
});

describe("formatOrderLine — SIDE_WORD and ACTION_EMOJI mapping", () => {
  /**
   * Each entry: [side, expectedWord, expectedEmoji]
   * These are the new per-action tables added in the Discord webhook redesign.
   * The most important case is the "Short" collapse: SellShort and SellToOpen
   * both map to "Short" (not "Sell") so readers can instantly tell it is a new
   * short position rather than a sale of existing shares.
   */
  const cases: [string, string, string][] = [
    ["SellShort",  "Short", "🩳"],
    ["SellToOpen", "Short", "🩳"],
    ["Buy",        "Buy",   "📈"],
    ["BuyToOpen",  "Buy",   "📈"],
    ["BuyToCover", "Close Short", "🔄"],
    ["BuyToClose", "Close", "📉"],
    ["Sell",       "Sell",  "📉"],
    ["SellToClose","Close", "📉"],
  ];

  for (const [side, expectedWord, expectedEmoji] of cases) {
    it(`maps side="${side}" to "${expectedWord}" + "${expectedEmoji}"`, () => {
      const line = formatOrderLine({
        symbol: "SPY",
        side,
        quantity: 1,
        status: "FILLED",
        previousStatus: "SUBMITTED",
        executedPrice: 450,
        orderId: `o-${side}`,
        orderType: "Market",
      });
      expect(line).toContain(expectedWord);
      expect(line).toContain(expectedEmoji);
    });
  }

  it("normalizes a lowercase side before lookup ('sell' resolves to Sell/📉)", () => {
    const line = formatOrderLine({
      symbol: "SPY",
      side: "sell",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 450,
      orderId: "o-lower",
      orderType: "Market",
    });
    expect(line).toContain("Sell");
    expect(line).toContain("📉");
  });

  it("renders a reduce-only perp sell as a close, not an opening short", () => {
    const line = formatOrderLine({
      symbol: "ETH",
      side: "Sell",
      direction: "short",
      reduceOnly: true,
      quantity: 0.0044,
      quantityDecimal: "0.0044",
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 2453.8,
      orderId: "o-long-close",
      assetType: "PERP",
      orderType: "Market",
    });

    expect(line).toContain("📉 Close $10.80 of ETH");
    expect(line).not.toContain("🩳 Short");
  });

  it("renders a reduce-only perp buy as a short close", () => {
    const line = formatOrderLine({
      symbol: "BTC",
      side: "Buy",
      direction: "long",
      reduceOnly: true,
      quantity: 0.00025,
      quantityDecimal: "0.00025",
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 78024,
      orderId: "o-short-close",
      assetType: "PERP",
      orderType: "Market",
    });

    expect(line).toContain("🔄 Close Short $19.51 of BTC");
    expect(line).not.toContain("📈 Buy");
  });

  it("falls back to the normalized side string + generic emoji for an unrecognized side", () => {
    const line = formatOrderLine({
      symbol: "SPY",
      side: "weirdSide",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 450,
      orderId: "o-fallback",
      orderType: "Market",
    });
    // normalizeSide capitalizes first char -> "WeirdSide" (not in SIDE_WORD)
    expect(line).toContain("WeirdSide");
    // ACTION_EMOJI has no entry for it, falls back to "📋"
    expect(line).toContain("📋");
  });

  it("appends a pseudonymized trader name when userId is provided", () => {
    const line = formatOrderLine({
      symbol: "SPY",
      side: "Buy",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 450,
      orderId: "o-trader",
      orderType: "Market",
      userId: "test-user-abc",
    });
    expect(line).toContain("- from ");
    // anonymizeTrader is deterministic: same userId -> same name every run.
    // Verify the name matches the expected Adjective+Noun+Number pattern.
    const match = line.match(/- from ([A-Za-z]+\d+)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeGreaterThan(0);
  });

  it("omits the trader suffix when userId is absent", () => {
    const line = formatOrderLine({
      symbol: "SPY",
      side: "Buy",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 450,
      orderId: "o-no-trader",
      orderType: "Market",
    });
    expect(line).not.toContain("- from ");
  });
});

describe("formatOrderLine — confirmed fill presentation", () => {
  it("keeps a FILLED UNI long open a buy without a status checkmark", () => {
    const line = formatOrderLine({
      symbol: "UNI",
      side: "Buy",
      direction: "long",
      quantity: 25.4,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 3.98,
      orderId: "o-uni-long-open",
      assetType: "PERP",
      orderType: "Market",
    });

    expect(line).toContain("📈 Buy $101.09 of UNI @ $3.98");
    expect(line).not.toContain("Close Short");
    expect(line).not.toContain("✅");
  });

  it("renders an evidenced FILLED UNI short close as Close Short without a status checkmark", () => {
    const line = formatOrderLine({
      symbol: "UNI",
      side: "Buy",
      direction: "short",
      reduceOnly: true,
      quantity: 25.4,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 3.98,
      orderId: "o-uni-short-close",
      assetType: "PERP",
      orderType: "Market",
    });

    expect(line).toContain("🔄 Close Short $101.09 of UNI @ $3.98");
    expect(line).not.toContain("📈 Buy");
    expect(line).not.toContain("✅");
  });

  it("does not use a resting limit as an unconfirmed FILLED execution price", () => {
    const line = formatOrderLine({
      symbol: "UNI",
      side: "Buy",
      quantity: 25.4,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: null,
      limitPrice: 3.98,
      orderId: "o-uni-unpriced-filled",
      assetType: "PERP",
      orderType: "Limit",
    });

    expect(line).toContain("25.4 UNI");
    expect(line).not.toContain("$");
  });

  it("does not use a resting limit as an unconfirmed PARTIAL execution price", () => {
    const line = formatOrderLine({
      symbol: "UNI",
      side: "Buy",
      quantity: 25.4,
      status: "PARTIAL",
      previousStatus: "SUBMITTED",
      executedPrice: null,
      limitPrice: 3.98,
      orderId: "o-uni-unpriced-partial",
      assetType: "PERP",
      orderType: "Limit",
    });

    expect(line).toContain("25.4 UNI");
    expect(line).not.toContain("$");
  });
});

describe("formatOrderLine, assetType OPTION (bug: option fills read as equity fills)", () => {
  // copy-mirror / in-app order placement both store the UNDERLYING in `symbol`
  // and the per-share premium in `limitPrice`/`executedPrice` (the OCC symbol
  // and 100x multiplier never reach this row). Without reading assetType, a
  // 2-contract AAPL call filled at a $3.52 premium rendered identically to
  // "buy 2 shares of AAPL at $3.52": a price ~65x below AAPL's real quote and
  // a notional understated 100x, with no marker that a derivative was traded.
  it("marks an OPTION fill so it cannot be read as an equity fill at that price", () => {
    const line = formatOrderLine({
      symbol: "AAPL",
      side: "Buy",
      quantity: 2,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 3.52,
      orderId: "o-opt",
      assetType: "OPTION",
      orderType: "Limit",
      limitPrice: 3.52,
    });
    expect(line).toContain("AAPL");
    expect(line).toContain("option");
    // The premium must be labeled per-share: OCC option quotes are per share,
    // while the dollar notional above applies the 100-share contract multiplier.
    expect(line).toContain("$3.52/share");
  });

  it("leaves EQUITY fills unaffected by the OPTION marker", () => {
    const line = formatOrderLine({
      symbol: "AAPL",
      side: "Buy",
      quantity: 2,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 189.5,
      orderId: "o-eq",
      assetType: "EQUITY",
      orderType: "Limit",
      limitPrice: 189.5,
    });
    expect(line).not.toContain("option");
    expect(line).not.toContain("/share");
    expect(line).toContain("$189.50");
  });
});

describe("formatOrderLine, sub-$1 price precision (bug: toFixed(2) collapses low perp prices to $0.00)", () => {
  // orders.executed_price is decimal(24,8) specifically because Hyperliquid
  // perp prices can carry many fractional digits; a fixed 2dp format collapses
  // a real, priced fill to "$0.00", which is indistinguishable from a
  // genuinely unpriced order in the one channel that tells followers what the
  // auto-mirror paid.
  it("keeps significant figures for a sub-$1 perp fill instead of rendering $0.00", () => {
    const line = formatOrderLine({
      symbol: "kSHIB",
      side: "Buy",
      quantityDecimal: "12000000",
      quantity: 12000000,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 0.00001234,
      orderId: "o-subcent",
      assetType: "PERP",
      orderType: "Market",
    });
    expect(line).not.toContain("$0.00 ");
    expect(line).not.toContain("$0.00(");
    expect(line.endsWith("$0.00")).toBe(false);
    expect(line).toContain("$0.000012");
  });

  it("does not change formatting for prices >= $1 (no regression on normal fills)", () => {
    const line = formatOrderLine({
      symbol: "BTC",
      side: "Buy",
      quantity: 1,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 70000,
      orderId: "o-btc",
      assetType: "PERP",
      orderType: "Market",
    });
    expect(line).toContain("$70000.00");
  });
});

describe("formatOrderLine, the dollar amount rather than the unit count", () => {
  // "5561.0 ENA" means nothing without knowing ENA's price, and unit counts are
  // not comparable across an equity, an option contract and a perp coin. The
  // channel exists so readers can size someone else's trade against their own
  // account, which is a dollar question.
  it("leads with the dollar size for a perp fill", () => {
    const line = formatOrderLine({
      symbol: "ENA",
      side: "Sell",
      quantity: 0,
      quantityDecimal: "5561.0",
      status: "FILLED",
      previousStatus: "PENDING",
      executedPrice: 0.15251,
      orderId: "o-ena",
      assetType: "PERP",
      orderType: "Market",
      reduceOnly: true,
    });
    expect(line).toContain("$848.11 of ENA");
    expect(line).not.toContain("5561.0 ENA");
  });

  it("applies the 100x contract multiplier so an option is not understated", () => {
    // 2 contracts at a $3.52 premium is $704 spent, not $7.04. This is the same
    // 100x trap the "(option)" marker exists to flag.
    const line = formatOrderLine({
      symbol: "AAPL",
      side: "Buy",
      quantity: 2,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 3.52,
      orderId: "o-opt-usd",
      assetType: "OPTION",
      orderType: "Limit",
      limitPrice: 3.52,
    });
    expect(line).toContain("$704.00 of AAPL");
    expect(line).not.toContain("$7.04");
    // The per-share premium is still shown, and still labeled.
    expect(line).toContain("$3.52/share");
  });

  it("prices an equity fill at the plain share count", () => {
    const line = formatOrderLine({
      symbol: "AAPL",
      side: "Buy",
      quantity: 2,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 189.5,
      orderId: "o-eq-usd",
      assetType: "EQUITY",
      orderType: "Limit",
      limitPrice: 189.5,
    });
    expect(line).toContain("$379.00 of AAPL");
  });

  it("uses the resting limit price for a submit that has not filled", () => {
    const line = formatOrderLine({
      symbol: "LIN",
      side: "Buy",
      quantity: 3,
      status: "SUBMITTED",
      previousStatus: "PENDING",
      executedPrice: null,
      limitPrice: 550,
      orderId: "o-submit-usd",
      assetType: "EQUITY",
      orderType: "Limit",
    });
    expect(line).toContain("$1,650.00 of LIN");
    expect(line).toContain("@ $550.00 (limit)");
  });

  it("falls back to the quantity when there is no price to value it at", () => {
    // A cancelled order that never filled and carries no resting price has no
    // dollar figure to report; showing "$0.00" would be a lie about the size.
    const line = formatOrderLine({
      symbol: "TSLA",
      side: "Sell",
      quantity: 3,
      status: "CANCELLED",
      previousStatus: "SUBMITTED",
      executedPrice: null,
      limitPrice: null,
      orderId: "o-cancel-usd",
      assetType: "EQUITY",
      orderType: "Market",
    });
    expect(line).toContain("3 TSLA");
    expect(line).not.toContain("$");
  });
});
