import { describe, it, expect } from "bun:test";
import { buildOptionsSymbol } from "../lib/options";

describe("OSI Symbol Builder", () => {
  it("should build a COMPACT OSI string for a short symbol (no space padding)", () => {
    const symbol = buildOptionsSymbol("AAPL", "220916", 150, "CALL");
    expect(symbol).toBe("AAPL220916C00150000");
  });

  it("should build a compact OSI string for a 5-char symbol with a dot", () => {
    const symbol = buildOptionsSymbol("BRK.B", "220916", 150, "PUT");
    expect(symbol).toBe("BRK.B220916P00150000");
  });

  it("should correctly format fractional strikes", () => {
    const symbol = buildOptionsSymbol("TSLA", "220916", 150.5, "CALL");
    // 150.5 * 1000 = 150500 => 00150500
    expect(symbol).toBe("TSLA220916C00150500");
  });

  it("should keep the root verbatim (no padEnd, no slicing)", () => {
    // The compact form keeps the root exactly as provided (uppercased/trimmed).
    const symbol = buildOptionsSymbol("TOOLONG", "220916", 10, "CALL");
    expect(symbol).toBe("TOOLONG220916C00010000");
  });
});
