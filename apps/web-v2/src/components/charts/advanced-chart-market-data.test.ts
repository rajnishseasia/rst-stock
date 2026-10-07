import { describe, expect, test } from "bun:test";
import { perpMidsQueryInput } from "./perp-market-data";

describe("AdvancedChart perp market data", () => {
  test("scopes mids snapshots to the active HIP-3 coin", () => {
    expect(perpMidsQueryInput("xyz:GOOGL")).toEqual({ coin: "xyz:GOOGL" });
    expect(perpMidsQueryInput("kPEPE")).toEqual({ coin: "kPEPE" });
  });
});
