import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  MarketPulseOverview,
  MarketTile,
} from "@/components/market-pulse/market-pulse-types";
import {
  hasPulseRows,
  MobileMarketPulse,
  mobileMarketPulseState,
} from "./mobile-market-pulse";

function tile(symbol: string, venue: MarketTile["venue"]): MarketTile {
  return {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    price: 100,
    changePercent: 1.5,
    volume: 1_000_000,
    weight: 0.5,
    trendScore: 0.5,
    group: "test",
    maxLeverage: null,
  };
}

function overview({
  stocks = [],
  perps = [],
}: {
  stocks?: MarketTile[];
  perps?: MarketTile[];
} = {}): MarketPulseOverview {
  return {
    stocks: { trending: stocks, gainers: [], mostActive: [], heatmap: [] },
    perps: { trending: perps, gainers: [], heatmap: [] },
  } as unknown as MarketPulseOverview;
}

const EMPTY = overview();
const STOCKS_ONLY = overview({ stocks: [tile("NVDA", "stocks")] });
const PERPS_ONLY = overview({ perps: [tile("BTC", "perps")] });

function render(props: Partial<Parameters<typeof MobileMarketPulse>[0]> = {}) {
  return renderToStaticMarkup(
    <MobileMarketPulse
      overview={undefined}
      isLoading={false}
      isError={false}
      showStocks
      showPerps
      availability={{ stocks: true, perps: true }}
      renderTile={(item) => <li key={item.id}>{item.symbol}</li>}
      onRetry={() => {}}
      {...props}
    />,
  );
}

describe("mobileMarketPulseState", () => {
  const base = { isLoading: false, isError: false, showStocks: true, showPerps: true };

  test("loading wins over everything else", () => {
    expect(
      mobileMarketPulseState({ ...base, overview: STOCKS_ONLY, isLoading: true }),
    ).toBe("loading");
  });

  test("an overview with rows is ready; one with none is empty", () => {
    expect(mobileMarketPulseState({ ...base, overview: STOCKS_ONLY })).toBe("ready");
    expect(mobileMarketPulseState({ ...base, overview: EMPTY })).toBe("empty");
  });

  test("stale data outranks a failed refetch; a failure with nothing is an error", () => {
    expect(
      mobileMarketPulseState({ ...base, overview: STOCKS_ONLY, isError: true }),
    ).toBe("ready");
    expect(
      mobileMarketPulseState({ ...base, overview: undefined, isError: true }),
    ).toBe("error");
  });

  test("a disabled query (signed out) is idle, not broken", () => {
    expect(mobileMarketPulseState({ ...base, overview: undefined })).toBe("idle");
  });
});

describe("hasPulseRows", () => {
  test("counts only the venues the current tab shows", () => {
    expect(hasPulseRows(PERPS_ONLY, { showStocks: true, showPerps: true })).toBe(true);
    expect(hasPulseRows(PERPS_ONLY, { showStocks: true, showPerps: false })).toBe(false);
    expect(hasPulseRows(EMPTY, { showStocks: true, showPerps: true })).toBe(false);
  });
});

