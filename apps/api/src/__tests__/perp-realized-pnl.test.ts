import { describe, expect, test } from "bun:test";
import { realizedPnlForOpenPerps, type KnownPerpFill } from "../lib/perp-realized-pnl.js";

function fill(symbol: string, tradeAction: "Buy" | "Sell", size: string, pnl: string, time: number): KnownPerpFill {
  return { symbol, tradeAction, executedSizeDecimal: size, realizedPnl: pnl, executedAt: new Date(time) };
}

describe("realizedPnlForOpenPerps", () => {
  test("counts only closes after the latest opening fill", () => {
    const result = realizedPnlForOpenPerps([
      fill("ETHFI", "Buy", "4474.1", "0", 1),
      fill("ETHFI", "Sell", "1118.5", "24.364056", 2),
      fill("ETHFI", "Buy", "3926.7", "0", 3),
      fill("ETHFI", "Sell", "3186", "100.306336", 4),
    ], [{ coin: "ETHFI", side: "long", size: "4096.3" }]);
    expect(result.get("ETHFI")).toBeCloseTo(100.306336, 8);
  });

  test("returns zero when there are no closes after the latest open", () => {
    const result = realizedPnlForOpenPerps([
      fill("BTC", "Buy", "2", "0", 1),
      fill("BTC", "Sell", "2", "50", 2),
      fill("BTC", "Buy", "1", "0", 3),
    ], [{ coin: "BTC", side: "long", size: "1" }]);
    expect(result.get("BTC")).toBe(0);
  });

  test("returns null when the database has no opening fill", () => {
    const result = realizedPnlForOpenPerps(
      [fill("ETHFI", "Sell", "3186", "100.306336", 4)],
      [{ coin: "ETHFI", side: "long", size: "4096.3" }],
    );
    expect(result.get("ETHFI")).toBeNull();
  });

  test("does not double count exact duplicate reconciliation rows", () => {
    const close = fill("INIT", "Sell", "65023", "181.513838", 2);
    const result = realizedPnlForOpenPerps(
      [fill("INIT", "Buy", "152995", "0", 1), close, { ...close }],
      [{ coin: "INIT", side: "long", size: "87972" }],
    );
    expect(result.get("INIT")).toBeCloseTo(181.513838, 8);
  });
});
