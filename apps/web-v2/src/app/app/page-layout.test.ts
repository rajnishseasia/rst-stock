import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BottomTerminalTab } from "./terminal-shell-config";
import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResponsiveShell } from "@/components/layout/responsive-shell";
import { TradingResponsiveShell } from "@/components/layout/trading-responsive-shell";

/**
 * Behavioral cover for the /app route's desktop-terminal wiring and storage
 * keys.
 *
 * This file used to be a `readFileSync` + string-match test over page.tsx.
 * Audit H7 bans that pattern (it pins source text, not behavior, and cannot
 * fail for a bug where the markup/routing is wrong but the string still
 * happens to appear). The MOBILE shell's coverage already left this file in
 * an earlier round:
 *   - nav destinations, active state, Trade vs screen routing:
 *     components/layout/mobile-nav.test.tsx
 *   - Markets-screen tabs, the signal-first default, the xl gate, and where a
 *     copy-prefill lands: app/app/mobile-shell.test.ts
 *   - which shell mounts, and mobile-only subscriptions: the behavioral suite
 *     immediately below (unchanged)
 *   - the venue-active market symbol the trade sheet titles itself with:
 *     lib/market-selection.test.ts (activeMarketSymbol)
 *   - quote freshness on the mobile header strip: lib/quote-freshness.test.ts
 *
 * This round converts the remaining desktop-terminal section. The decisions
 * that section pinned now live in real, importable modules colocated with
 * page.tsx (mirroring the mobile-shell.ts precedent):
 *   - ./terminal-shell-config: the drawer tab lists, the bottom activity tabs
 *     and venue views, and the per-tab subheader filter definitions (pure
 *     data, no React).
 *   - ./dashboard-guard: the anonymous-visitor redirect decision (pure), used
 *     by the default-exported `TradingApp` guard.
 *   - ./venue-routing: `isPerpsAccountActive` (the routing rule shared by
 *     every venue-aware right-rail wrapper - the property that "never routes
 *     a perps portfolio tab to Alpaca history" guards) and
 *     `stockMarketSelection` (what a stock copy action always targets).
 *   - ./left-subheader-bar and ./drawer-resize-handle: two small,
 *     hookless UI sections extracted out of page.tsx so they render (and are
 *     clickable) directly in a test.
 *
 * The components that call `useVenue()` - and so still need a venue context to
 * render - are imported and rendered directly against a *mocked* venue context
 * instead of by reading their source. They are NOT importable from page.tsx: a
 * Next.js page file may export only `default` plus the framework's own config
 * keys, and any other export fails the page-type check `next build` generates
 * into .next/types (a production build failure `bun run check-types` alone does
 * NOT catch on a clean tree, because those generated types do not exist until
 * the build writes them). So they live in sibling modules page.tsx imports:
 *   - ./trading-app-content: `TradingAppContent`, the whole authenticated
 *     terminal, which the default-exported `TradingApp` guard mounts once a
 *     session resolves.
 *   - ./venue-aware-panels: `VenueAwareRightPositions`, `VenueAwareRightOrders`,
 *     `VenueAwareRightPortfolio`, `VenueAwareHeaderMetrics`,
 *     `VenueAwareBottomContent` and their siblings.
 * None of them changed behavior in that move; TradingApp still has exactly one
 * default export Next.js routes to, and still renders exactly these components.
 *
 * One assertion could not be converted (see the bottom of this file): the
 * left drawer's auto-switch-to-X-Signals effect must fire on its very FIRST
 * run, not skip it via a "mounted" guard. That is a React-effect-timing
 * property, and this app's test environment has no DOM to actually run
 * effects in (see app/app/use-terminal-layout-sync.test.ts's own doc comment
 * for the same limitation). That one small `readFileSync` survives, scoped
 * to just that function body, with the reasoning inline.
 */

// ---------------------------------------------------------------------------
// Shared test doubles. Registered before `./page` (and its dependencies) are
// imported, so the page module and the sibling terminal modules it pulls in
// resolve their own top-level imports to these mocks.
// Every mock spreads the real module's exports and overrides only what this
// file needs (mock.module replaces a module for the rest of the bun:test
// process, not just this file - see landing-auth.test.ts for the same
// pattern), except @/lib/venue-context and @/lib/perps-config, whose real
// versions this file has no use for and which existing tests in this repo
// already mock the same minimal way (see watchlist-panel.test.ts,
// perps-onboarding-card.test.ts).
// ---------------------------------------------------------------------------

const realJsxRuntime = (await import("react/jsx-runtime")) as {
  Fragment: unknown;
  jsx: (type: unknown, props: unknown, key?: unknown) => unknown;
  jsxs: (type: unknown, props: unknown, key?: unknown) => unknown;
};
const trueJsx = realJsxRuntime.jsx;
const trueJsxs = realJsxRuntime.jsxs;
const trueFragment = realJsxRuntime.Fragment;

let trueJsxDEV: ((...args: unknown[]) => unknown) | undefined;
try {
  const realDevRuntime = (await import("react/jsx-dev-runtime")) as {
    jsxDEV: (...args: unknown[]) => unknown;
  };
  trueJsxDEV = realDevRuntime.jsxDEV;
} catch {
  trueJsxDEV = undefined;
}

// Heavy leaf panels the venue-aware wrappers choose between. Imported for
// IDENTITY only (to recognize them at the moment the wrappers' own JSX creates
// them) - they are never actually rendered; see the substitution below.
const { PositionsPanel } = await import("@/components/trade/positions-panel");
const { OpenOrdersPanel } = await import("@/components/trade/open-orders-panel");
const { PortfolioHistoryChart } = await import("@/components/charts/portfolio-history-chart");
const { PerpPositionsPanel } = await import("@/components/trade/perp-positions-panel");
const { PerpOrdersPanel } = await import("@/components/trade/perp-orders-panel");
const { PerpPortfolioPanel } = await import("@/components/perps/perp-portfolio-panel");
const { PerpFillsPanel } = await import("@/components/perps/perp-fills-panel");
const { ClosedOrdersPanel } = await import("@/components/trade/closed-orders-panel");
const { PerpBalancesPanel, StockBalancesPanel } = await import(
  "@/components/trade/balances-panel"
);

