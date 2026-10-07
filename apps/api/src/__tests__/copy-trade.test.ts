import { describe, expect, it } from "bun:test";
import {
  encodeCursor,
  decodeCursor,
  mergeItems,
  buildPage,
  fullSourceFloorCursor,
  rawUserBatchBoundary,
  collapseUserTradeRows,
  copyTradeItemMatchesAssetClass,
  mapSignalToItem,
  mapUserTradeToItem,
  copyTradeRouter,
  type CopyTradeItem,
  type CursorPoint,
  type FeedCursor,
} from "../routers/copy-trade.js";
import { resolveUniqueAuthoritativeOrder } from "../lib/authoritative-order.js";
import { schema } from "@trade-bot/db";
import { isMirrorableEquitySignal, signalSideFromMetadata } from "@trade-bot/utils";

describe("user trade order join", () => {
  it("resolves only one exact or scoped local order", () => {
    const resolved = resolveUniqueAuthoritativeOrder(
      { userId: "user-1", orderId: null, brokerOrderId: "broker-1" },
      [{
        id: "order-1",
        userId: "user-1",
        brokerOrderId: "broker-1",
        brokerAccountId: "account-1",
        brokerCredentialId: "credential-1",
        venue: "alpaca",
      }],
    );
    expect(resolved?.id).toBe("order-1");
  });

  it("drops a shared trade when same-user joined rows disagree on the option contract", () => {
    const rows = collapseUserTradeRows([
      {
        id: "trade-1",
        orderSymbol: "AAPL",
        orderAssetType: "OPTION",
        tradeAction: "BuyToOpen",
        optionExpiration: "260719",
        optionStrike: "250",
        optionType: "CALL",
      },
      {
        id: "trade-1",
        orderSymbol: "AAPL",
        orderAssetType: "OPTION",
        tradeAction: "BuyToOpen",
        optionExpiration: "260719",
        optionStrike: "300",
        optionType: "PUT",
        direction: "long",
      },
    ]);

    expect(rows).toEqual([]);
  });

  it("drops same-action rows whose joined directions conflict", () => {
    const rows = collapseUserTradeRows([
      {
        id: "trade-1",
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        tradeAction: "Buy",
        direction: "long",
      },
      {
        id: "trade-1",
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        tradeAction: "Buy",
        direction: "short",
      },
    ]);

    expect(rows).toEqual([]);
  });
});

