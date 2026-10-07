import { describe, it, expect } from "bun:test";
import {
  perpCoinSchema,
  perpOrderSubmitSchema,
  toPlacePerpOrderRequest,
  toPerpOrderRow,
  perpTradeAction,
  mapPositionRow,
} from "../lib/perp-orders";

/**
 * Real-module tests (per CLAUDE.md audit): import the actual mapping helpers and
 * assert their behavior — no readFileSync+regex. Covers perp-form→submitPerp
 * payload mapping, the orders-row insert (DECIMAL size guard), and the
 * clearinghouseState→row mapping re-exported from the wrapper.
 */

const baseInput = {
  coin: "BTC",
  isLong: true,
  marginMode: "cross" as const,
  orderType: "Market" as const,
  sizeCoin: "0.0125",
  reduceOnly: false,
  postOnly: false,
  leverage: 10,
  cloid: "perp-abc-123",
  markPrice: "65000.0",
};

describe("perpCoinSchema (shared by submitPerp / cancelPerp / setPerpTpSl / setLeverage)", () => {
  it("trims but preserves HL canonical casing (kPEPE, kBONK, xyz:GOOGL)", () => {
    // The HL asset lookup is exact-match: "KPEPE" is an unknown coin, so a
    // cancel / TP-SL / leverage call that uppercased would fail or miss.
    expect(perpCoinSchema.parse(" kPEPE ")).toBe("kPEPE");
    expect(perpCoinSchema.parse("kBONK")).toBe("kBONK");
    expect(perpCoinSchema.parse("xyz:GOOGL")).toBe("xyz:GOOGL");
    expect(perpCoinSchema.parse("BTC")).toBe("BTC");
  });

  it("rejects an empty or whitespace-only coin", () => {
    expect(perpCoinSchema.safeParse("").success).toBe(false);
    expect(perpCoinSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects a coin longer than 20 characters", () => {
    expect(perpCoinSchema.safeParse("A".repeat(21)).success).toBe(false);
  });
});

describe("perpOrderSubmitSchema", () => {
  it("preserves HL canonical coin casing and applies reduce/post-only defaults", () => {
    // HL coins are case-sensitive canonical spellings (kPEPE): uppercasing
    // here would make the exact-match HL asset lookup fail downstream.
    const parsed = perpOrderSubmitSchema.parse({
      coin: " kPEPE ",
      isLong: false,
      marginMode: "isolated",
      orderType: "Market",
      sizeCoin: "1.5",
      leverage: 5,
      cloid: "x",
    });
    expect(parsed.coin).toBe("kPEPE");
    expect(parsed.reduceOnly).toBe(false);
    expect(parsed.postOnly).toBe(false);
  });

  it("rejects a non-decimal size string (float-truncation guard)", () => {
    const res = perpOrderSubmitSchema.safeParse({ ...baseInput, sizeCoin: "abc" });
    expect(res.success).toBe(false);
  });

  it("rejects zero or negative size", () => {
    expect(perpOrderSubmitSchema.safeParse({ ...baseInput, sizeCoin: "0" }).success).toBe(false);
  });

  it("accepts the shared perp boundary and rejects values above it for every decimal field", () => {
    const boundary = "90071992.54740991";
    const over = "90071992.54740992";
    expect(perpOrderSubmitSchema.safeParse({ ...baseInput, sizeCoin: boundary }).success).toBe(true);
    expect(perpOrderSubmitSchema.safeParse({ ...baseInput, sizeCoin: over }).success).toBe(false);
    expect(perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "Limit",
      limitPrice: boundary,
    }).success).toBe(true);
    expect(perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "Limit",
      limitPrice: over,
    }).success).toBe(false);
    for (const field of ["triggerPx", "markPrice", "takeProfitPx", "stopLossPx"] as const) {
      expect(perpOrderSubmitSchema.safeParse({ ...baseInput, [field]: boundary }).success).toBe(true);
      expect(perpOrderSubmitSchema.safeParse({ ...baseInput, [field]: over }).success).toBe(false);
    }
  });

  it("requires a limitPrice for Limit orders", () => {
    const res = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "Limit",
      limitPrice: undefined,
    });
    expect(res.success).toBe(false);
  });

  it("accepts a Limit order with a limitPrice", () => {
    const res = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "Limit",
      limitPrice: "64000.5",
    });
    expect(res.success).toBe(true);
  });

  it("rejects postOnly on a Market order", () => {
    const res = perpOrderSubmitSchema.safeParse({ ...baseInput, postOnly: true });
    expect(res.success).toBe(false);
  });

  it("requires a triggerPx for each trigger order type", () => {
    for (const orderType of [
      "StopMarket",
      "StopLimit",
      "TakeProfitMarket",
      "TakeProfitLimit",
    ] as const) {
      const res = perpOrderSubmitSchema.safeParse({
        ...baseInput,
        orderType,
        // Limit trigger types also need a limitPrice — supply it so the ONLY
        // failing rule is the missing triggerPx.
        limitPrice: "64000",
      });
      expect(res.success).toBe(false);
    }
  });

  it("requires a limitPrice for StopLimit and TakeProfitLimit (not for the market triggers)", () => {
    const stopLimitMissing = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "StopLimit",
      triggerPx: "60000",
    });
    expect(stopLimitMissing.success).toBe(false);

    const tpLimitMissing = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "TakeProfitLimit",
      triggerPx: "70000",
    });
    expect(tpLimitMissing.success).toBe(false);

    // Market trigger types need only triggerPx, no limitPrice.
    const stopMarketOk = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "StopMarket",
      triggerPx: "60000",
    });
    expect(stopMarketOk.success).toBe(true);
  });

  it("accepts a fully-specified StopLimit / TakeProfitLimit", () => {
    const stopLimit = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "StopLimit",
      triggerPx: "60000",
      limitPrice: "59900",
    });
    expect(stopLimit.success).toBe(true);
    const tpLimit = perpOrderSubmitSchema.safeParse({
      ...baseInput,
      orderType: "TakeProfitLimit",
      triggerPx: "70000",
      limitPrice: "70100",
    });
    expect(tpLimit.success).toBe(true);
  });
});