/** Distinct, inert stand-ins so rendered markup names which real component the wrapper picked. */
function stub(label: string) {
  const Stub = () => createElement("span", { "data-stub": label });
  Object.defineProperty(Stub, "name", { value: `Stub(${label})` });
  return Stub;
}

const StubPositions = stub("PositionsPanel");
const StubOpenOrders = stub("OpenOrdersPanel");
const StubPortfolioHistory = stub("PortfolioHistoryChart");
const StubPerpPositions = stub("PerpPositionsPanel");
const StubPerpOrders = stub("PerpOrdersPanel");
const StubPerpPortfolio = stub("PerpPortfolioPanel");
const StubPerpFills = stub("PerpFillsPanel");
const StubClosedOrders = stub("ClosedOrdersPanel");
const StubStockBalances = stub("StockBalancesPanel");
const StubPerpBalances = stub("PerpBalancesPanel");
// `TradingAppContent` (./trading-app-content) needs a live VenueProvider/tRPC tree to
// render for real; the guard test only needs to know TradingApp attempted to
// mount it, so it too is swapped for an inert stand-in the moment page.tsx's
// own `<TradingAppContent />` JSX creates it.
const StubTradingAppContent = stub("TradingAppContent");

/** Calls captured for the swapped-out real components, so a test can also check what they were handed. */
const stubCalls: Array<{ label: string; props: Record<string, unknown> }> = [];

let realTradingAppContent: unknown;

const stubMap = new Map<unknown, { label: string; Stub: unknown }>([
  [PositionsPanel, { label: "PositionsPanel", Stub: StubPositions }],
  [OpenOrdersPanel, { label: "OpenOrdersPanel", Stub: StubOpenOrders }],
  [PortfolioHistoryChart, { label: "PortfolioHistoryChart", Stub: StubPortfolioHistory }],
  [PerpPositionsPanel, { label: "PerpPositionsPanel", Stub: StubPerpPositions }],
  [PerpOrdersPanel, { label: "PerpOrdersPanel", Stub: StubPerpOrders }],
  [PerpPortfolioPanel, { label: "PerpPortfolioPanel", Stub: StubPerpPortfolio }],
  [PerpFillsPanel, { label: "PerpFillsPanel", Stub: StubPerpFills }],
  [ClosedOrdersPanel, { label: "ClosedOrdersPanel", Stub: StubClosedOrders }],
  [StockBalancesPanel, { label: "StockBalancesPanel", Stub: StubStockBalances }],
  [PerpBalancesPanel, { label: "PerpBalancesPanel", Stub: StubPerpBalances }],
]);

function substitute(type: unknown, props: unknown): unknown {
  if (type === realTradingAppContent) {
    stubCalls.push({ label: "TradingAppContent", props: (props ?? {}) as Record<string, unknown> });
    return StubTradingAppContent;
  }
  const entry = stubMap.get(type);
  if (entry) {
    stubCalls.push({ label: entry.label, props: (props ?? {}) as Record<string, unknown> });
    return entry.Stub;
  }
  return type;
}

mock.module("react/jsx-runtime", () => ({
  Fragment: trueFragment,
  jsx: (type: unknown, props: unknown, key?: unknown) => trueJsx(substitute(type, props), props, key),
  jsxs: (type: unknown, props: unknown, key?: unknown) => trueJsxs(substitute(type, props), props, key),
}));

if (trueJsxDEV) {
  const jsxDEV = trueJsxDEV;
  mock.module("react/jsx-dev-runtime", () => ({
    Fragment: trueFragment,
    jsxDEV: (type: unknown, props: unknown, ...rest: unknown[]) => jsxDEV(substitute(type, props), props, ...rest),
  }));
}

const realAuthClient = (await import("@/lib/auth-client")) as Record<string, unknown>;
let currentSession: { data: { user: { id: string } } | null; isPending: boolean } = {
  data: null,
  isPending: false,
};
mock.module("@/lib/auth-client", () => ({
  ...realAuthClient,
  useSession: () => currentSession,
}));

const realNavigation = (await import("next/navigation")) as Record<string, unknown>;
const routerReplaceCalls: string[] = [];
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({ replace: (path: string) => routerReplaceCalls.push(path) }),
}));

// PERPS_ENABLED gates the module-scope `hl_markets` tab and the perps half of
// the bottom-toolbar/header tests below; forced true the same way
// perps-onboarding-card.test.ts and watchlist-panel.test.ts already do.
mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));

type Venue = "stocks" | "perps";
interface StocksAccountContextFixture {
  venue: "stocks";
  credentialId: string | undefined;
  accountMode: "PAPER" | "LIVE" | undefined;
  accountLabel: string | undefined;
}
interface PerpsAccountContextFixture {
  venue: "perps";
  enabled: boolean;
  agentReady: boolean;
  walletAddress: string | null;
  hlBalanceUsd: string | null;
  network: string | null;
  isLoading: boolean;
}
type AccountContextFixture = StocksAccountContextFixture | PerpsAccountContextFixture;

const STOCKS_ACCOUNT: StocksAccountContextFixture = {
  venue: "stocks",
  credentialId: "cred-1",
  accountMode: "PAPER",
  accountLabel: "Paper",
};
const PERPS_ACCOUNT: PerpsAccountContextFixture = {
  venue: "perps",
  enabled: true,
  agentReady: true,
  walletAddress: "0xWALLET",
  hlBalanceUsd: "500",
  network: "mainnet",
  isLoading: false,
};

let currentVenue: { venue: Venue; accountContext: AccountContextFixture } = {
  venue: "stocks",
  accountContext: STOCKS_ACCOUNT,
};

mock.module("@/lib/venue-context", () => ({
  useVenue: () => currentVenue,
}));