describe("MobileMarketPulse", () => {
  test("never renders the Market pulse heading over nothing", () => {
    for (const html of [
      render({ isLoading: true }),
      render({ overview: EMPTY }),
      render({ isError: true }),
      render(),
    ]) {
      expect(html).not.toContain("Market pulse");
    }
    expect(render({ overview: STOCKS_ONLY })).toContain("Market pulse");
  });

  test("names the block as a region and puts the quote status on the first list heading, only when rankings render", () => {
    const status = { label: "Quotes ready", dotClassName: "bg-[#65c7b6]" };
    const ready = render({
      overview: overview({
        stocks: [tile("NVDA", "stocks")],
        perps: [tile("BTC", "perps")],
      }),
      status,
    });
    const firstHeading =
      ready.match(/<h3[^>]*>Stocks trending<\/h3>[\s\S]*?<\/div>/)?.[0] ?? "";

    expect(ready).toMatch(/role="region"[^>]*aria-label="Market pulse"/);
    // No caption row above the lists: the first painted line is a list heading.
    expect(ready).not.toContain("Ranked by live activity");
    expect(ready.indexOf("<h3")).toBeLessThan(ready.indexOf("Quotes ready"));
    expect((ready.match(/data-market-pulse-status="true"/g) ?? []).length).toBe(1);
    expect(firstHeading).toContain("Quotes ready");
    expect(firstHeading).toContain("bg-[#65c7b6]");
    for (const html of [
      render({ overview: EMPTY, status }),
      render({ isLoading: true, status }),
      render({ isError: true, status }),
    ]) {
      expect(html).not.toContain('data-market-pulse-status="true"');
      expect(html).not.toContain('role="region"');
    }
  });

  test("shows a busy skeleton while rankings load", () => {
    const html = render({ isLoading: true });

    expect(html).toContain('data-market-pulse="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-market-pulse-skeleton="true"');
    expect(html).not.toContain("Search a ticker");
  });

  test("an empty overview gets the shared empty-state treatment with a refresh", () => {
    const html = render({ overview: EMPTY });

    expect(html).toContain('data-market-pulse="empty"');
    expect(html).toContain("No rankings yet");
    expect(html).toContain(">Refresh rankings</button>");
    expect(html).not.toContain("data-market-section");
  });

  test("a failed request says so and offers a retry, not a search prompt", () => {
    const html = render({ isError: true });

    expect(html).toContain('data-market-pulse="error"');
    expect(html).toContain("Market rankings could not be loaded");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("Search a ticker to browse markets.");
  });

  test("routes both actions through the caller's retry", () => {
    let retries = 0;
    const onRetry = () => {
      retries += 1;
    };
    for (const props of [{ overview: EMPTY }, { isError: true }]) {
      const element = MobileMarketPulse({
        overview: undefined,
        isLoading: false,
        isError: false,
        showStocks: true,
        showPerps: true,
        availability: { stocks: true, perps: true },
        renderTile: (item) => <li key={item.id}>{item.symbol}</li>,
        onRetry,
        ...props,
      });
      // The EmptyState element is the sole child of the state wrapper.
      const emptyState = (
        element.props as { children: { props: { actions: { onClick: () => void }[] } } }
      ).children;
      emptyState.props.actions[0]!.onClick();
    }
    expect(retries).toBe(2);
  });

  test("renders ranked sections for the visible venues only", () => {
    const both = render({
      overview: overview({
        stocks: [tile("NVDA", "stocks")],
        perps: [tile("BTC", "perps")],
      }),
    });
    expect(both).toContain('data-market-pulse="ready"');
    expect(both).toContain('data-market-section="Stocks trending"');
    expect(both).toContain('data-market-section="Perps trending"');
    expect(both).toContain(">NVDA</li>");
    expect(both).toContain(">BTC</li>");

    const stocksTab = render({
      overview: overview({
        stocks: [tile("NVDA", "stocks")],
        perps: [tile("BTC", "perps")],
      }),
      showPerps: false,
    });
    expect(stocksTab).toContain('data-market-section="Stocks trending"');
    expect(stocksTab).not.toContain('data-market-section="Perps trending"');
  });

  test("grows into the Browse surface's free space and centers empty and error states", () => {
    for (const html of [render({ overview: EMPTY }), render({ isError: true })]) {
      const root =
        html.match(/<div data-market-pulse="[^"]+" class="([^"]+)"/)?.[1] ?? "";
      const emptyState =
        html.match(/<div class="([^"]*\bflex-col items-center\b[^"]*)"/)?.[1] ?? "";

      expect(root).toContain("flex-1");
      expect(root).toContain("flex-col");
      expect(root).not.toContain("overflow-y-auto");
      expect(root).not.toContain("min-h-0");
      expect(emptyState).toContain("flex-1");
      expect(emptyState).toContain("justify-center");
    }
  });

  test("signed out, it keeps the quiet search prompt", () => {
    const html = render();

    expect(html).toContain('data-market-pulse="idle"');
    expect(html).toContain("Search a ticker to browse markets.");
  });
});
