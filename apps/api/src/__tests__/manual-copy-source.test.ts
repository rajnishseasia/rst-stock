import { describe, expect, it, vi } from "bun:test";
import { sql } from "drizzle-orm";
import {
  assertManualCopySourceReplayMatches,
  copySourceItemIdSchema,
  manualCopyOrderProvenance,
  normalizeCopySourceItemId,
  resolveManualCopySource,
} from "../lib/manual-copy-source.js";

const SIGNAL_ID = "11111111-1111-4111-8111-111111111111";
const USER_TRADE_ID = "22222222-2222-4222-8222-222222222222";

function sourceSelectDb(rows: readonly Record<string, unknown>[]) {
  const query: any = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    limit: vi.fn().mockResolvedValue(rows),
    getSQL: () => sql`select 1`,
    shouldInlineParams: true,
  };
  return {
    select: vi.fn(() => query),
  } as any;
}

function xSignalDb(
  content: string,
  metadata: unknown = null,
  symbol = "AAPL",
) {
  return {
    query: {
      signals: {
        findFirst: vi.fn().mockResolvedValue({
          id: SIGNAL_ID,
          symbol,
          content,
          metadata,
        }),
      },
    },
  } as any;
}

function userSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    socialId: USER_TRADE_ID,
    orderId: "33333333-3333-4333-8333-333333333333",
    orderSymbol: "AAPL",
    orderAssetType: "EQUITY",
    orderTradeAction: "Buy",
    orderDirection: "long",
    orderReduceOnly: false,
    orderVenue: "alpaca",
    ...overrides,
  };
}

