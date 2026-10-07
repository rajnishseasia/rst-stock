import { describe, it, expect } from "bun:test";
import { isCanonicalPerpCoin, parseCanonicalPerpCoin } from "./coin.js";

describe("parseCanonicalPerpCoin", () => {
  it("accepts main-DEX coins and preserves their case", () => {
    // HL's asset lookup is exact-match: "KPEPE" is a different (unknown) coin
    // from "kPEPE", so the parser must never normalize case.
    expect(parseCanonicalPerpCoin("BTC")).toBe("BTC");
    expect(parseCanonicalPerpCoin("kPEPE")).toBe("kPEPE");
    expect(parseCanonicalPerpCoin("HYPE")).toBe("HYPE");
    expect(parseCanonicalPerpCoin("1000BONK")).toBe("1000BONK");
  });

  it("accepts a HIP-3 builder coin and keeps the dex prefix", () => {
    // The prefix is the route to the builder's market. Dropping it would target
    // a completely different listing.
    expect(parseCanonicalPerpCoin("xyz:GOOGL")).toBe("xyz:GOOGL");
  });

  it("trims surrounding whitespace but nothing else", () => {
    expect(parseCanonicalPerpCoin("  BTC  ")).toBe("BTC");
    expect(parseCanonicalPerpCoin("BT C")).toBeNull();
  });

  it("rejects values Hyperliquid could not resolve as written", () => {
    for (const bad of [
      "BTC/USD",
      "BTC-PERP",
      "BTC_USD",
      "xyz:",
      ":GOOGL",
      "a:b:c",
      "BT\nC",
      "",
      "   ",
      "$BTC",
      "BTC;DROP TABLE orders",
      "A".repeat(21),
    ]) {
      expect(parseCanonicalPerpCoin(bad)).toBeNull();
    }
  });

  it("rejects non-strings rather than coercing them", () => {
    for (const bad of [null, undefined, 42, {}, [], true, { coin: "BTC" }]) {
      expect(parseCanonicalPerpCoin(bad)).toBeNull();
    }
  });

  it("accepts a coin exactly at the length limit", () => {
    expect(parseCanonicalPerpCoin("A".repeat(20))).toBe("A".repeat(20));
  });
});

describe("isCanonicalPerpCoin", () => {
  it("is true only for a value that is ALREADY canonical", () => {
    expect(isCanonicalPerpCoin("kPEPE")).toBe(true);
    expect(isCanonicalPerpCoin("xyz:GOOGL")).toBe(true);
    // Parseable after trimming, but not canonical as given: a caller holding
    // this string would send the untrimmed value to the venue.
    expect(isCanonicalPerpCoin(" BTC ")).toBe(false);
    expect(isCanonicalPerpCoin("BTC/USD")).toBe(false);
    expect(isCanonicalPerpCoin(null)).toBe(false);
    expect(isCanonicalPerpCoin(42)).toBe(false);
  });
});
