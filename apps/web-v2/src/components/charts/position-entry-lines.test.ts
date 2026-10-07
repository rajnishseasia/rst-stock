import { describe, expect, test } from "bun:test";

import {
  equityPositionEntryLines,
  perpPositionEntryLines,
} from "./position-entry-lines";

describe("equityPositionEntryLines", () => {
  test("draws active position entry price for the charted symbol", () => {
    const lines = equityPositionEntryLines(
      [{ symbol: "AAPL", qty: 10, avgEntryPrice: 185.5 }],
      "AAPL",
    );
    expect(lines).toEqual([
      {
        id: "eq:entry:AAPL:185.5",
        price: 185.5,
        label: "Avg Entry: $185.50",
      },
    ]);
  });

  test("ignores positions in other symbols", () => {
    const lines = equityPositionEntryLines(
      [
        { symbol: "TSLA", qty: 5, avgEntryPrice: 200 },
        { symbol: "AAPL", qty: 10, avgEntryPrice: 185 },
      ],
      "aapl",
    );
    expect(lines.map((l) => l.price)).toEqual([185]);
  });

  test("ignores zero or flat positions", () => {
    const lines = equityPositionEntryLines(
      [{ symbol: "AAPL", qty: 0, avgEntryPrice: 185.5 }],
      "AAPL",
    );
    expect(lines).toEqual([]);
  });

  test("rejects invalid or non-positive prices", () => {
    expect(
      equityPositionEntryLines(
        [{ symbol: "AAPL", qty: 10, avgEntryPrice: 0 }],
        "AAPL",
      ),
    ).toEqual([]);
  });
});

describe("perpPositionEntryLines", () => {
  test("draws active perp position entry price for the charted coin", () => {
    const lines = perpPositionEntryLines(
      [{ coin: "BTC", size: "0.5", entryPx: "77662.50", side: "long" }],
      "BTC",
    );
    expect(lines).toEqual([
      {
        id: "hl:entry:BTC:77662.5",
        price: 77662.5,
        label: "LONG Entry: $77,662.50",
        side: "long",
      },
    ]);
  });

  test("ignores positions on other coins", () => {
    const lines = perpPositionEntryLines(
      [{ coin: "ETH", size: "2", entryPx: "3000", side: "long" }],
      "BTC",
    );
    expect(lines).toEqual([]);
  });

  test("ignores zero size perp positions", () => {
    const lines = perpPositionEntryLines(
      [{ coin: "BTC", size: "0", entryPx: "60000", side: "long" }],
      "BTC",
    );
    expect(lines).toEqual([]);
  });
});
