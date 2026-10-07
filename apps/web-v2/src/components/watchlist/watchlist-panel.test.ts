/**
 * Watchlist panel behavior, asserted against the real code paths instead of
 * the component's source text.
 *
 * "watchlist row click wiring": each row wires three separate actions behind
 * one card - a full-row overlay that opens the chart, and two small explicit
 * buttons that trade or ask AI. A past regression let the overlay
 * conditionally fire trade or AI instead (first a `primaryRowAction` flag,
 * then an `onViewSymbol ?? onTradeSymbol` fallback), so the same click could
 * open a different thing depending on unrelated state, and a separate
 * regression wired "Trade" to fire twice. That wiring now lives in
 * `buildWatchlistRowActions` (a pure builder the component calls for its
 * onClick handlers), so these tests call the returned handlers with spies and
 * check which callback actually fired - a string match on `onClick={...}`
 * can't tell the difference between "wired correctly" and "wired to the wrong
 * callback under a different variable name".
 *
 * "watchlist add-symbol resolution": the perp "add to watchlist" flow used to
 * inline a case-insensitive match against the live Hyperliquid universe
 * (`market.coin.toUpperCase() === normalized.toUpperCase()`) inside the form
 * handler. Extracted to `resolveAddSymbol` (behavior-preserving) so the
 * matching logic - including the case where nothing matches - is directly
 * testable without simulating a form submission.
 *
 * "watchlist row rendering" / "quote freshness" / "stock vs perp venue
 * separation": render the REAL component (`renderToStaticMarkup`) against a
 * mocked tRPC/session/venue layer and check what a user actually sees - the
 * Alpaca-quotes-missing banner, the per-symbol price cell, and the
 * quote-freshness label all have to react to the fixture data, not just be
 * referenced somewhere in the file. The tRPC mock only defines the endpoints
 * the component is supposed to call (e.g. `hyperliquid.marketStats`, not the
 * retired `hyperliquid.allMids`); calling a wrong or removed endpoint throws
 * during render instead of silently passing a substring check.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWatchlistRowActions, type WatchlistRowActionHandlers } from "./watchlist-row-actions";
import { normalizeInputSymbol, resolveAddSymbol, type PerpMarketOption } from "./watchlist-add-symbol";
import type { MarketVenue } from "@/lib/market-selection";

describe("watchlist row click wiring (buildWatchlistRowActions)", () => {
  const stockItem = { symbol: "AAPL", venue: "stocks" as const };

  function spyHandlers() {
    const calls: {
      view: Array<[string, MarketVenue | undefined]>;
      trade: Array<[string, MarketVenue | undefined]>;
      ai: Array<[string, MarketVenue | undefined]>;
    } = { view: [], trade: [], ai: [] };
    const handlers: WatchlistRowActionHandlers = {
      onViewSymbol: (symbol, venue) => calls.view.push([symbol, venue]),
      onTradeSymbol: (symbol, venue) => calls.trade.push([symbol, venue]),
      onAskAi: (symbol, venue) => calls.ai.push([symbol, venue]),
    };
    return { calls, handlers };
  }

  test("the row overlay opens the chart only, never trade or AI", () => {
    const { calls, handlers } = spyHandlers();
    const actions = buildWatchlistRowActions(stockItem, handlers, false);

    actions.onRowClick();

    expect(calls.view).toEqual([["AAPL", "stocks"]]);
    expect(calls.trade).toEqual([]);
    expect(calls.ai).toEqual([]);
  });

  test("the row overlay is a no-op while organizing, so it can't fire underneath the drag handles", () => {
    const { calls, handlers } = spyHandlers();
    const actions = buildWatchlistRowActions(stockItem, handlers, true);

    actions.onRowClick();

    expect(calls.view).toEqual([]);
    expect(calls.trade).toEqual([]);
    expect(calls.ai).toEqual([]);
  });

  test("the Trade button fires trade only, even while organizing", () => {
    const { calls, handlers } = spyHandlers();
    const actions = buildWatchlistRowActions(stockItem, handlers, true);

    actions.onTradeClick();

    expect(calls.trade).toEqual([["AAPL", "stocks"]]);
    expect(calls.view).toEqual([]);
    expect(calls.ai).toEqual([]);
  });

  test("the Ask AI button fires AI only", () => {
    const { calls, handlers } = spyHandlers();
    const actions = buildWatchlistRowActions(stockItem, handlers, false);

    actions.onAskAiClick();

    expect(calls.ai).toEqual([["AAPL", "stocks"]]);
    expect(calls.view).toEqual([]);
    expect(calls.trade).toEqual([]);
  });

  test("carries the item's own venue through to every handler, including perps", () => {
    const { calls, handlers } = spyHandlers();
    const actions = buildWatchlistRowActions({ symbol: "BTC", venue: "perps" }, handlers, false);

    actions.onRowClick();
    actions.onTradeClick();
    actions.onAskAiClick();

    expect(calls.view).toEqual([["BTC", "perps"]]);
    expect(calls.trade).toEqual([["BTC", "perps"]]);
    expect(calls.ai).toEqual([["BTC", "perps"]]);
  });
});

describe("watchlist add-symbol resolution", () => {
  test("stock input is trimmed and uppercased", () => {
    expect(normalizeInputSymbol("  aapl  ", "stocks")).toBe("AAPL");
    expect(
      resolveAddSymbol({ input: "  aapl  ", venue: "stocks", perpMarkets: undefined }),
    ).toBe("AAPL");
  });

  test("empty stock input resolves to an empty (falsy) symbol, not a guess", () => {
    expect(resolveAddSymbol({ input: "   ", venue: "stocks", perpMarkets: undefined })).toBe("");
  });

  test("perp input keeps its casing before matching (e.g. a bare ticker stays as typed)", () => {
    expect(normalizeInputSymbol("  eth  ", "perps")).toBe("eth");
  });

  test("perps resolve case-insensitively to the listed market's canonical ticker", () => {
    const perpMarkets: PerpMarketOption[] = [{ coin: "ETH" }, { coin: "BTC" }];

    expect(resolveAddSymbol({ input: "eth", venue: "perps", perpMarkets })).toBe("ETH");
    expect(resolveAddSymbol({ input: "ETH", venue: "perps", perpMarkets })).toBe("ETH");
    expect(resolveAddSymbol({ input: " Eth ", venue: "perps", perpMarkets })).toBe("ETH");
  });

  test("an unlisted perp ticker resolves to undefined rather than being submitted verbatim", () => {
    const perpMarkets: PerpMarketOption[] = [{ coin: "ETH" }];

    expect(resolveAddSymbol({ input: "doge", venue: "perps", perpMarkets })).toBeUndefined();
  });

  test("a perp lookup before the universe has loaded resolves to undefined, not a guess", () => {
    expect(
      resolveAddSymbol({ input: "eth", venue: "perps", perpMarkets: undefined }),
    ).toBeUndefined();
  });
});

// --- Rendered-component tests below need a mocked tRPC/session/venue layer. ---

mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "test-user" } } }),
}));

mock.module("@/lib/venue-context", () => ({
  useVenue: () => ({ venue: "stocks" }),
}));

interface WatchlistItemFixture {
  id: string;
  symbol: string;
  venue: "stocks" | "perps";
}

interface StockQuoteFixture {
  symbol: string;
  last: string;
  change: string;
  changePercent: string;
  /** Grouped locale string, exactly as `quotes.getStockQuotes` returns it. */
  volume?: string;
}