describe("cursor encode/decode", () => {
  it("round-trips a (ts, id) cursor", () => {
    const cursor = { ts: "2026-06-09T12:00:00.000Z", id: "x_signal:abc-123" };
    const encoded = encodeCursor(cursor);
    expect(typeof encoded).toBe("string");
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it("round-trips failed source retry state, including a null start cursor", () => {
    const cursor = {
      ts: "2026-06-09T12:00:00.000Z",
      id: "user:abc-123",
      sourceCursors: {
        x_signal: null,
        user: { ts: "2026-06-08T12:00:00.000Z", id: "user:older" },
      },
      retrySources: ["x_signal" as const],
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns null for null/undefined/empty input", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for malformed (non-base64-json) input", () => {
    expect(decodeCursor("not-a-valid-cursor!!!")).toBeNull();
    // base64 of JSON missing the required fields
    const badShape = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
    expect(decodeCursor(badShape)).toBeNull();
  });

  it("returns null for a cursor whose ts is not a real date", () => {
    const bad = Buffer.from(JSON.stringify({ ts: "not-a-date", id: "user:a" })).toString("base64");
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe("mergeItems", () => {
  const item = (id: string, timestamp: string): CopyTradeItem => ({
    source: "x_signal",
    id,
    symbol: "AAPL",
    side: "buy",
    displayName: "Tester",
    avatar: null,
    timestamp,
    content: null,
    url: null,
    meta: {},
  });

  it("sorts newest-first by timestamp", () => {
    const a = item("a", "2026-06-01T00:00:00.000Z");
    const b = item("b", "2026-06-03T00:00:00.000Z");
    const c = item("c", "2026-06-02T00:00:00.000Z");
    const merged = mergeItems([[a], [b], [c]], 10);
    expect(merged.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("tie-breaks equal timestamps by id descending", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const a = item("user:aaa", ts);
    const b = item("user:zzz", ts);
    const c = item("user:mmm", ts);
    const merged = mergeItems([[a], [c], [b]], 10);
    expect(merged.map((i) => i.id)).toEqual(["user:zzz", "user:mmm", "user:aaa"]);
  });

  it("slices the merged result to the limit", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item(`id-${i}`, `2026-06-0${i + 1}T00:00:00.000Z`),
    );
    const merged = mergeItems([items], 3);
    expect(merged).toHaveLength(3);
    // newest three
    expect(merged.map((i) => i.id)).toEqual(["id-4", "id-3", "id-2"]);
  });
});

describe("copy trade asset-class filtering", () => {
  const item = (assetType?: string): CopyTradeItem => ({
    source: "user",
    id: `user:${assetType ?? "equity"}`,
    symbol: assetType === "PERP" ? "BTC" : "AAPL",
    side: "buy",
    displayName: "Trader",
    avatar: null,
    timestamp: "2026-06-01T00:00:00.000Z",
    content: null,
    url: null,
    followTarget: null,
    meta: assetType ? { assetType } : {},
  });

  it("keeps only normalized PERP rows for the Perps filter", () => {
    expect(copyTradeItemMatchesAssetClass(item("PERP"), "perps")).toBe(true);
    expect(copyTradeItemMatchesAssetClass(item("EQUITY"), "perps")).toBe(false);
    expect(copyTradeItemMatchesAssetClass(item(), "perps")).toBe(false);
  });

  it("keeps non-PERP rows for Stocks and all rows for All", () => {
    expect(copyTradeItemMatchesAssetClass(item("PERP"), "stocks")).toBe(false);
    expect(copyTradeItemMatchesAssetClass(item("EQUITY"), "stocks")).toBe(true);
    expect(copyTradeItemMatchesAssetClass(item(), "stocks")).toBe(true);
    expect(copyTradeItemMatchesAssetClass(item("PERP"), "all")).toBe(true);
    expect(copyTradeItemMatchesAssetClass(item("EQUITY"), "all")).toBe(true);
  });
});

describe("mapSignalToItem", () => {
  it("maps a signal row onto the contract", () => {
    const row = {
      id: "11111111-2222-3333-4444-555555555555",
      symbol: "aapl",
      content: "Buying $AAPL here",
      url: "https://x.com/someone/status/1",
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: { authorName: "Serenity • TweetShift", authorAvatar: "https://img/a.png" },
    };
    const out = mapSignalToItem(row);
    expect(out.source).toBe("x_signal");
    expect(out.id.startsWith("x_signal:")).toBe(true);
    expect(out.id).toBe(`x_signal:${row.id}`);
    expect(out.side).toBe("buy");
    expect(out.symbol).toBe("AAPL");
    expect(out.displayName).toBe("Serenity"); // TweetShift suffix stripped
    expect(out.avatar).toBe("https://img/a.png");
    expect(out.content).toBe("Buying $AAPL here");
    expect(out.url).toBe("https://x.com/someone/status/1");
    expect(out.timestamp).toBe("2026-06-09T10:00:00.000Z");
    expect(out.meta).toEqual({ signalId: row.id });
  });

  it("adds option contract metadata for explicit option X signals", () => {
    const row = {
      id: "sig-option-1",
      symbol: "aapl",
      content: "BTO $AAPL 250C 7/19",
      url: "https://x.com/someone/status/2",
      timestamp: new Date("2026-06-19T10:00:00.000Z"),
      metadata: { authorName: "Options Trader" },
    };

    const out = mapSignalToItem(row);
    expect(out.symbol).toBe("AAPL");
    expect(out.side).toBe("buy");
    expect(out.meta).toMatchObject({
      signalId: row.id,
      assetType: "OPTION",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "BuyToOpen",
    });
  });

  it("parses stringified metadata and degrades to Unknown author", () => {
    const out = mapSignalToItem({
      id: "abc",
      symbol: "TSLA",
      content: null,
      url: null,
      timestamp: "2026-06-09T10:00:00.000Z",
      metadata: "{}",
    });
    expect(out.displayName).toBe("Unknown");
    expect(out.avatar).toBeNull();
    expect((out.meta as { signalId: string }).signalId).toBe("abc");
  });

  it("reflects a short direction as side 'sell' and marks a perp signal as non-equity", () => {
    const row = {
      id: "sig-perp-short",
      symbol: "googl",
      content: "GOOGL short 20x perp",
      url: "https://paste.trade/t/1",
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: {
        authorName: "Perps Trader",
        platform: "hyperliquid",
        instrument: "perp",
        direction: "short",
      },
    };

    const out = mapSignalToItem(row);
    // A perp short must NOT read as a plain equity BUY.
    expect(out.side).toBe("sell");
    expect(out.symbol).toBe("GOOGL");
    expect(out.meta).toMatchObject({
      signalId: row.id,
      platform: "hyperliquid",
      instrument: "perp",
      direction: "short",
      mirrorableEquity: false,
    });
  });

  it("preserves a structured Hyperliquid signal as a routable PERP feed row", () => {
    const out = mapSignalToItem({
      id: "sig-perp-route",
      symbol: "KPEPE",
      content: "kPEPE short perp",
      url: "https://paste.trade/t/perp-route",
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: JSON.stringify({
        authorName: "Perps Trader",
        platform: "hyperliquid",
        instrument: "perp",
        direction: "short",
        hlTicker: "kPEPE",
        leverage: "20",
      }),
    });

    expect(out.side).toBe("sell");
    expect(out.meta).toMatchObject({
      signalId: "sig-perp-route",
      assetType: "PERP",
      mirrorableEquity: false,
      perpVenue: "hyperliquid",
      perpCoin: "kPEPE",
      perpDirection: "short",
      perpLeverage: 20,
      perpReduceOnly: false,
    });
  });

  it("classifies a perp-hint-only signal as a fail-closed PERP row", () => {
    const out = mapSignalToItem({
      id: "sig-perp-hint-only",
      symbol: "GOOGL",
      content: "GOOGL 20x long",
      url: "https://paste.trade/t/perp-hint-only",
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: JSON.stringify({
        authorName: "Perps Trader",
        hlTicker: "xyz:GOOGL",
        leverage: "20",
      }),
    });

    expect(out.side).toBe("buy");
    expect(out.meta).toMatchObject({
      signalId: "sig-perp-hint-only",
      assetType: "PERP",
      mirrorableEquity: false,
      perpVenue: null,
      perpCoin: "xyz:GOOGL",
      perpDirection: "long",
      perpLeverage: 20,
      perpReduceOnly: false,
    });
    expect(copyTradeItemMatchesAssetClass(out, "perps")).toBe(true);
    expect(copyTradeItemMatchesAssetClass(out, "stocks")).toBe(false);
  });

  it("lets authoritative structured PERP metadata beat contradictory option prose", () => {
    const out = mapSignalToItem({
      id: "sig-perp-option-conflict",
      symbol: "AAPL",
      content: "BTO $AAPL 250C 7/19/2027",
      url: "https://paste.trade/t/perp-option-conflict",
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: {
        authorName: "Perps Trader",
        platform: "hyperliquid",
        instrument: "perp",
        direction: "long",
        hlTicker: "xyz:AAPL",
        leverage: 20,
      },
    });

    expect(out.symbol).toBe("AAPL");
    expect(out.meta).toMatchObject({
      signalId: "sig-perp-option-conflict",
      assetType: "PERP",
      mirrorableEquity: false,
      perpVenue: "hyperliquid",
      perpCoin: "xyz:AAPL",
      perpDirection: "long",
      perpLeverage: 20,
      perpReduceOnly: false,
    });
    expect(out.meta.optionExpiration).toBeUndefined();
    expect(out.meta.optionStrike).toBeUndefined();
    expect(out.meta.optionType).toBeUndefined();
    expect(out.meta.tradeAction).toBeUndefined();
  });

  it("leaves a plain equity signal untouched (side 'buy', no instrument marker)", () => {
    // A signal without platform/instrument/direction must be byte-for-byte the
    // legacy shape: side 'buy' and meta === { signalId }.
    const out = mapSignalToItem({
      id: "sig-equity",
      symbol: "aapl",
      content: "Buying $AAPL here",
      url: null,
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: { authorName: "Cathie Wood" },
    });
    expect(out.side).toBe("buy");
    expect(out.meta).toEqual({ signalId: "sig-equity" });
  });

  it("marks malformed structured metadata non-copyable without changing legacy display", () => {
    const malformedRows = [
      { id: "sig-malformed-platform", symbol: "GOOGL", metadata: { platform: 42 } },
      { id: "sig-malformed-instrument", symbol: "BTC", metadata: { instrument: ["perp"] } },
      { id: "sig-malformed-direction", symbol: "GOOGL", metadata: { direction: ["short"] } },
    ];

    for (const row of malformedRows) {
      const out = mapSignalToItem({
        ...row,
        content: `Buying ${row.symbol} here`,
        url: null,
        timestamp: new Date("2026-06-09T10:00:00.000Z"),
      });

      expect(out.side).toBe("buy");
      expect(out.symbol).toBe(row.symbol);
      expect(out.meta).toMatchObject({
        signalId: row.id,
        mirrorableEquity: false,
        instrumentParseStatus: "unsupported",
        instrumentParseReason: "unrecognized structured signal metadata",
      });
    }
  });
});

describe("signal instrument classification helper (shared with the mirror worker)", () => {
  it("treats a perp/short signal as non-mirrorable and a plain signal as a mirrorable long", () => {
    expect(
      isMirrorableEquitySignal({ platform: "hyperliquid", instrument: "perp", direction: "short" }),
    ).toBe(false);
    expect(isMirrorableEquitySignal({ instrument: "perps" })).toBe(false);
    expect(isMirrorableEquitySignal({ direction: "short" })).toBe(false);
    // Legacy X/Discord signals (and empty metadata) stay mirrorable longs.
    expect(isMirrorableEquitySignal({ authorName: "Cathie Wood" })).toBe(true);
    expect(isMirrorableEquitySignal(null)).toBe(true);
  });

  it("maps direction to a feed side", () => {
    expect(signalSideFromMetadata({ direction: "short" })).toBe("sell");
    expect(signalSideFromMetadata({ direction: "long" })).toBe("buy");
    expect(signalSideFromMetadata({})).toBe("buy");
  });
});

describe("mapUserTradeToItem", () => {
  const fakeAnonymize = (userId: string) => ({
    traderName: `Trader-${userId}`,
    traderImage: `https://avatar/${userId}.png`,
  });

  it("maps a buy trade and prefixes the id", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-1",
        userId: "user-9",
        symbol: "nvda",
        orderId: "order-buy-1",
        orderSymbol: "NVDA",
        orderAssetType: "EQUITY",
        tradeAction: "Buy",
        direction: "long",
        side: "buy",
        qty: 10,
        orderType: "market",
        assetType: "EQUITY",
      limitPrice: null,
      fillPrice: "123.45",
      createdAt: new Date("2026-06-09T09:00:00.000Z"),
      },
      fakeAnonymize,
    );
    expect(out.source).toBe("user");
    expect(out.id).toBe("user:trade-1");
    expect(out.id.startsWith("user:")).toBe(true);
    expect(out.side).toBe("buy");
    expect(out.symbol).toBe("NVDA");
    expect(out.displayName).toBe("Trader-user-9");
    expect(out.avatar).toBe("https://avatar/user-9.png");
    expect(out.content).toBeNull();
    expect(out.url).toBeNull();
    expect(out.meta).toEqual({
      qty: 10,
      orderType: "market",
      fillPrice: 123.45,
      limitPrice: null,
      assetType: "EQUITY",
      copiedFrom: null,
      orderId: "order-buy-1",
      tradeAction: "Buy",
      direction: "long",
    });
  });

  it("passes through a sell side", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-2",
        userId: "user-1",
        symbol: "AMD",
        orderId: "order-sell-1",
        orderSymbol: "AMD",
        orderAssetType: "EQUITY",
        tradeAction: "Sell",
        direction: "long",
        side: "sell",
        qty: 5,
        orderType: "limit",
      assetType: "EQUITY",
      limitPrice: "200.00",
        fillPrice: null,
        createdAt: "2026-06-09T08:00:00.000Z",
      },
      fakeAnonymize,
    );
    expect(out.side).toBe("sell");
    expect((out.meta as { limitPrice: number }).limitPrice).toBe(200);
    expect((out.meta as { fillPrice: number | null }).fillPrice).toBeNull();
  });

  it("never collapses external short/cover actions into the opposite ordinary side", () => {
    const shortOpen = mapUserTradeToItem(
      {
        id: "trade-short-open",
        userId: "user-1",
        symbol: "AAPL",
        side: "buy",
        qty: 5,
        orderType: "Market",
        assetType: "EQUITY",
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        limitPrice: null,
        fillPrice: "100",
        tradeAction: "SellShort",
        direction: "short",
        orderId: "order-short-open",
        createdAt: "2026-06-09T08:00:00.000Z",
      },
      fakeAnonymize,
    );
    const shortClose = mapUserTradeToItem(
      {
        id: "trade-short-close",
        userId: "user-1",
        symbol: "AAPL",
        side: "sell",
        qty: 5,
        orderType: "Market",
        assetType: "EQUITY",
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        limitPrice: null,
        fillPrice: "90",
        tradeAction: "BuyToCover",
        direction: "short",
        orderId: "order-short-close",
        createdAt: "2026-06-09T08:01:00.000Z",
      },
      fakeAnonymize,
    );

    expect(shortOpen.side).toBe("sell");
    expect(shortOpen.meta).toMatchObject({
      tradeAction: "SellShort",
      direction: "short",
      orderId: "order-short-open",
    });
    expect(shortClose.side).toBe("buy");
    expect(shortClose.meta).toMatchObject({
      tradeAction: "BuyToCover",
      direction: "short",
      orderId: "order-short-close",
    });
  });

  it("normalizes ordinary short actions from authoritative direction for display", () => {
    const shortOpen = mapUserTradeToItem(
      {
        id: "trade-ordinary-short-open",
        userId: "user-1",
        symbol: "AAPL",
        side: "sell",
        qty: 5,
        orderType: "Market",
        assetType: "EQUITY",
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        limitPrice: null,
        fillPrice: "100",
        tradeAction: "Sell",
        direction: "short",
        orderId: "order-ordinary-short-open",
        createdAt: "2026-06-09T08:00:00.000Z",
      },
      fakeAnonymize,
    );
    const shortClose = mapUserTradeToItem(
      {
        id: "trade-ordinary-short-close",
        userId: "user-1",
        symbol: "AAPL",
        side: "buy",
        qty: 5,
        orderType: "Market",
        assetType: "EQUITY",
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        limitPrice: null,
        fillPrice: "90",
        tradeAction: "Buy",
        direction: "short",
        orderId: "order-ordinary-short-close",
        createdAt: "2026-06-09T08:01:00.000Z",
      },
      fakeAnonymize,
    );

    expect(shortOpen).not.toBeNull();
    expect(shortOpen?.side).toBe("sell");
    expect(shortOpen?.meta).toMatchObject({
      tradeAction: "SellShort",
      direction: "short",
    });
    expect(shortClose).not.toBeNull();
    expect(shortClose?.side).toBe("buy");
    expect(shortClose?.meta).toMatchObject({
      tradeAction: "BuyToCover",
      direction: "short",
    });
  });

  it("rejects malformed numeric strings instead of parsing their prefixes", () => {
    const malformedOption = mapUserTradeToItem(
      {
        id: "trade-option-malformed",
        userId: "user-1",
        symbol: "AAPL",
        side: "buy",
        qty: 1,
        orderType: "Market",
        assetType: "OPTION",
        orderSymbol: "AAPL",
        orderAssetType: "OPTION",
        limitPrice: "4junk",
        fillPrice: "2junk",
        optionExpiration: "260719",
        optionStrike: "250junk",
        optionType: "CALL",
        tradeAction: "BuyToOpen",
        direction: "long",
        orderId: "order-option-malformed",
        createdAt: "2026-06-09T08:00:00.000Z",
      },
      fakeAnonymize,
    );
    expect(malformedOption).toBeNull();

    const malformedPerp = mapUserTradeToItem(
      {
        id: "trade-perp-malformed",
        userId: "user-1",
        symbol: "BTC",
        orderSymbol: "xyz:BTC",
        side: "buy",
        qty: 1,
        executedSizeDecimal: "0.125junk",
        orderType: "Market",
        assetType: "PERP",
        orderAssetType: "PERP",
        orderId: "order-perp-malformed",
        tradeAction: "Buy",
        direction: "long",
        limitPrice: "4junk",
        fillPrice: "2junk",
        createdAt: "2026-06-09T08:00:00.000Z",
      },
      fakeAnonymize,
    );
    expect(malformedPerp?.meta).toMatchObject({
      qty: 1,
      fillPrice: null,
      limitPrice: null,
    });
  });

  it("passes through option contract identity for a shared user option trade", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-option-1",
        userId: "user-1",
        symbol: "AAPL",
        side: "buy",
        qty: 2,
        orderType: "Market",
        assetType: "OPTION",
        limitPrice: null,
        fillPrice: "2.50",
        createdAt: "2026-06-19T08:00:00.000Z",
        optionExpiration: "260719",
        optionStrike: "250.00",
        optionType: "CALL",
        tradeAction: "BuyToOpen",
        direction: "long",
        orderId: "order-option-1",
        orderSymbol: "AAPL",
        orderAssetType: "OPTION",
      },
      fakeAnonymize,
    );

    expect(out.meta).toMatchObject({
      qty: 2,
      orderType: "Market",
      fillPrice: 2.5,
      assetType: "OPTION",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "BuyToOpen",
    });
  });

  it("uses the exact joined decimal fill size for a shared perp trade", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-perp-1",
        userId: "user-1",
        symbol: "BTC",
        orderSymbol: "xyz:BTC",
        side: "sell",
        qty: 1,
        executedSizeDecimal: "0.125",
        orderType: "Market",
        assetType: "PERP",
        orderAssetType: "PERP",
        orderId: "order-perp-1",
        tradeAction: "Sell",
        direction: "long",
        limitPrice: null,
        fillPrice: "117500.25",
        createdAt: "2026-07-31T08:00:00.000Z",
      },
      fakeAnonymize,
    );

    expect(out.symbol).toBe("XYZ:BTC");
    expect(out.side).toBe("sell");
    expect(out.meta).toMatchObject({
      qty: 0.125,
      assetType: "PERP",
      fillPrice: 117500.25,
    });
  });

  // PR #176 vetoed perp/derivative rows from prefilling an Alpaca equity ticket,
  // but it only did so in mapSignalToItem. Real Hyperliquid fills reach the feed
  // through THIS mapper, and a long open arrives as side "buy" on a bare ticker,
  // so without a server-side veto the row is byte-for-byte an equity buy to every
  // consumer. The tickers collide for real: SOL is ReneSola on Nasdaq and APT
  // collides too, so the manual Copy prefilled a ticket for the wrong company.
  it("vetoes a Hyperliquid perp long open so it cannot be copied as an equity", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-perp-long",
        userId: "user-3",
        symbol: "SOL",
        orderId: "order-perp-long",
        orderSymbol: "SOL",
        tradeAction: "Buy",
        direction: "long",
        side: "buy",
        qty: 1,
        executedSizeDecimal: "12.5",
        orderType: "Market",
        assetType: "PERP",
        orderAssetType: "PERP",
        limitPrice: null,
        fillPrice: "180.25",
        createdAt: "2026-08-01T08:00:00.000Z",
      },
      fakeAnonymize,
    );

    expect(out.symbol).toBe("SOL");
    expect(out.side).toBe("buy");
    expect(out.meta).toMatchObject({
      assetType: "PERP",
      mirrorableEquity: false,
    });
  });

  // The perp copy route (copy-perp-route.ts) needs the coin, direction,
  // leverage and reduce-only flag the DB row actually carries - none of that
  // is reconstructable from `item.symbol` (uppercased) or `item.side`
  // (buy/sell only). This is the mapper-side half of "the button works": the
  // invariant test right above proves the equity veto still holds; this one
  // proves the perp route now has something to work with.
  it("carries the perp coin (case preserved), direction, and leverage for a joined perp row", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-perp-kpepe",
        userId: "user-4",
        symbol: "KPEPE",
        orderSymbol: "kPEPE",
        orderId: "order-perp-kpepe",
        tradeAction: "Buy",
        direction: "long",
        side: "buy",
        qty: 1,
        executedSizeDecimal: "500000",
        orderType: "Market",
        assetType: "PERP",
        orderAssetType: "PERP",
        limitPrice: null,
        fillPrice: "0.000012",
        createdAt: "2026-08-10T08:00:00.000Z",
        orderDirection: "long",
        orderLeverage: 10,
        orderReduceOnly: false,
        orderVenue: "hyperliquid",
      },
      fakeAnonymize,
    );

    // item.symbol stays the display-uppercased ticker - too many consumers
    // (quote map, filters) key on it to change now. The verbatim, HL-resolvable
    // spelling lives only in meta.perpCoin.
    expect(out.symbol).toBe("KPEPE");
    expect(out.meta).toMatchObject({
      perpCoin: "kPEPE",
      perpDirection: "long",
      perpLeverage: 10,
      perpReduceOnly: false,
      perpVenue: "hyperliquid",
      mirrorableEquity: false,
    });
  });

  it("carries a HIP-3 builder coin verbatim while item.symbol stays uppercased", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-perp-hip3",
        orderId: "order-perp-hip3",
        tradeAction: "Sell",
        direction: "short",
        userId: "user-4",
        symbol: "GOOGL",
        orderSymbol: "xyz:GOOGL",
        side: "sell",
        qty: 1,
        executedSizeDecimal: "2",
        orderType: "Market",
        assetType: "PERP",
        orderAssetType: "PERP",
        limitPrice: null,
        fillPrice: "180.00",
        createdAt: "2026-08-10T08:00:00.000Z",
        orderDirection: "short",
        orderLeverage: 5,
        orderReduceOnly: false,
        orderVenue: "hyperliquid",
      },
      fakeAnonymize,
    );

    expect(out.symbol).toBe("XYZ:GOOGL");
    expect((out.meta as { perpCoin?: string }).perpCoin).toBe("xyz:GOOGL");
  });

  it("omits perpCoin for a non-canonical symbol instead of guessing one", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-perp-bad-coin",
        orderId: "order-perp-bad-coin",
        tradeAction: "Buy",
        direction: "long",
        userId: "user-4",
        symbol: "KPEPE-USD",
        orderSymbol: "kPEPE-USD",
        side: "buy",
        qty: 1,
        executedSizeDecimal: "1",
        orderType: "Market",
        assetType: "PERP",
        orderAssetType: "PERP",
        limitPrice: null,
        fillPrice: "1.00",
        createdAt: "2026-08-10T08:00:00.000Z",
        orderDirection: "long",
        orderLeverage: 3,
        orderReduceOnly: false,
        orderVenue: "hyperliquid",
      },
      fakeAnonymize,
    );

    expect((out.meta as { perpCoin?: string }).perpCoin).toBeUndefined();
  });

  // A missed orders join (L-11's fan-out, or a legacy row published before the
  // synthetic child order existed) is now DROPPED rather than mapped with
  // fail-closed perp fields. The authoritative join is what supplies asset
  // type, symbol and intent, so a row without it cannot be described honestly
  // to any consumer, and a copy button on a row nothing can vouch for is the
  // hazard the fail-closed fields were guarding against in the first place.
  it("drops a perp row whose orders join is missing", () => {
    expect(mapUserTradeToItem(
      {
        id: "trade-perp-unjoined",
        userId: "user-4",
        symbol: "BTC",
        side: "buy",
        qty: 1,
        orderType: null,
        assetType: "PERP",
        limitPrice: null,
        fillPrice: null,
        createdAt: "2026-08-10T08:00:00.000Z",
        // No order* fields - simulates orders.brokerOrderId not matching.
      },
      fakeAnonymize,
    )).toBeNull();
  });

  it("emits none of the perp fields for an EQUITY row", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-equity-perp-fields",
        orderId: "order-equity-perp-fields",
        orderSymbol: "AAPL",
        tradeAction: "Buy",
        direction: "long",
        userId: "user-4",
        symbol: "AAPL",
        side: "buy",
        qty: 5,
        orderType: "Market",
        assetType: "EQUITY",
        orderAssetType: "EQUITY",
        limitPrice: null,
        fillPrice: "220.00",
        createdAt: "2026-08-10T08:00:00.000Z",
        orderDirection: "long",
        orderLeverage: 10,
        orderReduceOnly: false,
        orderVenue: "hyperliquid",
      },
      fakeAnonymize,
    );

    const meta = out.meta as Record<string, unknown>;
    expect(meta.perpCoin).toBeUndefined();
    expect(meta.perpDirection).toBeUndefined();
    expect(meta.perpLeverage).toBeUndefined();
    expect(meta.perpReduceOnly).toBeUndefined();
    expect(meta.perpVenue).toBeUndefined();
    expect(meta.mirrorableEquity).toBeUndefined();
  });

  it("leaves an equity trade mirrorable so the veto cannot swallow ordinary buys", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-equity-1",
        userId: "user-3",
        symbol: "NVDA",
        orderId: "order-equity-1",
        orderSymbol: "NVDA",
        tradeAction: "Buy",
        direction: "long",
        side: "buy",
        qty: 4,
        orderType: "market",
        assetType: "EQUITY",
        orderAssetType: "EQUITY",
        limitPrice: null,
        fillPrice: "170.00",
        createdAt: "2026-08-01T08:00:00.000Z",
      },
      fakeAnonymize,
    );

    expect(out.meta.mirrorableEquity).toBeUndefined();
  });

  it("rejects a legacy row without an authoritative order intent", () => {
    const out = mapUserTradeToItem(
      {
        id: "t3",
        userId: "u",
        symbol: "X",
        side: null,
        qty: 1,
        orderType: null,
        assetType: null,
        limitPrice: null,
        fillPrice: null,
        createdAt: "2026-06-09T08:00:00.000Z",
      },
      fakeAnonymize,
    );
    expect(out).toBeNull();
  });
});