// `./page` is imported for its default alone: it is a Next.js page file, so
// that is the only export it is allowed to have. The terminal it mounts, and
// the venue-aware wrappers that terminal renders, come from the sibling
// modules it imports them from.
const { default: TradingApp } = await import("./page");
const {
  TradingAppContent,
  renderMobileV2Shell,
  resolveHeaderAccountQueryState,
} = await import("./trading-app-content");
const { mergeMobileLocationSearch } = await import("./mobile-v2/mobile-history");
const {
  VenueAwareRightPositions,
  VenueAwareRightOrders,
  VenueAwareRightPortfolio,
  VenueAwareHeaderMetrics,
  VenueAwareBottomContent,
  VenueAwareChartPanel,
} = await import("./venue-aware-panels");
const { PerpOrderBook } = await import("@/components/perps/perp-order-book");
realTradingAppContent = TradingAppContent;

const {
  LEFT_TERMINAL_TABS,
  RIGHT_TERMINAL_TABS,
  BOTTOM_TERMINAL_TABS,
  PERPS_BOTTOM_TERMINAL_TABS,
  resolveBottomSubTab,
  RIGHT_TERMINAL_TAB_VALUES,
  DEFAULT_LEFT_SUBHEADER_ACTIONS,
  LEFT_TERMINAL_SUBHEADERS,
} = await import("./terminal-shell-config");
const {
  resolveDashboardVisibility,
  shouldRenderDashboard,
  syncDashboardRedirect,
} = await import("./dashboard-guard");
const { isPerpsAccountActive, stockMarketSelection } = await import("./venue-routing");
const { LeftSubheaderBar } = await import("./left-subheader-bar");
const { DrawerResizeHandle } = await import("./drawer-resize-handle");
const { flattenElements, findByAriaLabel, click } = await import("@/testing/element-tree");

/** Reset the swap log before each render that inspects it. */
function resetStubCalls() {
  stubCalls.length = 0;
}

describe("terminal dashboard responsive shell", () => {
  test.each([
    ["mobile", "mobile-trade-sheet", "desktop-terminal-drawers"],
    ["desktop", "desktop-terminal-drawers", "mobile-trade-sheet"],
  ] as const)(
    "mounts only the %s shell after the viewport resolves",
    (mode, expectedShell, hiddenShell) => {
      const mounts = { mobile: 0, desktop: 0 };

      function MobileShell() {
        mounts.mobile += 1;
        return createElement("div", null, "mobile-trade-sheet");
      }

      function DesktopShell() {
        mounts.desktop += 1;
        return createElement("div", null, "desktop-terminal-drawers");
      }

      const markup = renderToStaticMarkup(
        createElement(ResponsiveShell, {
          mode,
          mobile: createElement(MobileShell),
          desktop: createElement(DesktopShell),
        }),
      );

      expect(markup).toContain(expectedShell);
      expect(markup).not.toContain(hiddenShell);
      expect(mounts).toEqual({
        mobile: mode === "mobile" ? 1 : 0,
        desktop: mode === "desktop" ? 1 : 0,
      });
    },
  );

  test("mounts neither shell until the client viewport resolves", () => {
    const markup = renderToStaticMarkup(
      createElement(ResponsiveShell, {
        mode: null,
        mobile: createElement("div", null, "mobile-trade-sheet"),
        desktop: createElement("div", null, "desktop-terminal-drawers"),
      }),
    );

    expect(markup).toBe("");
  });

  test.each([
    ["unresolved", null, 0],
    ["desktop", "desktop", 0],
    ["mobile", "mobile", 1],
  ] as const)(
    "subscribes mobile-only queries only in %s mode",
    (_label, mode, expectedSubscriptions) => {
      let mobileSubscriptions = 0;
      const TestTradingResponsiveShell = TradingResponsiveShell<{
        source: string;
      }>;

      const markup = renderToStaticMarkup(
        createElement(TestTradingResponsiveShell, {
          mode,
          mobileSubscriptionInput: {
            activeSymbol: "SPY",
            searchValue: "SPY",
            onPickSymbol: () => {},
          },
          useMobileSubscriptions: () => {
            mobileSubscriptions += 1;
            return { source: "mobile-query-subscriptions" };
          },
          renderMobile: (subscriptions: { source: string }) =>
            createElement("div", null, subscriptions.source),
          desktop: createElement("div", null, "desktop-terminal"),
        }),
      );

      expect(mobileSubscriptions).toBe(expectedSubscriptions);
      if (mode === "mobile") {
        expect(markup).toContain("mobile-query-subscriptions");
      } else {
        expect(markup).not.toContain("mobile-query-subscriptions");
      }
    },
  );

  test("mobile V2 composition has one frame and keeps contextual screens in-flow", () => {
    const markup = renderToStaticMarkup(
      renderMobileV2Shell({
        screen: "markets",
        header: createElement("header", null, "mobile header"),
        navigation: createElement("nav", null, "mobile navigation"),
        markets: {
          accountSummary: createElement("span", null, "summary"),
          marketBrowse: createElement("span", null, "browse"),
          onOpenSearch: () => {},
        },
        search: createElement("span", null, "search"),
        chart: createElement("span", null, "chart"),
        traders: {
          activeTab: "following",
          onTabChange: () => {},
          feed: createElement("span", null, "signals"),
          copyFeed: createElement("span", null, "copy"),
          xCallers: createElement("span", null, "callers"),
          users: createElement("span", null, "users"),
          watchlist: createElement("span", null, "watchlist"),
        },
        account: {
          activeTab: "positions",
          onTabChange: () => {},
          positions: createElement("span", null, "positions"),
          closed: createElement("span", null, "closed"),
          orders: createElement("span", null, "orders"),
          portfolio: createElement("span", null, "portfolio"),
          ai: createElement("span", null, "ai"),
        },
      }),
    );

    expect(markup.match(/data-mobile-v2-frame="true"/g)?.length).toBe(1);
    expect(markup.match(/data-mobile-v2-content="true"/g)?.length).toBe(1);
    expect(markup.match(/data-mobile-v2-navigation-slot="true"/g)?.length).toBe(1);
    expect(markup).toContain("Markets");
    expect(markup).not.toContain("tools");
  });

  test("mobile history replaces only its owned query keys", () => {
    expect(
      mergeMobileLocationSearch(
        "?returnTo=%2Fapp&screen=feed&legacy=1&copyTab=users",
        "?screen=markets&accountTab=positions&tradersTab=following",
      ),
    ).toBe(
      "?returnTo=%2Fapp&legacy=1&screen=markets&accountTab=positions&tradersTab=following",
    );
  });
});

