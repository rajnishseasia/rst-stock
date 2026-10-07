import { describe, expect, test } from "bun:test";
import { parseStoredSizing } from "./copy-trade-persistence";
import { SIZING_MODE_PRESENTATION } from "./mirror-sizing";

describe("copy-trade sizing persistence", () => {
  test("round-trips every production sizing mode", () => {
    const values = { usd: 25, pct: 25, pct_equity: 25, ratio: 2 } as const;
    for (const mode of ["usd", "pct", "pct_equity", "ratio"] as const) {
      expect(parseStoredSizing(JSON.stringify({ mode, value: values[mode] }), 5)).toEqual({
        mode,
        value: values[mode],
      });
    }
  });

  test("maps unknown sizing modes to zero exposure", () => {
    expect(parseStoredSizing('{"mode":"unknown","value":25}', 5)).toEqual({
      mode: "pct",
      value: 0,
    });
  });

  test("returns null only for a missing stored value", () => {
    expect(parseStoredSizing(null, 5)).toBeNull();
    expect(parseStoredSizing("", 5)).toEqual({ mode: "pct", value: 0 });
    expect(parseStoredSizing("{not json", 5)).toEqual({ mode: "pct", value: 0 });
  });

  test("rejects coerced, zero, negative, and out-of-range values", () => {
    for (const value of [true, "25", 0, -1, SIZING_MODE_PRESENTATION.usd.max + 1]) {
      expect(parseStoredSizing(JSON.stringify({ mode: "usd", value }), 5)).toEqual({
        mode: "usd",
        value: 0,
      });
    }
  });

  test("accepts each production mode's bounds", () => {
    for (const mode of ["usd", "pct", "pct_equity", "ratio"] as const) {
      const { min, max } = SIZING_MODE_PRESENTATION[mode];
      expect(parseStoredSizing(JSON.stringify({ mode, value: min }), 5)).toEqual({ mode, value: min });
      expect(parseStoredSizing(JSON.stringify({ mode, value: max }), 5)).toEqual({ mode, value: max });
    }
  });
});
