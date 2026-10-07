/**
 * Input-schema coverage for the hyperliquid router's market-data procedures.
 *
 * HL coins are canonical case-sensitive spellings, and some carry a builder
 * prefix with a colon (xyz:GOOGL). These inputs previously used symbolSchema,
 * which uppercases and whose charset rejects ":", so prefixed coins could not
 * be queried at all. The router must accept the coin trim-only via
 * perpCoinSchema. Real-module tests: we parse through the actual procedure
 * input schemas pulled off the imported router.
 */
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { hyperliquidRouter } from "../routers/hyperliquid.js";

function coinInputSchema(procedureName: "assetSnapshot" | "candleSnapshot") {
  const procedure = (hyperliquidRouter as any)._def.procedures[procedureName];
  const input = procedure?._def?.inputs?.[0];
  if (!input) throw new Error(`${procedureName} has no input schema`);
  return input as z.ZodTypeAny;
}

describe("hyperliquid.assetSnapshot input", () => {
  const schema = coinInputSchema("assetSnapshot");

  it("preserves canonical HL casing and accepts prefixed coins", () => {
    expect(schema.parse({ coin: "kPEPE" })).toEqual({ coin: "kPEPE" });
    expect(schema.parse({ coin: "xyz:GOOGL" })).toEqual({ coin: "xyz:GOOGL" });
    expect(schema.parse({ coin: " kBONK " })).toEqual({ coin: "kBONK" });
    expect(schema.parse({ coin: "BTC" })).toEqual({ coin: "BTC" });
  });

  it("rejects empty and oversized coins", () => {
    expect(schema.safeParse({ coin: "" }).success).toBe(false);
    expect(schema.safeParse({ coin: "   " }).success).toBe(false);
    expect(schema.safeParse({ coin: "A".repeat(21) }).success).toBe(false);
  });
});

describe("hyperliquid.candleSnapshot input", () => {
  const schema = coinInputSchema("candleSnapshot");
  const base = { interval: "5m", startTime: 0 };

  it("preserves canonical HL casing and accepts prefixed coins", () => {
    expect(schema.parse({ ...base, coin: "kPEPE" }).coin).toBe("kPEPE");
    expect(schema.parse({ ...base, coin: "xyz:GOOGL" }).coin).toBe("xyz:GOOGL");
    expect(schema.parse({ ...base, coin: " kBONK " }).coin).toBe("kBONK");
  });

  it("rejects empty and oversized coins", () => {
    expect(schema.safeParse({ ...base, coin: "" }).success).toBe(false);
    expect(schema.safeParse({ ...base, coin: "A".repeat(21) }).success).toBe(false);
  });
});