interface PerpStatFixture {
  coin: string;
  markPx: string;
  prevDayPx: string;
  dayNtlVlm?: string | null;
  openInterest?: string | null;
  funding?: string | null;
  maxLeverage?: number;
}

interface EnabledOptions {
  enabled: boolean;
}

/** Mutable fixtures the mocked tRPC hooks read on every render call. */
const fixture: {
  items: WatchlistItemFixture[];
  quotes: StockQuoteFixture[];
  quotesError: { message: string } | null;
  quotesFetching: boolean;
  quotesSuccess: boolean;
  quotesUpdatedAt: number | undefined;
  perpStats: PerpStatFixture[];
  agentReady: boolean;
  perpMarkets: PerpMarketOption[];
} = {
  items: [],
  quotes: [],
  quotesError: null,
  quotesFetching: false,
  quotesSuccess: true,
  quotesUpdatedAt: Date.now(),
  perpStats: [],
  agentReady: false,
  perpMarkets: [],
};

function resetFixture() {
  fixture.items = [];
  fixture.quotes = [];
  fixture.quotesError = null;
  fixture.quotesFetching = false;
  fixture.quotesSuccess = true;
  fixture.quotesUpdatedAt = Date.now();
  fixture.perpStats = [];
  fixture.agentReady = false;
  fixture.perpMarkets = [];
}