describe("toPlacePerpOrderRequest (trigger orders)", () => {
  it("passes triggerPx + orderType through for each trigger type", () => {
    const cases = [
      { orderType: "StopMarket" as const, triggerPx: "60000" },
      { orderType: "StopLimit" as const, triggerPx: "60000", limitPrice: "59900" },
      { orderType: "TakeProfitMarket" as const, triggerPx: "70000" },
      { orderType: "TakeProfitLimit" as const, triggerPx: "70000", limitPrice: "70100" },
    ];
    for (const c of cases) {
      const input = perpOrderSubmitSchema.parse({ ...baseInput, ...c });
      const req = toPlacePerpOrderRequest(input);
      expect(req.orderType).toBe(c.orderType);
      expect(req.triggerPx).toBe(c.triggerPx);
      if ("limitPrice" in c) {
        expect(req.limitPrice).toBe(c.limitPrice);
      }
    }
  });

  it("omits triggerPx for Market / Limit orders", () => {
    const market = toPlacePerpOrderRequest(perpOrderSubmitSchema.parse(baseInput));
    expect(market.triggerPx).toBeUndefined();
  });
});

describe("toPlacePerpOrderRequest", () => {
  it("maps isLong=true to side=long and reuses the cloid as clientOrderId", () => {
    const input = perpOrderSubmitSchema.parse(baseInput);
    const req = toPlacePerpOrderRequest(input);
    expect(req.side).toBe("long");
    expect(req.coin).toBe("BTC");
    expect(req.size).toBe("0.0125");
    expect(req.clientOrderId).toBe("perp-abc-123");
    expect(req.markPrice).toBe("65000.0");
    // size stays a string — never coerced to a float.
    expect(typeof req.size).toBe("string");
  });

  it("maps isLong=false to side=short", () => {
    const input = perpOrderSubmitSchema.parse({ ...baseInput, isLong: false });
    expect(toPlacePerpOrderRequest(input).side).toBe("short");
  });

  it("passes limitPrice through for Limit orders and omits markPrice when absent", () => {
    const input = perpOrderSubmitSchema.parse({
      coin: "SOL",
      isLong: true,
      marginMode: "cross",
      orderType: "Limit",
      sizeCoin: "3",
      limitPrice: "150.25",
      leverage: 3,
      cloid: "c2",
    });
    const req = toPlacePerpOrderRequest(input);
    expect(req.limitPrice).toBe("150.25");
    expect(req.markPrice).toBeUndefined();
  });
});