describe("manual copy source contract", () => {
  it("accepts only canonical feed item ids", () => {
    expect(copySourceItemIdSchema.parse(` x_signal:${SIGNAL_ID} `)).toBe(
      `x_signal:${SIGNAL_ID}`,
    );
    expect(() => copySourceItemIdSchema.parse("user:source-user-id")).toThrow();
    expect(
      resolveManualCopySource(
        { query: { signals: { findFirst: vi.fn() } } } as any,
        null,
        "source-user-id",
        {
          assetType: "EQUITY",
          symbol: "AAPL",
          tradeAction: "Buy",
          direction: "long",
        },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("resolves a visible legacy X stock call from the immutable signal", async () => {
    const db = {
      query: {
        signals: {
          findFirst: vi.fn().mockResolvedValue({
            id: SIGNAL_ID,
            symbol: "GOOGL",
            content: "Buying GOOGL here",
            metadata: { authorName: "Legacy Caller" },
          }),
        },
      },
    } as any;

    const source = await resolveManualCopySource(db, { email: "viewer@example.test" }, `x_signal:${SIGNAL_ID}`, {
      assetType: "EQUITY",
      symbol: "GOOGL",
      tradeAction: "Buy",
      direction: "long",
      signalId: SIGNAL_ID,
    });

    expect(source).toMatchObject({
      sourceItemId: `x_signal:${SIGNAL_ID}`,
      sourceKind: "x_signal",
      sourceOrderId: null,
      signalId: SIGNAL_ID,
      assetType: "EQUITY",
      symbol: "GOOGL",
      venue: "alpaca",
      direction: "long",
    });

    await expect(
      resolveManualCopySource(db, { email: "viewer@example.test" }, `x_signal:${SIGNAL_ID}`, {
        assetType: "EQUITY",
        symbol: "GOOGL",
        tradeAction: "Buy",
        direction: "long",
        signalId: USER_TRADE_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("resolves a well-formed X Hyperliquid call without using its display ticker", async () => {
    const db = {
      query: {
        signals: {
          findFirst: vi.fn().mockResolvedValue({
            id: SIGNAL_ID,
            symbol: "GOOGL",
            content: "xyz:GOOGL short perp",
            metadata: {
              authorName: "Perps Caller",
              platform: "hyperliquid",
              instrument: "perp",
              direction: "short",
              hlTicker: "xyz:GOOGL",
            },
          }),
        },
      },
    } as any;

    const source = await resolveManualCopySource(db, null, `x_signal:${SIGNAL_ID}`, {
      assetType: "PERP",
      coin: "xyz:GOOGL",
      isLong: false,
      reduceOnly: false,
    });

    expect(source).toMatchObject({
      sourceItemId: `x_signal:${SIGNAL_ID}`,
      assetType: "PERP",
      symbol: "xyz:GOOGL",
      venue: "hyperliquid",
      direction: "short",
    });
  });

  it("resolves a public user source through the authoritative order join", async () => {
    const db = sourceSelectDb([userSourceRow()]);
    const source = await resolveManualCopySource(db, null, `user:${USER_TRADE_ID}`, {
      assetType: "EQUITY",
      symbol: "AAPL",
      tradeAction: "Buy",
      direction: "long",
    });

    expect(source).toMatchObject({
      sourceItemId: `user:${USER_TRADE_ID}`,
      sourceKind: "user",
      sourceRecordId: USER_TRADE_ID,
      sourceOrderId: "33333333-3333-4333-8333-333333333333",
      signalId: null,
      assetType: "EQUITY",
      symbol: "AAPL",
      venue: "alpaca",
      direction: "long",
    });
    expect(db.select).toHaveBeenCalled();
  });

  it("resolves a public user perp only when venue, coin, direction, and opening intent agree", async () => {
    const db = sourceSelectDb([
      userSourceRow({
        orderSymbol: "kPEPE",
        orderAssetType: "PERP",
        orderTradeAction: "Sell",
        orderDirection: "short",
        orderReduceOnly: false,
        orderVenue: "hyperliquid",
      }),
    ]);

    const source = await resolveManualCopySource(db, null, `user:${USER_TRADE_ID}`, {
      assetType: "PERP",
      coin: "kPEPE",
      isLong: false,
      reduceOnly: false,
    });

    expect(source).toMatchObject({
      assetType: "PERP",
      symbol: "kPEPE",
      venue: "hyperliquid",
      direction: "short",
      sourceOrderId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects hidden/deleted sources and does not accept an arbitrary user id", async () => {
    const db = sourceSelectDb([]);
    await expect(
      resolveManualCopySource(db, null, `user:${USER_TRADE_ID}`, {
        assetType: "EQUITY",
        symbol: "AAPL",
        tradeAction: "Buy",
        direction: "long",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("not found"),
    });
  });

  it("rejects wrong venue, symbol, direction, reduce-only intent, and forged signal linkage", async () => {
    const cases: Array<{
      row: Record<string, unknown>;
      intent: Parameters<typeof resolveManualCopySource>[3];
      message: string;
    }> = [
      {
        row: userSourceRow({ orderVenue: "hyperliquid" }),
        intent: { assetType: "EQUITY", symbol: "AAPL", tradeAction: "Buy", direction: "long" },
        message: "wrong venue",
      },
      {
        row: userSourceRow({ orderVenue: null }),
        intent: { assetType: "EQUITY", symbol: "AAPL", tradeAction: "Buy", direction: "long" },
        message: "wrong venue",
      },
      {
        row: userSourceRow(),
        intent: { assetType: "EQUITY", symbol: "MSFT", tradeAction: "Buy", direction: "long" },
        message: "source symbol",
      },
      {
        row: userSourceRow({ orderTradeAction: "Sell", orderDirection: "long" }),
        intent: { assetType: "EQUITY", symbol: "AAPL", tradeAction: "Buy", direction: "long" },
        message: "opening long",
      },
      {
        row: userSourceRow({
          orderSymbol: "BTC",
          orderAssetType: "PERP",
          orderTradeAction: "Buy",
          orderDirection: "long",
          orderReduceOnly: true,
          orderVenue: "hyperliquid",
        }),
        intent: { assetType: "PERP", coin: "BTC", isLong: true, reduceOnly: false },
        message: "reduceOnly",
      },
    ];

    for (const testCase of cases) {
      await expect(
        resolveManualCopySource(
          sourceSelectDb([testCase.row]),
          null,
          `user:${USER_TRADE_ID}`,
          testCase.intent,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(testCase.message),
      });
    }

    await expect(
      resolveManualCopySource(
        sourceSelectDb([userSourceRow()]),
        null,
        `user:${USER_TRADE_ID}`,
        {
          assetType: "EQUITY",
          symbol: "AAPL",
          tradeAction: "Buy",
          direction: "long",
          signalId: SIGNAL_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("fails closed on malformed X instrument metadata even when the ticker collides", async () => {
    const db = {
      query: {
        signals: {
          findFirst: vi.fn().mockResolvedValue({
            id: SIGNAL_ID,
            symbol: "BTC",
            content: "Buying BTC here",
            metadata: { platform: 42 },
          }),
        },
      },
    } as any;

    await expect(
      resolveManualCopySource(db, null, `x_signal:${SIGNAL_ID}`, {
        assetType: "EQUITY",
        symbol: "BTC",
        tradeAction: "Buy",
        direction: "long",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("unrecognized"),
    });
  });

  it("rejects an option-looking X source instead of authorizing an equity buy", async () => {
    const db = {
      query: {
        signals: {
          findFirst: vi.fn().mockResolvedValue({
            id: SIGNAL_ID,
            symbol: "AAPL",
            content: "BTO $AAPL 250C 7/19",
            metadata: null,
          }),
        },
      },
    } as any;

    await expect(
      resolveManualCopySource(db, null, `x_signal:${SIGNAL_ID}`, {
        assetType: "EQUITY",
        symbol: "AAPL",
        tradeAction: "Buy",
        direction: "long",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("option contract"),
    });
  });

  it("accepts plain equity prose unless option context is explicit", async () => {
    for (const { content, symbol } of [
      { content: "Buying AAPL ahead of the earnings calendar", symbol: "AAPL" },
      { content: "Buying AAPL despite the credit downgrade", symbol: "AAPL" },
      { content: "Buying AAPL after the butterfly exhibit", symbol: "AAPL" },
      { content: "Bought AAPL after the earnings call", symbol: "AAPL" },
      { content: "BTC treasury company announces another purchase", symbol: "BTC" },
    ]) {
      const source = await resolveManualCopySource(
        xSignalDb(content, null, symbol),
        null,
        `x_signal:${SIGNAL_ID}`,
        {
          assetType: "EQUITY",
          symbol,
          tradeAction: "Buy",
          direction: "long",
        },
      );

      expect(source).toMatchObject({
        assetType: "EQUITY",
        symbol,
        venue: "alpaca",
        direction: "long",
      });
    }
  });

  it("rejects incomplete option syntax when the parser cannot form a contract", async () => {
    for (const content of [
      "BTO $AAPL 250C",
      "BuyToOpen AAPL",
      "AAPL 250C 7/19",
      "Buying AAPL calls before earnings",
      "Buying AAPL call options before earnings",
      "BTC $AAPL",
    ]) {
      await expect(
        resolveManualCopySource(
          xSignalDb(content),
          null,
          `x_signal:${SIGNAL_ID}`,
          {
            assetType: "EQUITY",
            symbol: "AAPL",
            tradeAction: "Buy",
            direction: "long",
          },
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("option contract"),
      });
    }
  });

  it("rejects structured option metadata even when the prose is not option-shaped", async () => {
    const db = {
      query: {
        signals: {
          findFirst: vi.fn().mockResolvedValue({
            id: SIGNAL_ID,
            symbol: "AAPL",
            content: "Buying AAPL here",
            metadata: { platform: "alpaca", instrument: "option" },
          }),
        },
      },
    } as any;

    await expect(
      resolveManualCopySource(db, null, `x_signal:${SIGNAL_ID}`, {
        assetType: "EQUITY",
        symbol: "AAPL",
        tradeAction: "Buy",
        direction: "long",
      }),
    ).rejects.toThrow("option contract");
  });

  it("rejects an explicit structured option action without trusting the prose", async () => {
    await expect(
      resolveManualCopySource(
        xSignalDb("Buying AAPL ahead of the earnings calendar", {
          platform: "alpaca",
          tradeAction: "BuyToOpen",
        }),
        null,
        `x_signal:${SIGNAL_ID}`,
        {
          assetType: "EQUITY",
          symbol: "AAPL",
          tradeAction: "Buy",
          direction: "long",
        },
      ),
    ).rejects.toThrow("option contract");
  });

  it("stores verified attribution outside notes and binds replay comparison to the canonical item id", () => {
    const source = {
      sourceItemId: `user:${USER_TRADE_ID}`,
      sourceKind: "user" as const,
      sourceRecordId: USER_TRADE_ID,
      sourceOrderId: "33333333-3333-4333-8333-333333333333",
      signalId: null,
      assetType: "EQUITY" as const,
      symbol: "AAPL",
      venue: "alpaca" as const,
      direction: "long" as const,
    };
    const provenance = manualCopyOrderProvenance(source, "user note");

    expect(provenance).toEqual({
      signalId: null,
      notes: "user note",
      manualCopySourceItemId: `user:${USER_TRADE_ID}`,
      manualCopySourceOrderId: "33333333-3333-4333-8333-333333333333",
      copySourceLabel: null,
    });
    expect(provenance.notes).not.toContain("manual-copy-source");
    expect(normalizeCopySourceItemId(` x_signal:${SIGNAL_ID} `)).toBe(
      `x_signal:${SIGNAL_ID}`,
    );
    expect(normalizeCopySourceItemId(undefined)).toBeNull();
    expect(() => assertManualCopySourceReplayMatches(
      `x_signal:${SIGNAL_ID}`,
      `user:${USER_TRADE_ID}`,
    )).toThrow("different copy source");
  });
});