/** The options object each mocked query most recently received, for asserting on derived `enabled` gates. */
let lastQuotesQueryCall: {
  input: { symbols: string[]; credentialId: string | undefined };
  options: EnabledOptions;
} | null = null;
let lastMarketStatsCall: { options: EnabledOptions } | null = null;
let lastHlStatusCall: { options: EnabledOptions } | null = null;
let perpUniverseCallCount = 0;

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isError: false,
  error: null as { message: string } | null,
  reset: () => {},
};

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      watchlist: {
        list: {
          invalidate: async () => {},
          cancel: async () => {},
          getData: () => undefined,
          setData: () => {},
        },
      },
    }),
    watchlist: {
      list: { useQuery: () => ({ data: fixture.items, isLoading: false }) },
      add: { useMutation: () => noopMutation },
      remove: { useMutation: () => noopMutation },
      reorder: { useMutation: () => noopMutation },
    },
    markets: {
      perpUniverse: {
        useQuery: () => {
          perpUniverseCallCount += 1;
          return { data: fixture.perpMarkets, isLoading: false };
        },
      },
    },
    symbols: {
      search: { useQuery: () => ({ data: [] }) },
    },
    quotes: {
      getStockQuotes: {
        useQuery: (
          input: { symbols: string[]; credentialId: string | undefined },
          options: EnabledOptions,
        ) => {
          lastQuotesQueryCall = { input, options };
          return {
            data: fixture.quotes,
            error: fixture.quotesError,
            isFetching: fixture.quotesFetching,
            isSuccess: fixture.quotesSuccess,
            dataUpdatedAt: fixture.quotesUpdatedAt,
            refetch: async () => ({ data: fixture.quotes }),
          };
        },
      },
    },
    hyperliquid: {
      marketStats: {
        useQuery: (_input: undefined, options: EnabledOptions) => {
          lastMarketStatsCall = { options };
          return { data: fixture.perpStats };
        },
      },
      status: {
        useQuery: (_input: undefined, options: EnabledOptions) => {
          lastHlStatusCall = { options };
          return { data: { agentReady: fixture.agentReady } };
        },
      },
    },
  },
}));

const { WatchlistPanel } = await import("./watchlist-panel");

function renderPanel(
  overrides: {
    activeCredentialId?: string;
    embedded?: boolean;
    selectedSymbol?: string;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(WatchlistPanel, {
      onTradeSymbol: () => {},
      onAskAi: () => {},
      onViewSymbol: () => {},
      ...overrides,
    }),
  );
}

function requireCall<T>(call: T | null, message: string): T {
  if (call === null) throw new Error(message);
  return call;
}

