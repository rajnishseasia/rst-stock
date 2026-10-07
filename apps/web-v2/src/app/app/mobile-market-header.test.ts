import { describe, expect, test } from "bun:test";

import { formatPerpQuote } from "@/components/perps/perp-format";
import {
  describeMobileMarketHeader,
  getMobileQuoteTone,
} from "./mobile-market-header";
import { tradeSheetLabel } from "./trade-sheet";

/** What `formatPerpQuote` hands the shell when Hyperliquid has answered. */
const PERP_QUOTE = formatPerpQuote({
  markPx: "1234.5",
  prevDayPx: "1200",
  bid: "1234",
  ask: "1235",
});
/** And when it has not: every field is "-", tone neutral. */
const NO_PERP_QUOTE = formatPerpQuote(undefined);

describe("getMobileQuoteTone", () => {
  test("colors a real move by its sign", () => {
    expect(getMobileQuoteTone("1.24")).toBe("positive");
    expect(getMobileQuoteTone("-1.24")).toBe("negative");
  });

  test("an unknown or flat change is neutral, never green", () => {
    // Green on a value we do not have reads as a gain that did not happen.
    expect(getMobileQuoteTone(undefined)).toBe("neutral");
    expect(getMobileQuoteTone(null)).toBe("neutral");
    expect(getMobileQuoteTone("")).toBe("neutral");
    expect(getMobileQuoteTone("n/a")).toBe("neutral");
    expect(getMobileQuoteTone("0")).toBe("neutral");
  });
});

describe("describeMobileMarketHeader: the equity side", () => {
  test("states price and change through the shared formatters", () => {
    const header = describeMobileMarketHeader({
      marketSymbol: "NVDA",
      isPerps: false,
      perpQuote: PERP_QUOTE,
      stockQuote: { last: "184.32", changePercent: "-1.24" },
    });

    expect(header.symbol).toBe("NVDA");
    expect(header.quoteLine).toBe("$184.32 · -1.24%");
    expect(header.tone).toBe("negative");
  });

  test("never shows the perp tag, and never a perps price", () => {
    // Both subscriptions live on the shell, so the perp quote is always in hand.
    // Reading it here would print a Hyperliquid mark under an Alpaca ticker.
    const header = describeMobileMarketHeader({
      marketSymbol: "NVDA",
      isPerps: false,
      perpQuote: PERP_QUOTE,
      stockQuote: { last: "184.32", changePercent: "-1.24" },
    });

    expect(header.showPerpTag).toBe(false);
    expect(header.quoteLine).not.toContain("1,234.50");
  });

  test("a quote that has not arrived renders placeholders, not a stale price", () => {
    const header = describeMobileMarketHeader({
      marketSymbol: "NVDA",
      isPerps: false,
      perpQuote: PERP_QUOTE,
      stockQuote: undefined,
    });

    expect(header.quoteLine).toBe("- · -");
    expect(header.tone).toBe("neutral");
  });
});

describe("describeMobileMarketHeader: the perps side", () => {
  test("uses the perps formatter, whose precision scales with magnitude", () => {
    const header = describeMobileMarketHeader({
      marketSymbol: "ETH",
      isPerps: true,
      perpQuote: PERP_QUOTE,
      stockQuote: undefined,
    });

    expect(header.symbol).toBe("ETH");
    expect(header.showPerpTag).toBe(true);
    // Percentage only. `formatPerpQuote` dropped the absolute dollar leg from
    // `dayChange` in 8ed7e1e; the header composes that field verbatim, so the
    // narrow phone line follows it rather than restating the amount.
    expect(header.quoteLine).toBe("$1,234.50 · +2.88%");
    expect(header.tone).toBe("positive");
  });

  test("strips Hyperliquid's namespace for display", () => {
    // The canonical coin is "xyz:GOOGL" and stays that way in every payload;
    // only the header text loses the prefix.
    const header = describeMobileMarketHeader({
      marketSymbol: "xyz:GOOGL",
      isPerps: true,
      perpQuote: PERP_QUOTE,
      stockQuote: undefined,
    });

    expect(header.symbol).toBe("GOOGL");
  });

  test("an empty snapshot is neutral placeholders, not a zero price", () => {
    const header = describeMobileMarketHeader({
      marketSymbol: "ETH",
      isPerps: true,
      perpQuote: NO_PERP_QUOTE,
      stockQuote: { last: "184.32", changePercent: "5.00" },
    });

    // And it does not fall back to the equity quote that happens to be in hand.
    expect(header.quoteLine).toBe("- · -");
    expect(header.tone).toBe("neutral");
    expect(header.showPerpTag).toBe(true);
  });
});

describe("the venue is the only thing distinguishing a namespaced perp", () => {
  const perp = describeMobileMarketHeader({
    marketSymbol: "xyz:GOOGL",
    isPerps: true,
    perpQuote: PERP_QUOTE,
    stockQuote: undefined,
  });
  const equity = describeMobileMarketHeader({
    marketSymbol: "GOOGL",
    isPerps: false,
    perpQuote: PERP_QUOTE,
    stockQuote: { last: "184.32", changePercent: "-1.24" },
  });

  test("both headers show the same ticker text", () => {
    expect(perp.symbol).toBe(equity.symbol);
  });

  test("so the tag carries the whole distinction on screen", () => {
    // Leverage, funding and liquidation exist on exactly one of these. If the
    // tag ever stops being venue-driven, a 20x perp and 100 shares become
    // indistinguishable in the sheet that is about to take an order.
    expect(perp.showPerpTag).toBe(true);
    expect(equity.showPerpTag).toBe(false);
  });

  test("and the accessible name says it too, for anyone not seeing the tag", () => {
    expect(tradeSheetLabel({ symbol: perp.symbol, isPerps: true })).toBe(
      "Trade GOOGL perpetual",
    );
    expect(tradeSheetLabel({ symbol: equity.symbol, isPerps: false })).toBe(
      "Trade GOOGL",
    );
  });
});
