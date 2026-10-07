import { describe, test, expect } from "bun:test";
import {
  COPY_ACTION_LABEL,
  feedChartViewLabel,
  perpChartViewLabel,
  perpPrefillLabel,
  perpPrefillTitle,
  stockFromPerpPrefillTitle,
  stockPrefillLabel,
  stockPrefillTitle,
  tickerChipLabel,
  perpDisplayCoin,
} from "./ticker-chart-action";

describe("ticker chart action labels", () => {
  test("stockPrefillLabel formats the equity trade-form prefill label", () => {
    expect(stockPrefillLabel("AAPL")).toBe("Copy AAPL to the trade form");
    expect(stockPrefillLabel("NVDA")).toBe("Copy NVDA to the trade form");
  });

  test("perpPrefillLabel formats the perp trade-form prefill label", () => {
    expect(perpPrefillLabel("BTC")).toBe("Copy BTC perp into the perps trade form");
    expect(perpPrefillLabel("ETH")).toBe("Copy ETH perp into the perps trade form");
  });

  test("feedChartViewLabel formats the live chart aria-label", () => {
    expect(feedChartViewLabel("AAPL")).toBe("View $AAPL live chart");
    expect(feedChartViewLabel("SPY")).toBe("View $SPY live chart");
  });

  test("perpChartViewLabel names the perp chart, not the equity one", () => {
    // SOL is Solana on Hyperliquid and ReneSola on Nasdaq: the two chips can sit
    // in the same feed, so their chart actions cannot share a name.
    expect(perpChartViewLabel("SOL")).toBe("View $SOL perp live chart");
    expect(perpChartViewLabel("SOL")).not.toBe(feedChartViewLabel("SOL"));
    // HL coins are case-sensitive, so the label must not upper-case them.
    expect(perpChartViewLabel("kPEPE")).toBe("View $kPEPE perp live chart");
  });

  test("stockPrefillLabel and feedChartViewLabel produce distinct strings for the same symbol", () => {
    const symbol = "TSLA";
    expect(stockPrefillLabel(symbol)).not.toBe(feedChartViewLabel(symbol));
  });
});

describe("chip half labels", () => {
  test("the identity half shows the ticker itself", () => {
    expect(tickerChipLabel("NVDA")).toBe("$NVDA");
    // HL coins are case-sensitive, so the label must not upper-case them.
    expect(tickerChipLabel("kPEPE")).toBe("$kPEPE");
  });

  test("the intent half stays compact, and never claims to be the ticker", () => {
    expect(COPY_ACTION_LABEL).toBe("Copy");
    expect(COPY_ACTION_LABEL).not.toContain("$");
  });

  test("the equity tooltip names the trade form", () => {
    expect(stockPrefillTitle("NVDA")).toBe("Prefill the trade form with $NVDA");
  });

  test("the perp tooltip names the perp form and the direction/leverage", () => {
    expect(perpPrefillTitle("kPEPE", "20x Short")).toBe(
      "Prefill the perp trade form with kPEPE (20x Short)",
    );
  });

  test("the perp row's stock escape hatch names the stock form", () => {
    expect(stockFromPerpPrefillTitle("SOL")).toBe(
      "Prefill the stock trade form with SOL",
    );
    expect(stockFromPerpPrefillTitle("SOL")).not.toBe(perpPrefillTitle("SOL", "Long"));
  });
});

describe("perpDisplayCoin (venue namespace is not user-facing)", () => {
  test("strips Hyperliquid's stock-backed perp namespace for display", () => {
    // The canonical coin really is "xyz:GOOGL"; the user should read "GOOGL".
    expect(perpDisplayCoin("xyz:GOOGL")).toBe("GOOGL");
    expect(tickerChipLabel("xyz:GOOGL")).toBe("$GOOGL");
    expect(perpPrefillLabel("xyz:GOOGL")).toBe(
      "Copy GOOGL perp into the perps trade form",
    );
    expect(perpChartViewLabel("xyz:GOOGL")).toBe("View $GOOGL perp live chart");
  });

  test("leaves ordinary coins and equity tickers untouched", () => {
    expect(perpDisplayCoin("BTC")).toBe("BTC");
    expect(perpDisplayCoin("kPEPE")).toBe("kPEPE");
    expect(tickerChipLabel("NVDA")).toBe("$NVDA");
  });

  test("keeps a malformed prefix rather than rendering an empty chip", () => {
    expect(perpDisplayCoin("xyz:")).toBe("xyz:");
    expect(perpDisplayCoin("xyz:   ")).toBe("xyz:   ");
  });
});