describe("buildPage cursor pagination", () => {
  const mk = (id: string, ts: string): CopyTradeItem => ({
    source: "user",
    id,
    symbol: "AAPL",
    side: "buy",
    displayName: "t",
    avatar: null,
    timestamp: ts,
    content: null,
    url: null,
    meta: {},
  });
  const T = "2026-06-01T00:00:00.000Z";

  it("pages across a block of identical-timestamp rows with no drops or duplicates", () => {
    // 5 rows sharing one millisecond. The SQL key and buildPage tie-break both
    // use the normalized timestamp plus id, so no boundary row is lost.
    const all = ["user:a", "user:b", "user:c", "user:d", "user:e"].map((id) => mk(id, T));
    const seen: string[] = [];
    let cursor: { ts: string; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const page = buildPage([all], cursor, 2, true);
      if (page.items.length === 0) break;
      seen.push(...page.items.map((it) => it.id));
      if (!page.nextCursor) break;
      cursor = decodeCursor(page.nextCursor);
    }
    // newest-first, every row seen exactly once (the bug dropped boundary ties)
    expect(seen).toEqual(["user:e", "user:d", "user:c", "user:b", "user:a"]);
  });

  it("pages more than one page when PostgreSQL microseconds collapse to one millisecond", () => {
    const all = Array.from({ length: 1_001 }, (_, index) => ({
      ...mk(`user:${String(index).padStart(4, "0")}`, `2026-06-01T00:00:00.123${String(index % 1_000).padStart(3, "0")}Z`),
    }));
    const seen: string[] = [];
    let cursor: FeedCursor | null = null;
    for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
      const page = buildPage([all], cursor, 50, true);
      seen.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = decodeCursor(page.nextCursor);
    }

    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect(seen).toEqual(all.map((item) => item.id).sort().reverse());
  });

  it("excludes rows at-or-after the cursor and keeps strictly-older ones", () => {
    const items = [
      mk("user:b", "2026-06-03T00:00:00.000Z"),
      mk("user:a", "2026-06-02T00:00:00.000Z"),
      mk("user:c", "2026-06-01T00:00:00.000Z"),
    ];
    const page = buildPage([items], { ts: "2026-06-02T00:00:00.000Z", id: "user:a" }, 30, false);
    expect(page.items.map((i) => i.id)).toEqual(["user:c"]);
  });

  it("returns a null nextCursor when the page is short and no source was full", () => {
    const page = buildPage([[mk("user:a", T)]], null, 30, false);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("still returns a nextCursor when a source filled its batch even if the merged page is short", () => {
    const page = buildPage([[mk("user:a", T)]], null, 30, true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("does not advance a source past rows that lost the merged page", () => {
    // The source cursor is per-source state. Advancing every source to its raw
    // batch boundary is unsafe when another source fills the merged page: the
    // unreturned source rows still belong on the next page. This is especially
    // easy to hit when a fresh user-trade page is filled by newer X signals.
    const mkSource = (source: "x_signal" | "user", id: string, ts: string): CopyTradeItem => ({
      ...mk(id, ts),
      source,
    });
    const xNewest = mkSource("x_signal", "x_signal:newest", "2026-06-10T00:00:00.000Z");
    const xOlder = mkSource("x_signal", "x_signal:older", "2026-06-09T00:00:00.000Z");
    const userNewest = mk("user:newest", "2026-06-08T00:00:00.000Z");
    const userOlder = mk("user:older", "2026-06-07T00:00:00.000Z");

    const first = buildPage(
      [[xNewest, xOlder], [userNewest, userOlder]],
      null,
      2,
      true,
      null,
      [xOlder, userOlder],
      ["x_signal", "user"],
    );
    expect(first.items.map((item) => item.id)).toEqual([
      "x_signal:newest",
      "x_signal:older",
    ]);

    const second = buildPage(
      [[], [userNewest, userOlder]],
      decodeCursor(first.nextCursor),
      2,
      false,
      null,
      [null, null],
      ["x_signal", "user"],
    );
    expect(second.items.map((item) => item.id)).toEqual([
      "user:newest",
      "user:older",
    ]);
  });
});

describe("fullSourceFloorCursor (H-3 safe deep cursor)", () => {
  const p = (ts: string, id: string): CursorPoint => ({ ts, id });

  it("returns null when no source was full (nothing to page)", () => {
    expect(fullSourceFloorCursor([null, null])).toBeNull();
  });

  it("returns the single full source's boundary", () => {
    const b = p("2026-06-02T00:00:00.000Z", "user:x");
    expect(fullSourceFloorCursor([b, null])).toEqual(b);
  });

  it("returns the NEWEST of multiple full sources' oldest boundaries (no skipped rows)", () => {
    // Source A exhausted down to the 1st (older); source B only down to the 2nd
    // (newer). A cursor older than B's boundary would skip B's unfetched rows, so
    // the safe floor is the NEWER boundary (B).
    const older = p("2026-06-01T00:00:00.000Z", "user:a");
    const newer = p("2026-06-03T00:00:00.000Z", "user:b");
    expect(fullSourceFloorCursor([older, newer])).toEqual(newer);
  });
});

describe("raw user batch boundaries", () => {
  it("keeps pagination moving when every raw row maps to null", () => {
    const boundary = rawUserBatchBoundary([
      {
        id: "invalid-option-row",
        createdAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ]);

    expect(boundary).toEqual({
      ts: "2026-06-05T00:00:00.000Z",
      id: "user:invalid-option-row",
    });
    const page = buildPage([[]], null, 2, true, boundary);
    expect(page.items).toHaveLength(0);
    expect(decodeCursor(page.nextCursor)).toEqual(boundary);
  });

  it("keeps a valid user row at the raw boundary when an older X row shares the page", () => {
    const mkBoundaryItem = (id: string, timestamp: string, source: "user" | "x_signal"): CopyTradeItem => ({
      source,
      id,
      symbol: "AAPL",
      side: "buy",
      displayName: "t",
      avatar: null,
      timestamp,
      content: null,
      url: null,
      meta: {},
    });
    const olderX = {
      ...mkBoundaryItem("x_signal:older-x", "2026-06-08T00:00:00.000Z", "x_signal"),
    };
    const userBoundary: CursorPoint = {
      ts: "2026-06-09T00:00:00.000Z",
      id: "user:invalid-option-row",
    };
    const page1 = buildPage(
      [[olderX], []],
      null,
      2,
      true,
      null,
      [null, userBoundary],
      ["x_signal", "user"],
    );
    expect(page1.items.map((item) => item.id)).toEqual(["x_signal:older-x"]);
    expect(page1.nextCursor).not.toBeNull();

    const validAtBoundary = {
      ...mkBoundaryItem("user:boundary-valid", "2026-06-09T00:00:00.000Z", "user"),
    };
    const page2 = buildPage(
      [[], [validAtBoundary]],
      decodeCursor(page1.nextCursor),
      2,
      false,
      null,
      [null, null],
      ["x_signal", "user"],
    );
    expect(page2.items.map((item) => item.id)).toEqual(["user:boundary-valid"]);
  });
});

describe("buildPage failed-source retry cursors", () => {
  const item = (source: "x_signal" | "user", id: string, timestamp: string): CopyTradeItem => ({
    source,
    id,
    symbol: "AAPL",
    side: "buy",
    displayName: "t",
    avatar: null,
    timestamp,
    content: null,
    url: null,
    followTarget: null,
    meta: {},
  });

  it("keeps a failed source at its exact null/start cursor until it recovers", () => {
    const firstCursor = {
      ts: "2026-06-09T00:00:00.000Z",
      id: "user:page-1",
      sourceCursors: {
        x_signal: null,
        user: { ts: "2026-06-08T00:00:00.000Z", id: "user:page-2" },
      },
      retrySources: ["x_signal" as const],
    };
    const recovered = item("x_signal", "x_signal:recovered", "2026-06-10T00:00:00.000Z");
    const page = buildPage(
      [[recovered], []],
      firstCursor,
      2,
      false,
      null,
      [null, null],
      ["x_signal", "user"],
      ["x_signal"],
    );

    expect(page.items.map((entry) => entry.id)).toEqual(["x_signal:recovered"]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor)).toMatchObject({
      sourceCursors: { x_signal: null, user: null },
      retrySources: ["x_signal"],
    });
  });

  it("emits a stable newest sentinel when every first-page source fails before any row exists", () => {
    const page = buildPage(
      [[], []],
      null,
      30,
      false,
      null,
      [null, null],
      ["x_signal", "user"],
      ["x_signal", "user"],
    );
    const cursor = decodeCursor(page.nextCursor);

    expect(page.items).toHaveLength(0);
    expect(cursor).toMatchObject({
      ts: "9999-12-31T23:59:59.999Z",
      id: "__retry__",
      sourceCursors: { x_signal: null, user: null },
      retrySources: ["x_signal", "user"],
    });
  });
});

describe("copy-trade feed source failure recovery", () => {
  it("retries a failed source from its null/start cursor without skipping rows", async () => {
    let signalReads = 0;
    const userRow = {
      id: "shared-1",
      userId: "trader-1",
      symbol: "AAPL",
      orderSymbol: "AAPL",
      side: "buy",
      qty: 1,
      orderType: "market",
      assetType: "EQUITY",
      orderAssetType: "EQUITY",
      limitPrice: null,
      fillPrice: "100",
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      tradeAction: "Buy",
      direction: "long",
      orderId: "order-1",
      copySourceLabel: null,
      createdAt: new Date("2026-06-09T00:00:00.000Z"),
    };
    const signalRow = {
      id: "recovered-1",
      symbol: "AAPL",
      content: "Buying $AAPL here",
      url: null,
      timestamp: new Date("2026-06-10T00:00:00.000Z"),
      metadata: { authorName: "Recovered Signal" },
    };
    const userQuery: any = {
      from: () => userQuery,
      innerJoin: () => userQuery,
      where: () => userQuery,
      orderBy: () => userQuery,
      limit: () => userQuery,
      offset: (value: number) => Promise.resolve(value === 0 ? [userRow] : []),
    };
    const db = {
      query: {
        users: { findFirst: async () => ({ name: null, username: null, email: null }) },
        signals: {
          findMany: async () => {
            signalReads += 1;
            if (signalReads === 1) throw new Error("x source unavailable");
            return [signalRow];
          },
        },
      },
      select: () => userQuery,
    } as any;
    const caller = copyTradeRouter.createCaller({
      db,
      session: { userId: "viewer-1" },
      userId: "viewer-1",
      logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
    });

    const first = await caller.feed({ sources: ["x_signal", "user"], limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(["user:shared-1"]);
    expect(first.failedSources).toEqual(["x_signal"]);
    const retryCursor = decodeCursor(first.nextCursor);
    expect(retryCursor).toMatchObject({
      sourceCursors: {
        x_signal: null,
        user: { ts: "2026-06-09T00:00:00.000Z", id: "user:shared-1" },
      },
      retrySources: ["x_signal"],
    });

    const second = await caller.feed({
      sources: ["x_signal", "user"],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual(["x_signal:recovered-1"]);
    expect(second.failedSources).toEqual([]);
    expect(signalReads).toBe(2);
  });

  it("recovers after all first-page sources fail and keeps the failed source at the start", async () => {
    let signalReads = 0;
    let userReads = 0;
    const signalRow = {
      id: "recovered-signal",
      symbol: "AAPL",
      content: "Recovered signal",
      url: null,
      timestamp: new Date("2026-06-10T00:00:00.000Z"),
      metadata: { authorName: "Recovered Signal" },
    };
    const userRow = {
      id: "recovered-user",
      userId: "trader-1",
      symbol: "AAPL",
      orderSymbol: "AAPL",
      side: "buy",
      qty: 1,
      orderType: "market",
      assetType: "EQUITY",
      orderAssetType: "EQUITY",
      limitPrice: null,
      fillPrice: "100",
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      tradeAction: "Buy",
      direction: "long",
      orderId: "order-recovered-user",
      copySourceLabel: null,
      createdAt: new Date("2026-06-09T00:00:00.000Z"),
    };
    const userQuery: any = {
      from: () => userQuery,
      innerJoin: () => userQuery,
      where: () => userQuery,
      orderBy: () => userQuery,
      limit: () => userQuery,
      offset: async (value: number) => {
        userReads += 1;
        if (userReads === 1) throw new Error("user source unavailable");
        return value === 0 ? [userRow] : [];
      },
    };
    const db = {
      query: {
        users: { findFirst: async () => ({ name: null, username: null, email: null }) },
        signals: {
          findMany: async () => {
            signalReads += 1;
            if (signalReads === 1) throw new Error("x source unavailable");
            return [signalRow];
          },
        },
      },
      select: () => userQuery,
    } as any;
    const caller = copyTradeRouter.createCaller({
      db,
      session: { userId: "viewer-1" },
      userId: "viewer-1",
      logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
    });

    const first = await caller.feed({ sources: ["x_signal", "user"], limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.failedSources).toEqual(["x_signal", "user"]);
    expect(decodeCursor(first.nextCursor)).toMatchObject({
      sourceCursors: { x_signal: null, user: null },
      retrySources: ["x_signal", "user"],
    });

    const second = await caller.feed({
      sources: ["x_signal", "user"],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual(["x_signal:recovered-signal"]);
    expect(second.failedSources).toEqual([]);
    expect(signalReads).toBe(2);
    expect(userReads).toBeGreaterThan(1);
  });
});

describe("copy-trade feed asset-class pagination", () => {
  it("scans older X-signal batches until a filtered PERP row is found", async () => {
    let signalReads = 0;
    const stockRows = [
      {
        id: "stock-new",
        source: null,
        symbol: "AAPL",
        content: "Buying $AAPL here",
        url: null,
        timestamp: new Date("2026-06-10T00:00:00.000Z"),
        metadata: { authorName: "Stock Trader" },
      },
      {
        id: "stock-old",
        source: null,
        symbol: "MSFT",
        content: "Buying $MSFT here",
        url: null,
        timestamp: new Date("2026-06-09T00:00:00.000Z"),
        metadata: { authorName: "Stock Trader" },
      },
    ];
    const perpRow = {
      id: "perp-old",
      source: null,
      symbol: "GOOGL",
      content: "GOOGL long perp",
      url: null,
      timestamp: new Date("2026-06-08T00:00:00.000Z"),
      metadata: {
        authorName: "Perps Trader",
        platform: "hyperliquid",
        instrument: "perp",
        direction: "long",
        hlTicker: "xyz:GOOGL",
      },
    };
    const db = {
      query: {
        users: { findFirst: async () => ({ name: null, username: null, email: null }) },
        signals: {
          findMany: async () => {
            signalReads += 1;
            return signalReads === 1 ? stockRows : [perpRow];
          },
        },
      },
      select: () => ({}),
    } as any;
    const caller = copyTradeRouter.createCaller({
      db,
      session: { userId: "viewer-1" },
      userId: "viewer-1",
      logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
    });

    const page = await caller.feed({ sources: ["x_signal"], limit: 2, assetClass: "perps" });

    expect(page.items.map((item) => item.id)).toEqual(["x_signal:perp-old"]);
    expect(page.items[0]?.meta).toMatchObject({
      assetType: "PERP",
      perpCoin: "xyz:GOOGL",
    });
    expect(signalReads).toBe(2);
    expect(page.nextCursor).toBeNull();
  });

  it("does not skip a filtered match accumulated beyond the page limit", async () => {
    let signalReads = 0;
    const perpRow = (id: string, timestamp: string) => ({
      id,
      source: null,
      symbol: "GOOGL",
      content: "GOOGL long perp",
      url: null,
      timestamp: new Date(timestamp),
      metadata: {
        authorName: "Perps Trader",
        platform: "hyperliquid",
        instrument: "perp",
        direction: "long",
        hlTicker: "xyz:GOOGL",
      },
    });
    const stockRow = {
      id: "stock-between",
      source: null,
      symbol: "AAPL",
      content: "Buying $AAPL here",
      url: null,
      timestamp: new Date("2026-06-09T12:00:00.000Z"),
      metadata: { authorName: "Stock Trader" },
    };
    const batches = [
      [perpRow("perp-1", "2026-06-10T00:00:00.000Z"), stockRow],
      [
        perpRow("perp-2", "2026-06-09T00:00:00.000Z"),
        perpRow("perp-3", "2026-06-08T00:00:00.000Z"),
      ],
      // The mock deliberately returns the boundary candidate on the next read;
      // buildPage's source cursor must be p2 (the last returned match), not p3
      // (the unreturned match), for this row to survive the cursor cut.
      [perpRow("perp-3", "2026-06-08T00:00:00.000Z")],
    ];
    const db = {
      query: {
        users: { findFirst: async () => ({ name: null, username: null, email: null }) },
        signals: {
          findMany: async () => batches[signalReads++] ?? [],
        },
      },
      select: () => ({}),
    } as any;
    const caller = copyTradeRouter.createCaller({
      db,
      session: { userId: "viewer-1" },
      userId: "viewer-1",
      logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
    });

    const first = await caller.feed({ sources: ["x_signal"], limit: 2, assetClass: "perps" });
    const second = await caller.feed({
      sources: ["x_signal"],
      limit: 2,
      assetClass: "perps",
      cursor: first.nextCursor,
    });
    const seen = [...first.items, ...second.items].map((item) => item.id);

    expect(first.items.map((item) => item.id)).toEqual([
      "x_signal:perp-1",
      "x_signal:perp-2",
    ]);
    expect(second.items.map((item) => item.id)).toEqual(["x_signal:perp-3"]);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(signalReads).toBe(3);
  });
});

describe("copy-trade Following follow paging", () => {
  it("loads a followed target beyond the first bounded follow page", async () => {
    const followRows = Array.from({ length: 101 }, (_, index) => ({
      id: `follow-${String(101 - index).padStart(3, "0")}`,
      followerUserId: "viewer-1",
      targetType: "x_author",
      targetKey: `follow-${index}`,
      createdAt: new Date("2026-06-09T14:00:00.123Z"),
    }));
    const signalRow = {
      id: "followed-signal",
      source: null,
      symbol: "AAPL",
      content: "Buying $AAPL here",
      url: null,
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: { authorName: "follow-100" },
    };
    let queryMode: "follows" | "aliases" = "follows";
    let followPageCalls = 0;
    const followQuery: any = {
      from: (table: unknown) => {
        queryMode = table === schema.copyTradeFollows ? "follows" : "aliases";
        return followQuery;
      },
      innerJoin: () => followQuery,
      where: () => followQuery,
      orderBy: () => followQuery,
      limit: (limit: number) => {
        if (queryMode === "aliases") return Promise.resolve([]);
        const start = followPageCalls * limit;
        followPageCalls += 1;
        return Promise.resolve(followRows.slice(start, start + limit));
      },
    };
    const db = {
      query: {
        users: { findFirst: async () => ({ name: null, username: null, email: null }) },
        signals: { findMany: async () => [signalRow] },
      },
      select: () => followQuery,
    } as any;
    const caller = copyTradeRouter.createCaller({
      db,
      session: { userId: "viewer-1" },
      userId: "viewer-1",
      logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
    });

    const page = await caller.feed({ sources: ["x_signal"], followedOnly: true, limit: 1 });

    expect(page.items.map((item) => item.id)).toEqual(["x_signal:followed-signal"]);
    expect(followPageCalls).toBe(2);
  });
});

describe("buildPage — H-3: Following view does not dead-end", () => {
  // Simulate the followedOnly path: the per-source arrays are ALREADY filtered to
  // the follow set BEFORE buildPage. The newest `limit` raw rows held no followed
  // item, so the (filtered) page is EMPTY — but a raw batch was full, so we still
  // get a cursor (the deepest safe raw boundary) and keep paging into older rows.
  const mkF = (id: string, ts: string): CopyTradeItem => ({
    source: "user",
    id,
    symbol: "AAPL",
    side: "buy",
    displayName: "t",
    avatar: null,
    timestamp: ts,
    content: null,
    url: null,
    followTarget: { type: "user", key: "k", label: "t" },
    meta: {},
  });

  it("returns a nextCursor for a 0-item followed page when a raw batch was full", () => {
    // No followed items survived the filter (empty perSource), but the raw user
    // batch was full and its oldest raw row is the floor boundary.
    const floor: CursorPoint = { ts: "2026-06-05T00:00:00.000Z", id: "user:oldest-raw" };
    const page = buildPage([[]], null, 2, /* anySourceFull */ true, floor);
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).not.toBeNull(); // does NOT dead-end
    expect(decodeCursor(page.nextCursor)).toEqual(floor);
  });

  it("eventually surfaces an OLDER followed row across pages instead of stopping", () => {
    // The only followed row sits OLDER than the newest `limit` raw rows. Page 1's
    // filtered view is empty; the floor cursor lets page 2 reach the followed row.
    const followedRow = mkF("user:followed", "2026-06-01T00:00:00.000Z");
    const page1Floor: CursorPoint = { ts: "2026-06-04T00:00:00.000Z", id: "user:raw-30" };

    // Page 1: filtered to [] (newest raw rows weren't followed), raw batch full.
    const page1 = buildPage([[]], null, 2, true, page1Floor);
    expect(page1.items).toHaveLength(0);
    expect(page1.nextCursor).not.toBeNull();
    const cursor1 = decodeCursor(page1.nextCursor);
    expect(cursor1).toEqual(page1Floor);

    // Page 2: paging from the floor now reaches the older followed row; the raw
    // batch is no longer full (source exhausted) so no further floor is supplied.
    const page2 = buildPage([[followedRow]], cursor1, 2, false, null);
    expect(page2.items.map((i) => i.id)).toEqual(["user:followed"]);
    expect(page2.nextCursor).toBeNull(); // terminates cleanly once exhausted
  });

  it("does not page backwards: the floor only applies when it makes progress", () => {
    // A followed item IS on this page (older than the floor). The floor must not
    // override the page's own (older) last-item cursor or we'd re-serve rows.
    const onPage = mkF("user:on-page", "2026-06-01T00:00:00.000Z");
    const floor: CursorPoint = { ts: "2026-06-05T00:00:00.000Z", id: "user:raw" };
    const page = buildPage([[onPage]], null, 2, true, floor);
    expect(page.items.map((i) => i.id)).toEqual(["user:on-page"]);
    // last item (older) wins over the newer floor -> next page continues older.
    expect(decodeCursor(page.nextCursor)).toEqual({
      ts: "2026-06-01T00:00:00.000Z",
      id: "user:on-page",
    });
  });

  it("keeps the visible last-item cursor on a full filtered page", () => {
    const newest = mkF("user:f10", "2026-06-10T00:00:00.000Z");
    const lastVisible = mkF("user:f9", "2026-06-09T00:00:00.000Z");
    const rawFloor: CursorPoint = { ts: "2026-06-08T00:00:00.000Z", id: "user:f8" };

    const page = buildPage([[newest, lastVisible]], null, 2, true, rawFloor);
    expect(page.items.map((item) => item.id)).toEqual(["user:f10", "user:f9"]);
    expect(decodeCursor(page.nextCursor)).toEqual({
      ts: lastVisible.timestamp,
      id: lastVisible.id,
    });

    const nextPage = buildPage(
      [[mkF("user:f8", "2026-06-08T00:00:00.000Z")]],
      decodeCursor(page.nextCursor),
      2,
      false,
      null,
    );
    expect(nextPage.items.map((item) => item.id)).toEqual(["user:f8"]);
  });

  it("non-followedOnly path is unchanged (no floor -> terminates on a short page)", () => {
    const page = buildPage([[mkF("user:a", "2026-06-01T00:00:00.000Z")]], null, 30, false, null);
    expect(page.nextCursor).toBeNull();
  });

  it("does not stall: a floor at-or-above the incoming cursor is NOT re-emitted", () => {
    // The SQL over-fetch can re-include the boundary row at the same millisecond,
    // so a floor equal to the incoming cursor must not be handed back (it would
    // re-request the same page forever). Terminates instead.
    const cursor: CursorPoint = { ts: "2026-06-04T00:00:00.000Z", id: "user:raw-30" };
    const page = buildPage([[]], cursor, 2, true, cursor /* floor == cursor */);
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("advances when the floor is strictly older than the incoming cursor", () => {
    const cursor: CursorPoint = { ts: "2026-06-04T00:00:00.000Z", id: "user:raw-30" };
    const floor: CursorPoint = { ts: "2026-06-02T00:00:00.000Z", id: "user:raw-older" };
    const page = buildPage([[]], cursor, 2, true, floor);
    expect(decodeCursor(page.nextCursor)).toEqual(floor);
  });
});