describe("dashboard route guard (redirects anonymous visitors back to the landing page)", () => {
  test("resolveDashboardVisibility: pending hides regardless of user, settled+no-user redirects, settled+user is ready", () => {
    expect(resolveDashboardVisibility(true, false)).toBe("loading");
    expect(resolveDashboardVisibility(true, true)).toBe("loading");
    expect(resolveDashboardVisibility(false, false)).toBe("redirect");
    expect(resolveDashboardVisibility(false, true)).toBe("ready");
  });

  test("syncDashboardRedirect calls router.replace('/') only in the redirect case", () => {
    const calls: string[] = [];
    const router = { replace: (path: string) => calls.push(path) };

    expect(syncDashboardRedirect(router, true, false)).toBe("loading");
    expect(syncDashboardRedirect(router, false, true)).toBe("ready");
    expect(calls).toEqual([]);

    expect(syncDashboardRedirect(router, false, false)).toBe("redirect");
    expect(calls).toEqual(["/"]);
  });

  test("renders nothing until the client mount, including for a signed-in SSR snapshot", () => {
    resetStubCalls();
    currentSession = { data: null, isPending: true };
    expect(renderToStaticMarkup(createElement(TradingApp))).toBe("");
    expect(stubCalls).toEqual([]);

    currentSession = { data: null, isPending: false };
    expect(renderToStaticMarkup(createElement(TradingApp))).toBe("");
    expect(stubCalls).toEqual([]);

    currentSession = { data: { user: { id: "user-1" } }, isPending: false };
    expect(shouldRenderDashboard(false, true, false)).toBe(false);
    expect(renderToStaticMarkup(createElement(TradingApp))).toBe("");
    expect(stubCalls).toEqual([]);
  });
});

describe("terminal shell tab configuration", () => {
  test("keeps trade execution first among the right-rail modules, with AI carrying its bull icon", () => {
    expect(RIGHT_TERMINAL_TABS[0]).toEqual({ value: "trade", label: "Trade" });
    expect(RIGHT_TERMINAL_TABS).toContainEqual({
      value: "ai",
      label: "AI",
      iconSrc: "/brand/rst-bull-ai.png",
    });
    expect(RIGHT_TERMINAL_TABS).toContainEqual({ value: "positions", label: "Positions" });
    expect(RIGHT_TERMINAL_TABS).toContainEqual({ value: "portfolio", label: "Portfolio" });
    expect(RIGHT_TERMINAL_TAB_VALUES).toEqual(RIGHT_TERMINAL_TABS.map((t) => t.value));
  });

  test("bottom activity drawer offers Positions / Open Orders / History / Balances / Portfolio", () => {
    expect(BOTTOM_TERMINAL_TABS.map((t) => t.value)).toEqual([
      "positions",
      "orders",
      "history",
      "balances",
      "portfolio",
    ]);
    expect(BOTTOM_TERMINAL_TABS.find((t) => t.value === "portfolio")?.label).toBe("Portfolio");
    expect(BOTTOM_TERMINAL_TABS.find((t) => t.value === "history")?.label).toBe("History");
    expect(BOTTOM_TERMINAL_TABS.find((t) => t.value === "balances")?.label).toBe("Balances");
  });

  test("every bottom tab has a panel: no label without a surface behind it", () => {
    // A tab in this list with no arm in VenueAwareBottomContent's switch renders
    // `undefined`, i.e. a blank drawer with a highlighted button. The switch is
    // exhaustive over `Exclude<BottomTerminalTab, "closed">`, so what this
    // checks is the other direction: that the list has not gained a value the
    // rendering path has never heard of.
    const renderable: Array<Exclude<BottomTerminalTab, "closed">> = [
      "positions",
      "orders",
      "history",
      "balances",
      "portfolio",
    ];
    for (const tab of BOTTOM_TERMINAL_TABS) {
      expect(renderable).toContain(tab.value as Exclude<BottomTerminalTab, "closed">);
    }
    // And the drawer never offers the mobile-only Closed screen.
    expect(BOTTOM_TERMINAL_TABS.some((t) => t.value === "closed")).toBe(false);
  });

  test("left drawer offers the five discovery surfaces", () => {
    expect(LEFT_TERMINAL_TABS.map((t) => t.value)).toEqual(
      expect.arrayContaining(["x_signals", "signa", "watchlist", "copy_trade", "social"]),
    );
  });

  test("each left tab has a default subheader filter that is one of its own items", () => {
    for (const tab of ["x_signals", "signa", "watchlist", "copy_trade", "social"] as const) {
      const items = LEFT_TERMINAL_SUBHEADERS[tab];
      const defaultAction = DEFAULT_LEFT_SUBHEADER_ACTIONS[tab];
      expect(items.some((item) => item.id === defaultAction)).toBe(true);
    }
  });
});

describe("left subheader bar", () => {
  test("marks the active filter and reports a pick with the tab-scoped action id", () => {
    const picks: unknown[] = [];
    const tree = LeftSubheaderBar({
      tab: "signa",
      activeAction: "risk_reward",
      onSelect: (action) => picks.push(action),
    });

    const items = flattenElements(tree).filter((el) => el.props["data-left-subheader-action"] != null);
    expect(items.map((el) => el.props["data-left-subheader-action"])).toEqual([
      "best_picks",
      "risk_reward",
      "copy_signal",
    ]);

    const active = items.find((el) => el.props["data-left-subheader-action"] === "risk_reward");
    const inactive = items.find((el) => el.props["data-left-subheader-action"] === "best_picks");
    expect(active?.props["aria-pressed"]).toBe(true);
    expect(inactive?.props["aria-pressed"]).toBe(false);

    click(inactive);
    expect(picks).toEqual(["best_picks"]);
  });

  test("hl_markets has no subheader filter buttons", () => {
    const tree = LeftSubheaderBar({
      tab: "hl_markets",
      activeAction: "all_coins",
      onSelect: () => {},
    });
    expect(flattenElements(tree).filter((el) => el.props["data-left-subheader-action"] != null)).toEqual([]);
  });
});

