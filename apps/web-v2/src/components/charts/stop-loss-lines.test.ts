import { describe, expect, test } from "bun:test";

import {
  MAX_STOP_LOSS_LINES,
  equityStopLossLines,
  perpStopLossLines,
} from "./stop-loss-lines";

describe("equityStopLossLines", () => {
  test("draws the resting stop for the charted symbol", () => {
    const lines = equityStopLossLines(
      [{ symbol: "AAPL", stopLossOrders: [{ stopPrice: 185.5 }] }],
      "AAPL",
    );
    expect(lines).toEqual([
      { id: "eq:AAPL:185.5", price: 185.5, label: "SL", trailing: false },
    ]);
  });

  test("ignores positions in other symbols", () => {
    const lines = equityStopLossLines(
      [
        { symbol: "TSLA", stopLossOrders: [{ stopPrice: 200 }] },
        { symbol: "AAPL", stopLossOrders: [{ stopPrice: 185 }] },
      ],
      "aapl",
    );
    expect(lines.map((l) => l.price)).toEqual([185]);
  });

  test("labels a trailing stop as one", () => {
    const lines = equityStopLossLines(
      [{ symbol: "AAPL", trailingStopOrders: [{ stopPrice: 180 }] }],
      "AAPL",
    );
    expect(lines[0]?.label).toBe("Trailing SL");
    expect(lines[0]?.trailing).toBe(true);
  });

  test("skips a trailing stop the broker has not priced yet", () => {
    // A trailing stop with no computed stop price has no level to draw. Drawing
    // it at zero would put a "you are protected here" line at the bottom of the
    // pane, which is worse than drawing nothing.
    expect(
      equityStopLossLines(
        [{ symbol: "AAPL", trailingStopOrders: [{ stopPrice: null }] }],
        "AAPL",
      ),
    ).toEqual([]);
  });

  test("collapses duplicate levels into one line", () => {
    const lines = equityStopLossLines(
      [
        { symbol: "AAPL", stopLossOrders: [{ stopPrice: 185 }, { stopPrice: 185 }] },
        { symbol: "AAPL", stopLossOrders: [{ stopPrice: 185 }] },
      ],
      "AAPL",
    );
    expect(lines).toHaveLength(1);
  });

  test("a trailing stop wins a tie at the same price", () => {
    const lines = equityStopLossLines(
      [
        {
          symbol: "AAPL",
          stopLossOrders: [{ stopPrice: 185 }],
          trailingStopOrders: [{ stopPrice: 185 }],
        },
      ],
      "AAPL",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.label).toBe("Trailing SL");
  });

  test("caps the pane at a readable number of lines, highest first", () => {
    const lines = equityStopLossLines(
      [
        {
          symbol: "AAPL",
          stopLossOrders: Array.from({ length: 20 }, (_, i) => ({ stopPrice: 100 + i })),
        },
      ],
      "AAPL",
    );
    expect(lines).toHaveLength(MAX_STOP_LOSS_LINES);
    expect(lines[0]?.price).toBe(119);
  });

  test("rejects non-positive and non-finite prices", () => {
    expect(
      equityStopLossLines(
        [{ symbol: "AAPL", stopLossOrders: [{ stopPrice: 0 }, { stopPrice: -5 }, { stopPrice: Number.NaN }] }],
        "AAPL",
      ),
    ).toEqual([]);
  });

  test("an empty chart symbol draws nothing", () => {
    expect(
      equityStopLossLines([{ symbol: "AAPL", stopLossOrders: [{ stopPrice: 1 }] }], "  "),
    ).toEqual([]);
  });

  test("ids are stable across repeated folds", () => {
    const positions = [{ symbol: "AAPL", stopLossOrders: [{ stopPrice: 185.5 }] }];
    expect(equityStopLossLines(positions, "AAPL")[0]?.id).toBe(
      equityStopLossLines(positions, "AAPL")[0]?.id ?? "",
    );
  });
});

describe("perpStopLossLines", () => {
  const slOrder = {
    coin: "BTC",
    triggerPx: "60000.5",
    tpsl: "sl" as const,
    isTrigger: true,
  };

  test("draws a resting stop trigger for the charted coin", () => {
    expect(perpStopLossLines([slOrder], "BTC")).toEqual([
      { id: "hl:BTC:60000.5", price: 60000.5, label: "SL", trailing: false },
    ]);
  });

  test("never draws a take-profit in the stop-loss color", () => {
    // Inverting this is the single worst thing this module could do: a TP drawn
    // as a stop reads as downside protection sitting above the mark.
    expect(
      perpStopLossLines([{ ...slOrder, tpsl: "tp", triggerPx: "70000" }], "BTC"),
    ).toEqual([]);
  });

  test("ignores plain resting limit orders", () => {
    expect(
      perpStopLossLines([{ ...slOrder, isTrigger: false, tpsl: null }], "BTC"),
    ).toEqual([]);
  });

  test("ignores stops on other coins", () => {
    expect(perpStopLossLines([{ ...slOrder, coin: "ETH" }], "BTC")).toEqual([]);
  });

  test("skips a trigger order with no trigger price", () => {
    expect(perpStopLossLines([{ ...slOrder, triggerPx: null }], "BTC")).toEqual([]);
  });

  test("collapses duplicates and caps the pane", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...slOrder,
      triggerPx: String(60000 + i),
    }));
    expect(perpStopLossLines([...many, ...many], "BTC")).toHaveLength(MAX_STOP_LOSS_LINES);
  });
});
