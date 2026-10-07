import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketPulseHeatmap } from "./market-pulse-heatmap";
import { MarketPulseRankings } from "./market-pulse-rankings";
import type { MarketPulseOverview, MarketTile } from "./market-pulse-types";
import { formatMarketPrice } from "./market-pulse-utils";

function tile(symbol: string, venue: "stocks" | "perps", changePercent = 2.5): MarketTile {
  return {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    price: 123.45,
    changePercent,
    volume: 1_500_000,
    weight: 0.8,
    trendScore: 75,
    group: changePercent >= 0 ? "Advancers" : "Decliners",
    maxLeverage: venue === "perps" ? 20 : null,
  };
}

const noop = () => {};

describe("MarketPulseHeatmap", () => {
  test("renders separate accessible chart and trade actions for a perp tile", () => {
    const markup = renderToStaticMarkup(
      <MarketPulseHeatmap
        items={[tile("xyz:DRAM", "perps", -4.25)]}
        venue="perps"
        onViewMarket={noop}
        onTradeMarket={noop}
      />,
    );

    expect(markup).toContain('aria-label="View xyz:DRAM chart, -4.25%"');
    expect(markup).toContain('aria-label="Trade xyz:DRAM"');
    expect(markup).toContain("Perpetuals");
    expect(markup).toContain("-4.25%");
  });

  test("renders an honest empty state without fabricated market values", () => {
    const markup = renderToStaticMarkup(
      <MarketPulseHeatmap
        items={[]}
        venue="stocks"
        onViewMarket={noop}
        onTradeMarket={noop}
      />,
    );

    expect(markup).toContain("No stock heatmap data available.");
    expect(markup).not.toContain("$0.00");
  });
});

describe("MarketPulseRankings", () => {
  test("renders venue controls and actionable stock rankings", () => {
    const stock = tile("AAPL", "stocks");
    const overview: MarketPulseOverview = {
      meta: {
        asOf: "2026-07-29T18:00:00.000Z",
        staleAfter: "2026-07-29T18:02:00.000Z",
        status: "ok",
        cacheState: "miss",
      },
      brief: {
        headline: "Market activity snapshot",
        summary: "AAPL leads stock activity.",
        sources: [],
      },
      stocks: {
        trending: [stock],
        gainers: [stock],
        losers: [],
        mostActive: [stock],
        heatmap: [stock],
      },
      perps: {
        trending: [],
        gainers: [],
        losers: [],
        heatmap: [],
      },
      warnings: [],
    };
    const markup = renderToStaticMarkup(
      <MarketPulseRankings
        overview={overview}
        venue="stocks"
        perpsEnabled
        onVenueChange={noop}
        onViewMarket={noop}
        onTradeMarket={noop}
      />,
    );

    expect(markup).toContain('aria-label="Market venue"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="View AAPL chart"');
    expect(markup).toContain('aria-label="Trade AAPL"');
  });

  test("hides perpetual controls when the deployment disables perps", () => {
    const stock = tile("AAPL", "stocks");
    const overview = {
      meta: { asOf: "2026-07-29T18:00:00.000Z", staleAfter: "2026-07-29T18:02:00.000Z", status: "ok", cacheState: "miss" },
      brief: { headline: "Market activity snapshot", summary: "AAPL leads stock activity.", sources: [] },
      stocks: { trending: [stock], gainers: [stock], losers: [], mostActive: [stock], heatmap: [stock] },
      perps: { trending: [], gainers: [], losers: [], heatmap: [] },
      warnings: [],
    } as MarketPulseOverview;
    const markup = renderToStaticMarkup(
      <MarketPulseRankings
        overview={overview}
        venue="stocks"
        perpsEnabled={false}
        onVenueChange={noop}
        onViewMarket={noop}
        onTradeMarket={noop}
      />,
    );

    expect(markup).toContain(">stocks<");
    expect(markup).not.toContain(">perps<");
  });

  test("marks the selected venue with a primary tint, not a solid gold chip", () => {
    // DESIGN.md: gold is a seasoning, not a sauce. In a two-up group a solid
    // `bg-primary` chip floods half the control with the accent, so selection
    // uses the same tint the chart-overlay toggles do.
    const stock = tile("AAPL", "stocks");
    const overview = {
      meta: { asOf: "2026-07-29T18:00:00.000Z", staleAfter: "2026-07-29T18:02:00.000Z", status: "ok", cacheState: "miss" },
      brief: { headline: "Market activity snapshot", summary: "AAPL leads stock activity.", sources: [] },
      stocks: { trending: [stock], gainers: [stock], losers: [], mostActive: [stock], heatmap: [stock] },
      perps: { trending: [], gainers: [], losers: [], heatmap: [] },
      warnings: [],
    } as MarketPulseOverview;
    const markup = renderToStaticMarkup(
      <MarketPulseRankings
        overview={overview}
        venue="stocks"
        perpsEnabled
        onVenueChange={noop}
        onViewMarket={noop}
        onTradeMarket={noop}
      />,
    );
    const selected =
      markup.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0] ?? "";
    const idle =
      markup.match(/<button[^>]*aria-pressed="false"[^>]*>/)?.[0] ?? "";

    expect(selected).toContain("border-primary/45");
    expect(selected).toContain("bg-primary/15");
    expect(selected).toContain("text-primary");
    expect(selected).not.toContain("text-primary-foreground");
    expect(markup).not.toMatch(/(?:^|["\s])bg-primary(?![-/])/);
    // Both states carry a border so the segments do not resize on selection.
    expect(idle).toContain("border-transparent");
  });
});

describe("formatMarketPrice", () => {
  test("preserves meaningful precision for low-priced perpetual markets", () => {
    expect(formatMarketPrice(0.00001234)).toBe("$0.00001234");
    expect(formatMarketPrice(123.45)).toBe("$123.45");
  });
});