describe("drawer resize handle", () => {
  test("carries the drawer-scoped aria label and range, and forwards raw pointer events", () => {
    const events: string[] = [];
    const tree = DrawerResizeHandle({
      drawerSide: "left",
      ariaLabel: "Resize discovery drawer",
      min: 240,
      max: 520,
      now: 318.6,
      onPointerDown: () => events.push("down"),
      onPointerMove: () => events.push("move"),
      onPointerUp: () => events.push("up"),
      onPointerCancel: () => events.push("cancel"),
    });

    const handle = findByAriaLabel(createElement("div", null, tree), "Resize discovery drawer") ?? tree;
    expect(handle.props.role).toBe("separator");
    expect(handle.props["aria-valuemin"]).toBe(240);
    expect(handle.props["aria-valuemax"]).toBe(520);
    expect(handle.props["aria-valuenow"]).toBe(319); // rounded, matches the old inline handle

    (handle.props.onPointerDown as (e: unknown) => void)({});
    (handle.props.onPointerMove as (e: unknown) => void)({});
    (handle.props.onPointerUp as (e: unknown) => void)({});
    (handle.props.onPointerCancel as (e: unknown) => void)({});
    expect(events).toEqual(["down", "move", "up", "cancel"]);
  });

  test("the modules (right) drawer gets its own aria label", () => {
    const tree = DrawerResizeHandle({
      drawerSide: "right",
      ariaLabel: "Resize modules drawer",
      min: 260,
      max: 480,
      now: 300,
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onPointerCancel: () => {},
    });
    expect(tree.props["aria-label"]).toBe("Resize modules drawer");
  });
});

describe("venue-aware right rail routing (never routes a perps portfolio tab to Alpaca history)", () => {
  test("isPerpsAccountActive requires BOTH the traded venue and the resolved account to agree it's perps", () => {
    expect(isPerpsAccountActive("perps", PERPS_ACCOUNT)).toBe(true);
    // Venue flipped back to stocks: a stale perps account context must not win.
    expect(isPerpsAccountActive("stocks", PERPS_ACCOUNT)).toBe(false);
    // Traded venue says perps but the resolved account context hasn't caught up
    // (or never will, e.g. perps unconfigured): must not show perps data next
    // to what is really an Alpaca credential.
    expect(isPerpsAccountActive("perps", STOCKS_ACCOUNT)).toBe(false);
    expect(isPerpsAccountActive("stocks", STOCKS_ACCOUNT)).toBe(false);
  });

  test("positions/orders/portfolio render the Alpaca surfaces on the stocks venue", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    resetStubCalls();

    renderToStaticMarkup(createElement(VenueAwareRightPositions, { isSignedIn: true, onViewPerpChart: () => {} }));
    renderToStaticMarkup(createElement(VenueAwareRightOrders, { onViewPerpChart: () => {} }));
    renderToStaticMarkup(createElement(VenueAwareRightPortfolio, { credentialId: "cred-1" }));

    expect(stubCalls.map((c) => c.label)).toEqual([
      "PositionsPanel",
      "OpenOrdersPanel",
      "PortfolioHistoryChart",
    ]);
    // The stocks surfaces are always mounted `embedded` in the right rail.
    expect(stubCalls[0].props.embedded).toBe(true);
    expect(stubCalls[1].props.embedded).toBe(true);
    expect(stubCalls[2].props.credentialId).toBe("cred-1");
  });

  test("positions/orders/portfolio render the Hyperliquid surfaces only when the account has actually resolved to perps", () => {
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    resetStubCalls();

    renderToStaticMarkup(createElement(VenueAwareRightPositions, { isSignedIn: true, onViewPerpChart: () => {} }));
    renderToStaticMarkup(createElement(VenueAwareRightOrders, { onViewPerpChart: () => {} }));
    renderToStaticMarkup(createElement(VenueAwareRightPortfolio, {}));

    expect(stubCalls.map((c) => c.label)).toEqual([
      "PerpPositionsPanel",
      "PerpOrdersPanel",
      "PerpPortfolioPanel",
    ]);
    expect(stubCalls[0].props.walletAddress).toBe("0xWALLET");
    expect(stubCalls[0].props.enabled).toBe(true);
  });

  test("falls back to the Alpaca surfaces when the venue says perps but the account context has not (portfolio never leaks to Hyperliquid data on a stale context)", () => {
    currentVenue = { venue: "perps", accountContext: STOCKS_ACCOUNT };
    resetStubCalls();

    renderToStaticMarkup(createElement(VenueAwareRightPortfolio, { credentialId: "cred-9" }));

    expect(stubCalls.map((c) => c.label)).toEqual(["PortfolioHistoryChart"]);
    expect(stubCalls[0].props.credentialId).toBe("cred-9");
  });
});

describe("desktop chart panel order-book rail (perps depth we already fetched)", () => {
  function chartProps(): ComponentProps<typeof VenueAwareChartPanel> {
    return {
      activeSymbol: "SPY",
      activeCoin: "kPEPE",
      stocksAvailable: true,
      perpsAvailable: true,
      onSymbolCommit: () => {},
      onCoinCommit: () => {},
      onSymbolTrade: () => {},
      onCoinTrade: () => {},
      bottomDrawer: null,
      bottomDrawerHeader: null,
      bottomDrawerLabel: "Account activity",
      onBookPriceSelect: () => {},
    };
  }

  /** The element the wrapper hands to TerminalChartPanel as its side rail. */
  function sideRailOf(): { type: unknown; props: Record<string, unknown> } | null {
    const element = VenueAwareChartPanel(chartProps()) as {
      props: { chartSideRail?: { type: unknown; props: Record<string, unknown> } };
    };
    return element.props.chartSideRail ?? null;
  }

  test("mounts the order book on perps, with the canonical coin and the prefill handler", () => {
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const rail = sideRailOf();
    expect(rail?.type).toBe(PerpOrderBook);
    // HL casing is preserved: `KPEPE` is a different (nonexistent) market.
    expect(rail?.props.coin).toBe("kPEPE");
    expect(typeof rail?.props.onSelectPrice).toBe("function");
  });

  test("mounts NO order book on stocks: Alpaca publishes no L2 depth to show", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    expect(sideRailOf()).toBeNull();
  });

  afterEach(() => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
  });
});

