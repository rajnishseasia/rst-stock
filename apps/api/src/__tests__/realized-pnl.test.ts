import { describe, it, expect } from "bun:test";
import {
  computeClosedOrderDisplayQty,
  computeRealizedPnlByOrder,
  computeRealizedPnlSinceOpen,
  resolveRealizedPnl,
} from "../routers/positions.js";

/** Build a filled order with sane defaults; override what a case needs. */
function order(
  id: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  opts: { symbol?: string; at?: string; status?: string; assetClass?: string } = {}
) {
  return {
    id,
    symbol: opts.symbol ?? "AAPL",
    side,
    filled_qty: String(qty),
    filled_avg_price: String(price),
    filled_at: opts.at ?? `2026-01-01T00:00:0${id.length}Z`,
    submitted_at: opts.at ?? `2026-01-01T00:00:0${id.length}Z`,
    status: opts.status ?? "filled",
    asset_class: opts.assetClass ?? "us_equity",
  };
}

describe("computeRealizedPnlByOrder", () => {
  it("values a simple long round-trip on the closing sell", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 2, 100, { at: "2026-01-01T00:00:01Z" }),
      order("2", "sell", 2, 110, { at: "2026-01-01T00:00:02Z" }),
    ]);
    expect(pnl.get("2")).toBeCloseTo(20); // (110-100)*2
    expect(pnl.has("1")).toBe(false); // opening fill carries no realized P&L
  });

  it("values a partial close on the matched quantity only", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 10, 100, { at: "2026-01-01T00:00:01Z" }),
      order("2", "sell", 4, 110, { at: "2026-01-01T00:00:02Z" }),
    ]);
    expect(pnl.get("2")).toBeCloseTo(40); // (110-100)*4
  });

  it("values a short round-trip on the closing buy", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "sell", 5, 50, { at: "2026-01-01T00:00:01Z" }),
      order("2", "buy", 5, 40, { at: "2026-01-01T00:00:02Z" }),
    ]);
    expect(pnl.get("2")).toBeCloseTo(50); // (50-40)*5
  });

  it("applies the 100x multiplier for options", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 1, 2.0, { at: "2026-01-01T00:00:01Z", assetClass: "us_option" }),
      order("2", "sell", 1, 3.0, { at: "2026-01-01T00:00:02Z", assetClass: "us_option" }),
    ]);
    expect(pnl.get("2")).toBeCloseTo(100); // (3-2)*1*100
  });

  it("pairs FIFO across multiple entry lots", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 1, 100, { at: "2026-01-01T00:00:01Z" }),
      order("2", "buy", 1, 200, { at: "2026-01-01T00:00:02Z" }),
      order("3", "sell", 2, 250, { at: "2026-01-01T00:00:03Z" }),
    ]);
    expect(pnl.get("3")).toBeCloseTo(200); // (250-100) + (250-200)
  });

  it("handles a position flip (long -> short) in one fill", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 5, 100, { at: "2026-01-01T00:00:01Z" }),
      order("2", "sell", 8, 110, { at: "2026-01-01T00:00:02Z" }), // close 5 long, open 3 short
      order("3", "buy", 3, 105, { at: "2026-01-01T00:00:03Z" }), // close the 3 short
    ]);
    expect(pnl.get("2")).toBeCloseTo(50); // (110-100)*5 realized; the extra 3 opens a short
    expect(pnl.get("3")).toBeCloseTo(15); // (110-105)*3
  });

  it("keeps symbols independent", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 1, 100, { symbol: "AAPL", at: "2026-01-01T00:00:01Z" }),
      order("2", "buy", 1, 50, { symbol: "MSFT", at: "2026-01-01T00:00:02Z" }),
      order("3", "sell", 1, 120, { symbol: "AAPL", at: "2026-01-01T00:00:03Z" }),
    ]);
    expect(pnl.get("3")).toBeCloseTo(20);
    expect(pnl.size).toBe(1); // only the AAPL close realized
  });

  it("ignores unfilled (canceled/expired) orders", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 2, 100, { at: "2026-01-01T00:00:01Z" }),
      { ...order("2", "sell", 2, 110, { at: "2026-01-01T00:00:02Z" }), status: "canceled", filled_qty: "0", filled_avg_price: null },
    ]);
    expect(pnl.has("2")).toBe(false);
  });

  it("counts a partial fill that was later canceled/expired (filled_qty > 0)", () => {
    const pnl = computeRealizedPnlByOrder([
      order("1", "buy", 2, 100, { at: "2026-01-01T00:00:01Z" }),
      // Limit sell that filled 1 of 2 shares, then got canceled — the executed
      // share still realizes P&L even though the final status isn't "filled".
      { ...order("2", "sell", 1, 110, { at: "2026-01-01T00:00:02Z" }), status: "canceled" },
    ]);
    expect(pnl.get("2")).toBeCloseTo(10); // (110-100)*1
  });
});