describe("watchlist row rendering", () => {
  test("each row exposes one full-row chart target plus explicit Trade and Ask AI controls", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotes = [{ symbol: "AAPL", last: "150.25", change: "1.25", changePercent: "0.84" }];

    const markup = renderPanel({ activeCredentialId: "cred-1" });

    expect(markup).toContain('aria-label="View AAPL live chart"');
    expect(markup).toContain('aria-label="Trade AAPL"');
    expect(markup).toContain('aria-label="Ask AI about AAPL"');
    // Exactly one visible Trade control per row - the chart overlay's
    // accessible name is distinct, never a second "Trade AAPL" target.
    expect(markup.match(/aria-label="Trade AAPL"/g) ?? []).toHaveLength(1);

    // Structural contract: the overlay covers the whole card behind the row
    // content (pointer-events-none), and the action-button wrapper
    // re-enables pointer events so Trade/Ask AI/Remove stay clickable
    // despite the overlay sitting on top of them.
    expect(markup).toContain("absolute inset-0 z-0 cursor-pointer");
    expect(markup).toContain("relative z-10 pointer-events-none flex items-center");
    expect(markup).toContain("pointer-events-auto flex items-center gap-1");

    // The symbol name is plain text next to the venue badge, not its own
    // clickable "text-left" button (an old layout that gave the row two
    // overlapping click targets).
    expect(markup).not.toContain("text-left");

    expect(markup).toContain("font-data text-sm tabular-nums text-muted-foreground sm:text-xs");
    expect(markup).toContain("$150.25");
  });

  test("embedded rows show a 44px chart disclosure beside the symbol without changing desktop layout", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotes = [{ symbol: "AAPL", last: "150.25", change: "1.25", changePercent: "0.84" }];

    const embeddedMarkup = renderPanel({ activeCredentialId: "cred-1", embedded: true });
    const desktopMarkup = renderPanel({ activeCredentialId: "cred-1" });

    expect(embeddedMarkup).toContain('aria-label="Open AAPL chart"');
    expect(embeddedMarkup).toContain('title="Open AAPL chart"');
    expect(embeddedMarkup).toContain("pointer-events-auto min-h-11 min-w-11");
    expect(embeddedMarkup).toContain("xl:hidden");
    expect(embeddedMarkup).toContain("hidden xl:inline-flex");
    expect(embeddedMarkup).toContain("lucide-chart-line");
    expect(embeddedMarkup).toContain("lucide-chevron-right");
    expect(embeddedMarkup).toContain('aria-label="Trade AAPL"');
    expect(embeddedMarkup).toContain('aria-label="Ask AI about AAPL"');
    expect(embeddedMarkup).toContain('aria-label="Remove AAPL"');

    expect(desktopMarkup).not.toContain('aria-label="Open AAPL chart"');
    expect(desktopMarkup).not.toContain('title="Open AAPL chart"');
  });

  test("marks the selected row with a left rail on mobile, not a ring around the whole card", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotes = [{ symbol: "AAPL", last: "150.25", change: "1.25", changePercent: "0.84" }];

    const markup = renderPanel({
      activeCredentialId: "cred-1",
      embedded: true,
      selectedSymbol: "AAPL",
    });

    expect(markup).toContain('data-watchlist-row-rail="true"');
    expect(markup).toContain("w-0.5 rounded-full bg-primary xl:hidden");
    // The ring survives only above the mobile breakpoint, so the desktop card
    // looks exactly as it did; the phone gets the rule instead of the halo.
    expect(markup).toContain("xl:ring-2 xl:ring-primary");
    expect(markup).not.toContain("ring-2 ring-primary");

    // An unselected row has no rail at all.
    const unselected = renderPanel({ activeCredentialId: "cred-1", embedded: true });
    expect(unselected).not.toContain('data-watchlist-row-rail="true"');
  });

  test("a stock row carries traded share volume, on the line it already had", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotes = [
      {
        symbol: "AAPL",
        last: "150.25",
        change: "1.25",
        changePercent: "0.84",
        // The router returns a grouped locale string; Number() alone is NaN.
        volume: "52,100,000",
      },
    ];

    const markup = renderPanel({ activeCredentialId: "cred-1", embedded: true });

    expect(markup).toContain('data-watchlist-row-metrics="true"');
    expect(markup).toContain('data-market-row-metric="volume"');
    expect(markup).toContain("52.1M");
    // Share volume is a COUNT. A dollar sign here would assert a different
    // number entirely.
    expect(markup).not.toContain("$52.1M");
  });

  test("a perp row carries volume, open interest and funding without growing taller", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "BTC", venue: "perps" }];
    fixture.agentReady = true;
    fixture.perpStats = [
      {
        coin: "BTC",
        markPx: "64000",
        prevDayPx: "63000",
        dayNtlVlm: "2000000000",
        openInterest: "12000",
        funding: "0.0000125",
        maxLeverage: 40,
      },
    ];

    const markup = renderPanel({ embedded: true });

    expect(markup).toContain('data-market-row-metric="volume"');
    expect(markup).toContain('data-market-row-metric="open-interest"');
    expect(markup).toContain('data-market-row-metric="funding"');
    // Open interest priced in USD at the mark, the same way the desktop HL
    // Markets list prices it: 12,000 BTC at $64,000.
    expect(markup).toContain("$768M");
    expect(markup).toContain("+0.00125%");

    // The line lives inside the column the action buttons already fill, and
    // is mobile-only: the desktop card gains neither height nor content.
    const metricLine = markup.match(
      /data-watchlist-row-metrics="true" class="([^"]+)"/,
    )?.[1];
    expect(metricLine).toContain("xl:hidden");
    expect(metricLine).toContain("leading-4");
    expect(metricLine).toContain("overflow-hidden");
  });

  test("the mobile chart disclosure sits beside both lines instead of setting the first line's height", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];

    const markup = renderPanel({ activeCredentialId: "cred-1", embedded: true });

    // A 44px control inside line 1 made every card ~100px tall. It is now a
    // sibling of the two content lines, so the card is padding + text.
    expect(markup).toContain("flex items-stretch gap-2 rounded-lg border");
    expect(markup).toContain("px-3 py-2 transition-colors hover:bg-muted/30 xl:py-3");
    expect(markup).toContain("min-h-11 min-w-11 shrink-0 self-center");
  });
});