describe("shared bottom activity toolbar (stock and perp account views share one component)", () => {
  function bottomProps(
    overrides: Partial<ComponentProps<typeof VenueAwareBottomContent>>,
  ): ComponentProps<typeof VenueAwareBottomContent> {
    return {
      isSignedIn: true,
      activeSymbol: "SPY",
      selectedCredentialId: "cred-1",
      selectedAccountType: "PAPER",
      credentialsLoading: false,
      bottomTerminalTab: "positions",
      perpsWalletAddress: "0xWALLET",
      perpsEnabled: true,
      perpsStatusSettled: true,
      onBrowseSignals: () => {},
      onAskAi: () => {},
      onSelectSymbol: () => {},
      onViewChart: () => {},
      onViewPerpChart: () => {},
      onTrade: () => {},
      ...overrides,
    };
  }

  // VenueAwareBottomContent builds `stocksPositions`/`stocksOrders`/
  // `perpsPositions` unconditionally (they are reused across sub-tabs), so
  // every call's swap log carries all of those regardless of which one is
  // actually returned. What matters is the RETURNED element, so these check
  // `.type` on the actual return value rather than the log order.
  test("the stocks venue renders the Alpaca surface for every sub-tab", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    const byTab = (bottomTerminalTab: Exclude<BottomTerminalTab, "closed">) =>
      (VenueAwareBottomContent(bottomProps({ bottomTerminalTab })) as { type: unknown })
        .type;

    expect(byTab("positions")).toBe(StubPositions);
    expect(byTab("orders")).toBe(StubOpenOrders);
    // History is the closed-order list itself, not the positions panel with a
    // toggle the user still has to find and flip.
    expect(byTab("history")).toBe(StubClosedOrders);
    expect(byTab("balances")).toBe(StubStockBalances);
    expect(byTab("portfolio")).toBe(StubPortfolioHistory);
  });

  test("stocks History and Balances are handed the active account, not a hardcoded one", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    const history = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "history", selectedCredentialId: "cred-42" }),
    ) as { props: Record<string, unknown> };
    const balances = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "balances", selectedCredentialId: "cred-42" }),
    ) as { props: Record<string, unknown> };

    // Both read per-account data (closed orders carry realized P&L, balances
    // carry buying power), so a stale credential shows another account's money.
    expect(history.props.activeCredentialId).toBe("cred-42");
    expect(balances.props.activeCredentialId).toBe("cred-42");
    expect(balances.props.isSignedIn).toBe(true);
  });

  test("the perps venue renders the Hyperliquid surface for EVERY sub-tab (not one fixed panel regardless of the selected sub-tab)", () => {
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const byTab = (bottomTerminalTab: Exclude<BottomTerminalTab, "closed">) =>
      (VenueAwareBottomContent(bottomProps({ bottomTerminalTab })) as { type: unknown })
        .type;

    // A DIFFERENT surface per sub-tab. The old bug this replaces mounted one
    // fixed `PerpBottomPanel` for the whole perps view regardless of which
    // sub-tab was selected; distinct types per tab is exactly what that bug
    // could not produce.
    expect(byTab("positions")).toBe(StubPerpPositions);
    expect(byTab("orders")).toBe(StubPerpOrders);
    // The fills table itself, not the portfolio summary that used to bury it
    // below an equity readout.
    expect(byTab("history")).toBe(StubPerpFills);
    expect(byTab("balances")).toBe(StubPerpBalances);
    expect(byTab("portfolio")).toBe(StubPerpPortfolio);
  });

  test("each venue's History and Balances stay on that venue's data", () => {
    // The drawer shows ONE venue. Perps history reading Alpaca closed orders
    // (or stocks balances reading Hyperliquid collateral) is the composite this
    // drawer deliberately does not do.
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const perpsHistory = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "history" }),
    ) as { type: unknown };
    const perpsBalances = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "balances" }),
    ) as { type: unknown };

    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    const stocksHistory = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "history" }),
    ) as { type: unknown };
    const stocksBalances = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "balances" }),
    ) as { type: unknown };

    expect(perpsHistory.type).toBe(StubPerpFills);
    expect(perpsBalances.type).toBe(StubPerpBalances);
    expect(stocksHistory.type).toBe(StubClosedOrders);
    expect(stocksBalances.type).toBe(StubStockBalances);
  });

  // The drawer used to carry its own All | Stocks | Perps selector, so it could
  // show a venue the rest of the terminal was not in (or an "All" overview
  // stacking both). It now shows ONE table, chosen by the venue at the top of
  // the app: the same props must produce a different surface per venue, and
  // never a two-venue composite.
  test("the drawer follows the app's venue, and shows exactly one venue's table", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    const stocks = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "positions" }),
    ) as { type: unknown };

    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const perps = VenueAwareBottomContent(
      bottomProps({ bottomTerminalTab: "positions" }),
    ) as { type: unknown };

    expect(stocks.type).toBe(StubPositions);
    expect(perps.type).toBe(StubPerpPositions);
  });

  afterEach(() => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
  });
});