describe("cloid idempotency (submit input → place request → order row)", () => {
  it("reuses the same cloid as clientOrderId across the place request and the order row", () => {
    // The cloid is the single idempotency key: it becomes the HL cloid (broker
    // dedupe) AND the orders.clientOrderId (DB unique-index dedupe). Both paths
    // must carry the EXACT same value or a retried submit could double-place.
    const input = perpOrderSubmitSchema.parse(baseInput);
    const req = toPlacePerpOrderRequest(input);
    const row = toPerpOrderRow(input, "user-1", null);
    expect(req.clientOrderId).toBe("perp-abc-123");
    expect(row.clientOrderId).toBe("perp-abc-123");
    expect(req.clientOrderId).toBe(row.clientOrderId);
  });

  it("rejects an empty cloid so a submit can never land without an idempotency key", () => {
    expect(perpOrderSubmitSchema.safeParse({ ...baseInput, cloid: "" }).success).toBe(false);
  });
});

describe("perpTradeAction", () => {
  it("maps long→Buy and short→Sell", () => {
    expect(perpTradeAction(true)).toBe("Buy");
    expect(perpTradeAction(false)).toBe("Sell");
  });
});

describe("toPerpOrderRow", () => {
  it("writes the fractional size to quantityDecimal and NEVER the integer quantity", () => {
    const input = perpOrderSubmitSchema.parse(baseInput);
    const row = toPerpOrderRow(input, "user-1", null);
    expect(row.quantityDecimal).toBe("0.0125");
    // The INTEGER column is a placeholder 0 — the real (fractional) size must
    // never land there, or Postgres would truncate it.
    expect(row.quantity).toBe(0);
    expect(Number.isInteger(row.quantity)).toBe(true);
  });

  it("stamps venue=hyperliquid, assetType=PERP, and reuses the cloid", () => {
    const input = perpOrderSubmitSchema.parse(baseInput);
    const row = toPerpOrderRow(input, "user-1", "0xMaster");
    expect(row.venue).toBe("hyperliquid");
    expect(row.assetType).toBe("PERP");
    expect(row.clientOrderId).toBe("perp-abc-123");
    expect(row.brokerAccountId).toBe("0xMaster");
    expect(row.status).toBe("PENDING");
    expect(row.leverage).toBe(10);
    expect(row.marginMode).toBe("cross");
    expect(row.direction).toBe("long");
  });

  it("records direction=short and tradeAction=Sell for a short", () => {
    const input = perpOrderSubmitSchema.parse({ ...baseInput, isLong: false });
    const row = toPerpOrderRow(input, "user-1", null);
    expect(row.direction).toBe("short");
    expect(row.tradeAction).toBe("Sell");
  });

  it("persists the triggerPx into priceTrigger for trigger order types", () => {
    const input = perpOrderSubmitSchema.parse({
      ...baseInput,
      orderType: "StopMarket",
      triggerPx: "60000",
    });
    const row = toPerpOrderRow(input, "user-1", null);
    expect(row.orderType).toBe("StopMarket");
    expect(row.priceTrigger).toBe("60000");
  });

  it("leaves priceTrigger undefined for Market / Limit orders", () => {
    const row = toPerpOrderRow(perpOrderSubmitSchema.parse(baseInput), "user-1", null);
    expect(row.priceTrigger).toBeUndefined();
  });
});

describe("mapPositionRow (clearinghouseState → perp row, re-exported)", () => {
  const rawLong = {
    coin: "BTC",
    szi: "0.5",
    leverage: { type: "cross" as const, value: 10 },
    entryPx: "60000",
    liquidationPx: "55000",
    unrealizedPnl: "250.5",
    marginUsed: "3000",
    cumFunding: { allTime: "5", sinceOpen: "-1.25", sinceChange: "0" },
  };

  it("maps a positive szi to a long row with absolute size and mark from mids", () => {
    const row = mapPositionRow(rawLong, { BTC: "62000" });
    expect(row.side).toBe("long");
    expect(row.size).toBe("0.5");
    expect(row.markPx).toBe("62000");
    expect(row.entryPx).toBe("60000");
    expect(row.liquidationPx).toBe("55000");
    expect(row.leverage).toBe(10);
    expect(row.marginMode).toBe("cross");
    expect(row.funding).toBe("-1.25");
  });

  it("maps a negative szi to a short row with a positive absolute size", () => {
    const row = mapPositionRow({ ...rawLong, szi: "-2.0" }, { BTC: "62000" });
    expect(row.side).toBe("short");
    expect(row.size).toBe("2");
  });

  it("returns markPx=null when the coin is missing from mids", () => {
    const row = mapPositionRow(rawLong, {});
    expect(row.markPx).toBeNull();
  });
});
