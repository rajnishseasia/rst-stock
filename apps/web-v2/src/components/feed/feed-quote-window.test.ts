import { describe, expect, test } from "bun:test";

import {
  MAX_QUOTE_SYMBOLS,
  QUOTE_ANCHOR_STEP,
  quantizeFeedAnchor,
  quoteWindowSymbols,
} from "./feed-quote-window";

/** A feed of `count` rows, each with one distinct ticker: S0, S1, S2 ... */
function rows(count: number): string[][] {
  return Array.from({ length: count }, (_, i) => [`S${i}`]);
}

describe("quantizeFeedAnchor", () => {
  test("rounds down to the step so scrolling does not churn the query key", () => {
    expect(quantizeFeedAnchor(0)).toBe(0);
    expect(quantizeFeedAnchor(9)).toBe(0);
    expect(quantizeFeedAnchor(10)).toBe(10);
    expect(quantizeFeedAnchor(19)).toBe(10);
    expect(quantizeFeedAnchor(QUOTE_ANCHOR_STEP * 3 + 1)).toBe(
      QUOTE_ANCHOR_STEP * 3,
    );
  });

  test("clamps nonsense to the top of the list", () => {
    expect(quantizeFeedAnchor(-5)).toBe(0);
    expect(quantizeFeedAnchor(Number.NaN)).toBe(0);
  });
});

describe("quoteWindowSymbols", () => {
  test("never exceeds the router's batch cap", () => {
    const symbols = quoteWindowSymbols(rows(150), { anchorIndex: 0 });
    expect(symbols.length).toBe(MAX_QUOTE_SYMBOLS);
  });

  test("prices the rows the reader is on, not just the top of the list", () => {
    // The defect A13 fixes: at row 100 of a 150-row feed every visible equity
    // chip used to render with no price, because the budget was spent on rows
    // 0-29.
    const symbols = quoteWindowSymbols(rows(150), { anchorIndex: 100 });
    expect(symbols).toContain("S100");
    expect(symbols).toContain("S110");
    expect(symbols).not.toContain("S0");
  });

  test("keeps a few rows above the anchor priced", () => {
    const symbols = quoteWindowSymbols(rows(150), {
      anchorIndex: 100,
      lookBack: 4,
    });
    expect(symbols).toContain("S96");
    expect(symbols).not.toContain("S95");
  });

  test("spends the leftover budget backward at the end of the feed", () => {
    // Anchored on the last row, forward only yields one symbol. The rest of the
    // budget goes to the rows just above, not to row 0.
    const symbols = quoteWindowSymbols(rows(40), {
      anchorIndex: 39,
      lookBack: 0,
    });
    expect(symbols.length).toBe(MAX_QUOTE_SYMBOLS);
    expect(symbols).toContain("S39");
    expect(symbols).toContain("S11");
    expect(symbols).not.toContain("S9");
  });

  test("dedupes and uppercases across rows", () => {
    const symbols = quoteWindowSymbols(
      [["nvda", "AMZN"], ["NVDA"], [" nvda "], []],
      { anchorIndex: 0 },
    );
    expect(symbols).toEqual(["NVDA", "AMZN"]);
  });

  test("drops empty symbols instead of sending them to the router", () => {
    expect(quoteWindowSymbols([["", "  ", "TSLA"]], { anchorIndex: 0 })).toEqual([
      "TSLA",
    ]);
  });

  test("is empty for an empty feed or a zero budget", () => {
    expect(quoteWindowSymbols([], { anchorIndex: 0 })).toEqual([]);
    expect(quoteWindowSymbols(rows(5), { anchorIndex: 0, cap: 0 })).toEqual([]);
  });

  test("an out-of-range anchor still prices the tail of the list", () => {
    const symbols = quoteWindowSymbols(rows(5), { anchorIndex: 900 });
    expect(symbols).toContain("S4");
  });
});