describe("header account metrics (shows buying power instead of cash, per venue)", () => {
  function metricsProps(
    overrides: Partial<ComponentProps<typeof VenueAwareHeaderMetrics>> = {},
  ): ComponentProps<typeof VenueAwareHeaderMetrics> {
    return {
      selectedCredentialId: "cred-1",
      perpsWalletAddress: "0xWALLET",
      headerPortfolioValue: 12345.67,
      headerBuyingPower: 500,
      headerPerpsEquity: "250.5",
      ...overrides,
    };
  }

  test("stocks venue: shows Stocks Portfolio and Total Balance, hides Perps Balance even with a wallet connected", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    const markup = renderToStaticMarkup(createElement(VenueAwareHeaderMetrics, metricsProps()));

    expect(markup).toContain("Stocks Portfolio");
    expect(markup).toContain("Total Balance");
    expect(markup).not.toContain("Perps Balance");
    // Old cash-based header pattern this replaced; none of it should ever
    // reappear in the real rendered header.
    expect(markup).not.toContain("headerCash");
    expect(markup).not.toContain("Cash available");
    expect(markup).not.toContain(">Cash<");
    expect(markup).not.toContain("hidden max-w-36 truncate md:inline-flex");
  });

  test("perps venue with a connected wallet: shows all three metrics in Stocks Portfolio -> Perps Balance -> Total Balance order", () => {
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const markup = renderToStaticMarkup(createElement(VenueAwareHeaderMetrics, metricsProps()));

    expect(markup).toContain("Perps Balance");
    expect(markup.indexOf("Stocks Portfolio")).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf("Stocks Portfolio")).toBeLessThan(markup.indexOf("Perps Balance"));
    expect(markup.indexOf("Perps Balance")).toBeLessThan(markup.indexOf("Total Balance"));
  });

  test("perps venue without a connected wallet: Perps Balance stays hidden", () => {
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const markup = renderToStaticMarkup(
      createElement(VenueAwareHeaderMetrics, metricsProps({ perpsWalletAddress: null })),
    );
    expect(markup).not.toContain("Perps Balance");
  });

  test("no broker credential: the stocks metrics are hidden entirely (not shown as $0.00)", () => {
    currentVenue = { venue: "stocks", accountContext: STOCKS_ACCOUNT };
    const markup = renderToStaticMarkup(
      createElement(VenueAwareHeaderMetrics, metricsProps({ selectedCredentialId: undefined })),
    );
    expect(markup).not.toContain("Stocks Portfolio");
  });

  test("missing values fall back to the placeholder dash, not $0.00 or NaN", () => {
    currentVenue = { venue: "perps", accountContext: PERPS_ACCOUNT };
    const markup = renderToStaticMarkup(
      createElement(
        VenueAwareHeaderMetrics,
        metricsProps({
          headerPortfolioValue: null,
          headerBuyingPower: undefined,
          headerPerpsEquity: null,
        }),
      ),
    );
    expect(markup).not.toContain("$0.00");
    expect(markup).not.toContain("NaN");
    expect(markup).toContain(">-<");
  });
});

describe("header account query failures", () => {
  test("drops cached Alpaca values and marks the read failed", () => {
    expect(
      resolveHeaderAccountQueryState({
        data: {
          portfolioValue: 12_345.67,
          nonMarginableBuyingPower: 500,
        },
        isError: true,
      }),
    ).toEqual({
      portfolioValue: undefined,
      buyingPower: undefined,
      failed: true,
    });
  });

  test("keeps values available after a successful account read", () => {
    expect(
      resolveHeaderAccountQueryState({
        data: {
          portfolioValue: 12_345.67,
          nonMarginableBuyingPower: 500,
        },
        isError: false,
      }),
    ).toEqual({
      portfolioValue: 12_345.67,
      buyingPower: 500,
      failed: false,
    });
  });
});

describe("copy actions force the stocks venue (never leave a prior perps pick in effect)", () => {
  test("stockMarketSelection always targets venue \"stocks\", regardless of which venue the copy fired from", () => {
    expect(stockMarketSelection("aapl")).toEqual({ symbol: "AAPL", venue: "stocks" });
    expect(stockMarketSelection("  tsla  ")).toEqual({ symbol: "TSLA", venue: "stocks" });
  });

  test("blank input resolves to no selection instead of a bogus empty-symbol pick", () => {
    expect(stockMarketSelection("")).toBeNull();
    expect(stockMarketSelection("   ")).toBeNull();
  });
});

/**
 * Not converted, and dropped/kept per the assertions they used to bundle:
 *
 *  - `renders the unified left and right terminal drawers` / `adds Fomo-style
 *    drawer subheaders and draggable drawer resize handles` / `turns left
 *    drawer subheaders into pane-scoped interactive controls` /
 *    `wires subheader actions into the real left drawer panels` /
 *    `starts side drawers at their widest adjustable layout` /
 *    `persists drawer collapse and resize state to localStorage` /
 *    `saves the layout to the account so it restores on another browser` /
 *    `keeps a persistent terminal chart synced with trade symbols` /
 *    `keeps trade execution as the first right terminal module` (the
 *    `case "trade":`/`renderPane=`/`<StockChatPanel` half) /
 *    `adds a resizable bottom activity drawer below the chart` /
 *    `keeps a global market ticker below the terminal workspace` /
 *    `opens AI as an intentional popout instead of a persistent trade overlay`:
 *    what these pinned beyond the tab/config data and the two extracted UI
 *    sections above (both now covered) is that the terminal's own JSX threads
 *    a couple dozen pieces of `TradingAppContent` closure state into
 *    `TerminalDrawer`/`VenueAwareChartPanel` correctly (which literal state
 *    variable feeds which prop). None of it is a decision - it is
 *    composition - and every one of these tests was written alongside the
 *    feature that introduced it (git log -S on each turns up a `feat:`
 *    commit, never a `fix:` for a real bug this shape of test caught).
 *    Rendering it for real would mean mounting the entire authenticated
 *    terminal (tRPC, session, venue context, the drawer-layout hook), which
 *    is exactly the god-component this file's own audit note says to
 *    extract OUT of, not build a bigger harness to swallow. Given the
 *    hard budget for this pass, these are left unconverted rather than
 *    forcing a large, risky restructuring of a real-money page for
 *    low-severity, discovery-free wiring facts. A wrong prop here is a
 *    visibly broken drawer, not a silent money-handling bug, and would be
 *    caught immediately by anyone opening the terminal.
 *
 *  - `switches stock copy actions out of the perps venue before prefilling
 *    Trade`: the actual property (a copy action always forces venue
 *    "stocks", normalized) is now pinned directly against
 *    `stockMarketSelection`, the real function `selectStockMarket` calls.
 *    Which handlers call `selectStockMarket` (`handleCopy`,
 *    `handleCopySignaSignal`) is deep TradingAppContent closure wiring for
 *    the same reason as above, and is dropped for the same reason.
 *
 * These are genuine gaps, not claimed conversions; see the report for the
 * full list.
 */

