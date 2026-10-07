import { describe, it, expect } from "bun:test";
import {
  orderSubmitSchema,
  symbolSchema,
  optionExpirationSchema,
  notesSchema,
  resolveOrderDirection,
} from "../routers/orders.js";

const baseOrder = {
  symbol: "aapl",
  assetType: "EQUITY" as const,
  orderType: "Market" as const,
  tradeAction: "Buy" as const,
  quantity: 1,
};

describe("symbolSchema (audit M7)", () => {
  it("uppercases and accepts normal, preferred, and OCC-length symbols", () => {
    expect(symbolSchema.parse("aapl")).toBe("AAPL");
    expect(symbolSchema.parse("BRK.B")).toBe("BRK.B");
    expect(symbolSchema.parse("BF-B")).toBe("BF-B");
    // Longest OCC option symbol shape (21 chars)
    expect(symbolSchema.parse("SPXW240119C04700000AB".slice(0, 21)).length).toBe(21);
  });

  it("rejects garbage that used to reach Alpaca as opaque 422s", () => {
    expect(() => symbolSchema.parse("")).toThrow();
    expect(() => symbolSchema.parse("A".repeat(22))).toThrow();
    expect(() => symbolSchema.parse("AAPL; DROP TABLE")).toThrow();
    expect(() => symbolSchema.parse("AA PL")).toThrow();
  });
});

describe("optionExpirationSchema (audit M7)", () => {
  it("accepts YYMMDD and undefined", () => {
    expect(optionExpirationSchema.parse("260119")).toBe("260119");
    expect(optionExpirationSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects other date shapes", () => {
    for (const bad of ["2026-01-19", "20260119", "26119", "Jan 19", "26011x"]) {
      expect(() => optionExpirationSchema.parse(bad)).toThrow();
    }
  });
});

describe("notesSchema (audit M7)", () => {
  it("caps notes at 2000 chars", () => {
    expect(notesSchema.parse("x".repeat(2000))).toHaveLength(2000);
    expect(() => notesSchema.parse("x".repeat(2001))).toThrow();
  });
});

describe("orderSubmitSchema integration", () => {
  it("accepts a plain valid order and uppercases the symbol", () => {
    const parsed = orderSubmitSchema.parse(baseOrder);
    expect(parsed.symbol).toBe("AAPL");
  });

  it("rejects a malformed option expiration on the submit path", () => {
    expect(() =>
      orderSubmitSchema.parse({
        ...baseOrder,
        assetType: "OPTION",
        optionExpiration: "2026-01-19",
        optionStrike: 190,
        optionType: "CALL",
      }),
    ).toThrow();
  });

  it("derives short direction for full short actions even when the request omits it", () => {
    expect(resolveOrderDirection("SellShort", "long")).toBe("short");
    expect(resolveOrderDirection("BuyToCover", "long")).toBe("short");
    expect(resolveOrderDirection("SellToOpen", "long")).toBe("short");
    expect(resolveOrderDirection("BuyToClose", "long")).toBe("short");
    expect(resolveOrderDirection("Buy", "short")).toBe("long");
    expect(resolveOrderDirection("Sell", "short")).toBe("long");
  });
});
