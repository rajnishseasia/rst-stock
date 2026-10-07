import { describe, it, expect } from "bun:test";
import {
  buildTradeIdeaReadout,
  type TradeIdeaBar,
} from "../lib/chat/tools/lib/trade-idea.js";

function bars(closes: number[]): TradeIdeaBar[] {
  return closes.map((c) => ({ o: c, h: c + 1, l: c - 1, c, v: 1000 }));
}

describe("buildTradeIdeaReadout", () => {
  it("classifies a steady uptrend as 'up'", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i); // 100..129
    const r = buildTradeIdeaReadout({
      symbol: "nvda",
      bars: bars(closes),
      quote: { last: 129, bid: 128.9, ask: 129.1, dayHigh: 130, dayLow: 128 },
    });
    expect(r.symbol).toBe("NVDA");
    expect(r.trend.direction).toBe("up");
    expect(r.trend.shortSma).not.toBeNull();
    expect(r.trend.longSma).not.toBeNull();
    expect(r.trend.changePct).toBeGreaterThan(0);
    // Latest price near the top of the range.
    expect(r.trend.rangePosition).toBeGreaterThan(0.9);
    expect(r.price).toBe(129);
  });

  it("classifies a steady downtrend as 'down'", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 130 - i); // 130..101
    const r = buildTradeIdeaReadout({ symbol: "TSLA", bars: bars(closes) });
    expect(r.trend.direction).toBe("down");
    expect(r.trend.changePct).toBeLessThan(0);
  });

  it("classifies a flat tape as 'sideways'", () => {
    const closes = Array.from({ length: 30 }, () => 100);
    const r = buildTradeIdeaReadout({ symbol: "KO", bars: bars(closes) });
    expect(r.trend.direction).toBe("sideways");
    expect(r.trend.changePct).toBe(0);
  });

  it("reports 'unknown' trend with too few bars", () => {
    const r = buildTradeIdeaReadout({ symbol: "ABC", bars: bars([10, 11]) });
    expect(r.trend.direction).toBe("unknown");
    expect(r.trend.barsAnalyzed).toBe(2);
  });

  it("falls back to the last close for price when no quote is given", () => {
    const r = buildTradeIdeaReadout({ symbol: "MSFT", bars: bars([200, 210, 220]) });
    expect(r.price).toBe(220);
  });

  it("passes through news and signals, capped at five", () => {
    const news = Array.from({ length: 8 }, (_, i) => ({
      title: `headline ${i}`,
      url: `https://example.com/${i}`,
      source: "example.com",
      publishedAt: null,
    }));
    const signals = Array.from({ length: 8 }, (_, i) => ({
      content: `signal ${i}`,
      source: "twitter",
      status: "PENDING",
      timestamp: "2026-07-20T00:00:00Z",
    }));
    const r = buildTradeIdeaReadout({ symbol: "AAPL", bars: bars([1, 2, 3]), news, signals });
    expect(r.news.length).toBe(5);
    expect(r.signals.length).toBe(5);
  });

  it("always notes that it is an analytical summary, not advice", () => {
    const r = buildTradeIdeaReadout({ symbol: "AAPL", bars: bars([1, 2, 3]) });
    expect(r.notes.some((n) => n.toLowerCase().includes("not personalized"))).toBe(true);
  });

  it("degrades gracefully with no bars", () => {
    const r = buildTradeIdeaReadout({ symbol: "AAPL", bars: [] });
    expect(r.trend.direction).toBe("unknown");
    expect(r.trend.barsAnalyzed).toBe(0);
    expect(r.price).toBeNull();
    expect(r.notes.some((n) => n.includes("No price bars"))).toBe(true);
  });
});