// ---------------------------------------------------------------------------
// The one assertion this file could not convert to real behavior: a React
// effect-timing property. This app has no DOM test environment to actually
// run effects in (renderToStaticMarkup never runs them; see
// app/app/use-terminal-layout-sync.test.ts's own doc comment for the same
// limitation on the layout-sync hook). `VenueAwareLeftTabSync`'s effect used
// to skip its own first run with a `mounted = useRef(false)` guard, which let
// a persisted secondary left-drawer tab outrank the active top-level Stocks
// venue on first load (commit b59122f). The fix removed the guard so the sync
// ALSO applies on mount. There is no pure decision to extract here - the bug
// was the presence of a skip-the-first-effect-run pattern, which is a
// property of the effect's own structure, not of any value it computes -
// so the only way left to guard against it reappearing is to confirm the
// pattern is absent from the function that would carry it again.
// ---------------------------------------------------------------------------
const CRLF = /\r\n/g;
const panelsSource = readFileSync(new URL("./venue-aware-panels.tsx", import.meta.url), "utf8")
  .replace(CRLF, "\n");

describe("left drawer syncs to X Signals whenever Stocks becomes the active venue", () => {
  test("the sync effect has no first-render skip guard", () => {
    const start = panelsSource.indexOf("function VenueAwareLeftTabSync");
    const end = panelsSource.indexOf("function VenueAwareSignalFeed", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const body = panelsSource.slice(start, end);
    expect(body).toContain('if (venue === "stocks") callbackRef.current()');
    expect(body).not.toContain("const mounted = useRef(false)");
  });
});

describe("the mobile Markets screen follows the venue switch", () => {
  // The Markets destination kept its own All / Stocks / Perps browse scope,
  // decoupled from the venue context. Picking a venue at the top of the app
  // left the list under it unchanged, so the one control a user reaches for on
  // that screen appeared to do nothing at all.
  test("scopes the browse list when the traded venue actually changes", async () => {
    const { nextMarketsScopeState } = await import("./venue-aware-panels");

    expect(nextMarketsScopeState("stocks", "perps", true)).toEqual({
      record: "perps",
      scopeTo: "perps",
    });
    expect(nextMarketsScopeState("perps", "stocks", true)).toEqual({
      record: "stocks",
      scopeTo: "stocks",
    });
  });

  test("leaves the discovery default alone on first render and on re-renders", async () => {
    const { nextMarketsScopeState } = await import("./venue-aware-panels");

    // First hydrated run: adopt the venue silently, Markets stays on "All".
    expect(nextMarketsScopeState(null, "stocks", true)).toEqual({
      record: "stocks",
      scopeTo: null,
    });
    expect(nextMarketsScopeState(null, "perps", true)).toEqual({
      record: "perps",
      scopeTo: null,
    });
    // A re-render that did not change venue must not clobber a scope the user
    // widened back to All (or People) with the in-page filter row.
    expect(nextMarketsScopeState("perps", "perps", true)).toEqual({
      record: "perps",
      scopeTo: null,
    });
  });

  // The provider renders a provisional venue before it reads localStorage.
  // Recording that provisional value makes the hydration which restores a
  // returning perps user look like a switch INTO perps, which would narrow the
  // Markets list on first load - the exact default this sync exists to keep.
  test("does not treat venue hydration as a user switch", async () => {
    const { nextMarketsScopeState } = await import("./venue-aware-panels");

    // Pre-hydration: remember nothing, change nothing.
    expect(nextMarketsScopeState(null, "stocks", false)).toEqual({
      record: null,
      scopeTo: null,
    });
    // Hydration then reports the persisted venue. Because nothing provisional
    // was recorded, this is a first run, not a switch.
    expect(nextMarketsScopeState(null, "perps", true)).toEqual({
      record: "perps",
      scopeTo: null,
    });
  });

  test("still scopes when the user switches after hydration settled", async () => {
    const { nextMarketsScopeState } = await import("./venue-aware-panels");

    const hydrated = nextMarketsScopeState(null, "perps", true);
    expect(nextMarketsScopeState(hydrated.record, "stocks", true)).toEqual({
      record: "stocks",
      scopeTo: "stocks",
    });
  });
});

describe("bottom drawer sub-tabs are the same for both venues", () => {
  test("neither venue offers a Closed sub-tab (closed rounds live behind the positions panel's own toggle)", () => {
    // Perps used to carry a fourth sub-tab the stocks side had no counterpart
    // for. Closed perp round-trips are now the Closed half of the positions
    // panel's Open | Closed toggle, which is the control stocks already had,
    // so the two venues' drawers offer the same three tabs.
    expect(PERPS_BOTTOM_TERMINAL_TABS.map((t) => t.value)).toEqual(
      BOTTOM_TERMINAL_TABS.map((t) => t.value),
    );
    expect(PERPS_BOTTOM_TERMINAL_TABS.some((t) => t.value === "closed")).toBe(false);
    expect(BOTTOM_TERMINAL_TABS.some((t) => t.value === "closed")).toBe(false);
  });

  test("a stale Closed selection falls back to Positions", () => {
    // The mobile account shell still routes to a standalone Closed screen and
    // shares this tab type, so the value can still arrive here. No button in
    // this drawer highlights it, which would leave the drawer looking blank.
    expect(resolveBottomSubTab("closed")).toBe("positions");
  });

  test("every other sub-tab is passed through untouched", () => {
    expect(resolveBottomSubTab("positions")).toBe("positions");
    expect(resolveBottomSubTab("orders")).toBe("orders");
    expect(resolveBottomSubTab("history")).toBe("history");
    expect(resolveBottomSubTab("balances")).toBe("balances");
    expect(resolveBottomSubTab("portfolio")).toBe("portfolio");
  });
});

describe("resolveBottomSubTab narrowing", () => {
  test("the drawer can never receive Closed, so no dead arm is needed", () => {
    // The return type proves this at compile time; this pins the runtime half
    // so a refactor that widens it fails here rather than silently rendering
    // the drawer on a tab it does not offer.
    const resolved: Exclude<BottomTerminalTab, "closed"> = resolveBottomSubTab("closed");
    expect(resolved).toBe("positions");
  });
});