describe("computeClosedOrderDisplayQty", () => {
  it("shows requested quantity for an unfilled canceled order", () => {
    expect(computeClosedOrderDisplayQty({ filled_qty: "0", qty: "2" })).toBe(2);
  });

  it("shows executed quantity for filled and partially-filled orders", () => {
    expect(computeClosedOrderDisplayQty({ filled_qty: "3", qty: "5" })).toBe(3);
  });
});

/** Timestamps must order the replay, so give each fill an explicit second. */
function at(second: number): string {
  return `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
}

describe("computeRealizedPnlSinceOpen", () => {
  it("banks the realized P&L of a scale-out onto the still-open position", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "buy", 10, 100, { at: at(1) }),
      order("b", "sell", 4, 120, { at: at(2) }),
    ]);

    expect(runs.get("AAPL")).toEqual({
      qty: 6,
      realizedPnl: 80,
      openedAt: new Date(at(1)).getTime(),
    });
  });

  it("reports zero for a position that has never been reduced", () => {
    const runs = computeRealizedPnlSinceOpen([order("a", "buy", 10, 100, { at: at(1) })]);
    expect(runs.get("AAPL")?.realizedPnl).toBe(0);
  });

  it("drops the symbol once the position is fully closed", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "buy", 10, 100, { at: at(1) }),
      order("b", "sell", 10, 120, { at: at(2) }),
    ]);
    expect(runs.has("AAPL")).toBe(false);
  });

  it("does not carry the previous round-trip's P&L into the next position", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "buy", 10, 100, { at: at(1) }),
      order("b", "sell", 10, 120, { at: at(2) }),
      order("c", "buy", 5, 130, { at: at(3) }),
    ]);

    expect(runs.get("AAPL")).toEqual({
      qty: 5,
      realizedPnl: 0,
      openedAt: new Date(at(3)).getTime(),
    });
  });

  it("starts a flip's new run from zero", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "buy", 10, 100, { at: at(1) }),
      order("b", "sell", 15, 120, { at: at(2) }),
    ]);

    expect(runs.get("AAPL")).toEqual({
      qty: -5,
      realizedPnl: 0,
      openedAt: new Date(at(2)).getTime(),
    });
  });

  it("tracks a short run's realized P&L and signs its quantity", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "sell", 10, 100, { at: at(1) }),
      order("b", "buy", 4, 90, { at: at(2) }),
    ]);

    expect(runs.get("AAPL")).toMatchObject({ qty: -6, realizedPnl: 40 });
  });

  it("keeps symbols independent", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "buy", 10, 100, { at: at(1) }),
      order("b", "sell", 5, 120, { at: at(2) }),
      order("c", "buy", 2, 50, { symbol: "MSFT", at: at(3) }),
    ]);

    expect(runs.get("AAPL")?.realizedPnl).toBe(100);
    expect(runs.get("MSFT")?.realizedPnl).toBe(0);
  });

  it("applies the option contract multiplier", () => {
    const runs = computeRealizedPnlSinceOpen([
      order("a", "buy", 2, 5, { assetClass: "us_option", at: at(1) }),
      order("b", "sell", 1, 7, { assetClass: "us_option", at: at(2) }),
    ]);

    expect(runs.get("AAPL")?.realizedPnl).toBe(200);
  });
});

describe("resolveRealizedPnl", () => {
  const runs = computeRealizedPnlSinceOpen([
    order("a", "buy", 10, 100, { at: at(1) }),
    order("b", "sell", 4, 120, { at: at(2) }),
  ]);

  it("returns the banked P&L when the replay matches the live position", () => {
    expect(resolveRealizedPnl(runs, { symbol: "AAPL", qty: "6", side: "long" })).toBe(80);
  });

  it("returns null when the live position is larger than the replayed run", () => {
    // The opening fills fell outside the fetched window, so 80 would understate.
    expect(resolveRealizedPnl(runs, { symbol: "AAPL", qty: "20", side: "long" })).toBeNull();
  });

  it("returns null when the live side disagrees with the replayed run", () => {
    expect(resolveRealizedPnl(runs, { symbol: "AAPL", qty: "6", side: "short" })).toBeNull();
  });

  it("returns null for a symbol the replay never saw", () => {
    expect(resolveRealizedPnl(runs, { symbol: "TSLA", qty: "1", side: "long" })).toBeNull();
  });

  it("accepts Alpaca's negative quantity on a short position", () => {
    const shortRuns = computeRealizedPnlSinceOpen([
      order("a", "sell", 10, 100, { at: at(1) }),
      order("b", "buy", 4, 90, { at: at(2) }),
    ]);

    expect(resolveRealizedPnl(shortRuns, { symbol: "AAPL", qty: "-6", side: "short" })).toBe(40);
  });

  it("tolerates fractional-share rounding between replay and broker", () => {
    const fractionalRuns = computeRealizedPnlSinceOpen([
      order("a", "buy", 1.5, 100, { at: at(1) }),
    ]);

    expect(
      resolveRealizedPnl(fractionalRuns, { symbol: "AAPL", qty: "1.5000000001", side: "long" }),
    ).toBe(0);
  });
});
