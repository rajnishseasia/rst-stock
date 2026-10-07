import { describe, expect, test } from "bun:test";

import { perpFillsForChart } from "./perp-chart-annotations";

const fills = [
  {
    time: 1_720_000_000_000,
    coin: "xyz:JPY",
    side: "sell" as const,
    px: "163.685",
    sz: "100",
    dir: "Open Short",
    oid: 42,
    tid: 7,
    hash: "0xabc",
  },
  {
    time: 1_720_000_100_000,
    coin: "BTC",
    side: "buy" as const,
    px: "68000",
    sz: "0.1",
    dir: "Open Long",
    oid: 43,
    tid: 8,
    hash: "0xdef",
  },
];

describe("perpFillsForChart", () => {
  test("maps only fills for the active canonical perp coin", () => {
    expect(perpFillsForChart(fills, "xyz:JPY")).toEqual([
      {
        id: "perp:0xabc:7",
        anchorTime: 1_720_000_000,
        anchorPrice: 163.685,
        side: "SELL",
        quantity: 100,
        orderType: "Perp",
        tradeAction: "Open Short",
      },
    ]);
  });

  test("matches canonical coin casing without conflating another market", () => {
    expect(perpFillsForChart(fills, "XYZ:jpy")).toHaveLength(1);
    expect(perpFillsForChart(fills, "JPY")).toHaveLength(0);
  });

  test("drops malformed fills instead of drawing misleading bubbles", () => {
    expect(
      perpFillsForChart(
        [{ ...fills[0]!, px: "not-a-price" }, { ...fills[0]!, sz: "0" }],
        "xyz:JPY",
      ),
    ).toEqual([]);
  });
});