describe("quote freshness reflects the real query state, not a fixed label", () => {
  test("a fetch error renders the error label and tone", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotesError = { message: "boom" };

    const markup = renderPanel({ activeCredentialId: "cred-1" });

    expect(markup).toContain("Quote error");
    expect(markup).toContain("text-red-400");
  });

  test("a quote missing from a successful response is treated as an error, not silence", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    // AAPL was requested (activeCredentialId set below) but is absent from
    // the response - the "quoteMissing" case, distinct from a query error.
    fixture.quotes = [];
    fixture.quotesError = null;
    fixture.quotesSuccess = true;
    fixture.quotesFetching = false;

    const markup = renderPanel({ activeCredentialId: "cred-1" });

    expect(markup).toContain("Quote error");
    expect(markup).toContain("text-red-400");
  });

  test("a quote older than the freshness window is labeled stale, not live", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotes = [{ symbol: "AAPL", last: "150.25", change: "0.00", changePercent: "0.00" }];
    fixture.quotesUpdatedAt = Date.now() - 200_000; // past the 90s stale window

    const markup = renderPanel({ activeCredentialId: "cred-1" });

    expect(markup).toContain("Stale");
    expect(markup).toContain("text-amber-300");
  });

  test("a fresh quote shows no error or stale label at all", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    fixture.quotes = [{ symbol: "AAPL", last: "150.25", change: "0.00", changePercent: "0.00" }];
    fixture.quotesUpdatedAt = Date.now();

    const markup = renderPanel({ activeCredentialId: "cred-1" });

    expect(markup).not.toContain("Quote error");
    expect(markup).not.toContain("Stale");
  });
});

describe("stock and perp watchlist items are kept on separate market data, with an explicit venue picker", () => {
  test("the add-symbol control exposes an accessible Stocks/Perps venue picker", () => {
    resetFixture();

    const markup = renderPanel();

    expect(markup).toContain('aria-label="Watchlist venue"');
    expect(markup).toContain("Stocks");
    expect(markup).toContain("Perps");
  });

  test("the Alpaca-credentials banner keys off stock items, not perp items", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "BTC", venue: "perps" }];
    const perpOnlyMarkup = renderPanel();
    expect(perpOnlyMarkup).not.toContain("Connect Alpaca credentials for live quotes.");

    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    const stockMarkup = renderPanel();
    expect(stockMarkup).toContain("Connect Alpaca credentials for live quotes.");
  });

  test("only stock symbols are sent to the stock quotes query, even with perps on the same watchlist", () => {
    resetFixture();
    fixture.items = [
      { id: "1", symbol: "AAPL", venue: "stocks" },
      { id: "2", symbol: "BTC", venue: "perps" },
    ];

    renderPanel({ activeCredentialId: "cred-1" });

    const call = requireCall(lastQuotesQueryCall, "getStockQuotes.useQuery was not called");
    expect(call.input.symbols).toEqual(["AAPL"]);
    expect(call.input.credentialId).toBe("cred-1");
  });

  test("the perp market-data queries only enable once a perp item is on the watchlist", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "AAPL", venue: "stocks" }];
    renderPanel();
    expect(
      requireCall(lastMarketStatsCall, "hyperliquid.marketStats.useQuery was not called").options
        .enabled,
    ).toBe(false);
    expect(
      requireCall(lastHlStatusCall, "hyperliquid.status.useQuery was not called").options.enabled,
    ).toBe(false);

    resetFixture();
    fixture.items = [
      { id: "1", symbol: "AAPL", venue: "stocks" },
      { id: "2", symbol: "BTC", venue: "perps" },
    ];
    renderPanel();
    expect(
      requireCall(lastMarketStatsCall, "hyperliquid.marketStats.useQuery was not called").options
        .enabled,
    ).toBe(true);
    expect(
      requireCall(lastHlStatusCall, "hyperliquid.status.useQuery was not called").options.enabled,
    ).toBe(true);
  });

  test("a perp row's mark is matched by coin, not by list position", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "BTC", venue: "perps" }];
    fixture.perpStats = [
      { coin: "ETH", markPx: "3000", prevDayPx: "3100" }, // decoy, listed first
      { coin: "BTC", markPx: "65000.5", prevDayPx: "64000" },
    ];

    const markup = renderPanel();

    expect(markup).toContain("$65,000.50");
  });

  test("a perp item whose Hyperliquid agent isn't ready is told to set up perps, not trade blind", () => {
    resetFixture();
    fixture.items = [{ id: "1", symbol: "BTC", venue: "perps" }];
    fixture.agentReady = false;

    const markup = renderPanel();

    expect(markup).toContain("Set up perps to trade");
  });

  test("the add-symbol form still queries the live Hyperliquid universe for perp matching", () => {
    resetFixture();
    perpUniverseCallCount = 0;

    renderPanel();

    expect(perpUniverseCallCount).toBeGreaterThan(0);
  });
});
