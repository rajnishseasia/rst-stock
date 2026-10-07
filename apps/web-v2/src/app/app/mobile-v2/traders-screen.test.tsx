import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MOBILE_TRADERS_TABS,
  MobileTradersScreen,
  mobileTradersPanelFlow,
  type MobileTradersTab,
} from "./traders-screen";
import {
  click,
  findByAriaLabel,
  flattenElements,
} from "@/testing/element-tree";

const FEED = <div data-testid="production-feed">Live signal feed</div>;
const COPY_FEED = <div data-testid="production-copy-feed">Following feed</div>;
const X_CALLERS = <div data-testid="production-x-callers">Top X body</div>;
const USERS = <div data-testid="production-users">Top users body</div>;
const WATCHLIST = <div data-testid="production-watchlist">Watchlist rows</div>;
const RISK_ACTION = (
  <button type="button" data-testid="production-risk-settings">
    Manage copy risk settings
  </button>
);

const PRODUCTION_SLOTS = [
  "production-feed",
  "production-copy-feed",
  "production-x-callers",
  "production-users",
  "production-watchlist",
] as const;

function screenTree(
  activeTab: MobileTradersTab = "feed",
  onTabChange: (tab: MobileTradersTab) => void = () => {},
) {
  return MobileTradersScreen({
    activeTab,
    onTabChange,
    feed: FEED,
    copyFeed: COPY_FEED,
    xCallers: X_CALLERS,
    users: USERS,
    watchlist: WATCHLIST,
    riskSettingsAction: RISK_ACTION,
    deploymentState: "unknown",
  });
}

function withFocusableDocument<T>(run: (focused: string[]) => T): T {
  const focused: string[] = [];
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById(id: string) {
        return { focus: () => focused.push(id) };
      },
    },
  });
  try {
    return run(focused);
  } finally {
    if (previousDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  }
}

describe("MobileTradersScreen", () => {
  test("paints Feed, Following, Top X, Top Users and Watchlist as one tablist, in that order", () => {
    const tree = screenTree();
    const tabs = flattenElements(tree).filter(
      (element) => element.props.role === "tab",
    );
    const markup = renderToStaticMarkup(tree);

    expect(tabs.map((tab) => tab.props["aria-label"])).toEqual([
      "Feed",
      "Following",
      "Top X",
      "Top Users",
      "Watchlist",
    ]);
    expect(tabs.map((tab) => tab.props["data-mobile-traders-tab"])).toEqual(
      MOBILE_TRADERS_TABS.map((tab) => tab.value),
    );
    expect(markup.match(/role="tablist"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Traders sections"');
  });

  test("pays for one screen header: a hidden landmark title and the strip, no eyebrow, title or description row", () => {
    const markup = renderToStaticMarkup(screenTree());

    expect(markup).toMatch(/<h1[^>]*class="sr-only"[^>]*>Traders<\/h1>/);
    expect(markup.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("<p");
    // The strip is the first thing after the landmark title.
    expect(markup.indexOf("</h1>")).toBeLessThan(markup.indexOf('role="tablist"'));
    expect(markup.indexOf('role="tablist"')).toBeLessThan(
      markup.indexOf('data-testid="production-feed"'),
    );
  });

  test("mounts exactly the panel for the selected tab; the other four are absent, not hidden", () => {
    const cases: Array<[MobileTradersTab, (typeof PRODUCTION_SLOTS)[number]]> = [
      ["feed", "production-feed"],
      ["following", "production-copy-feed"],
      ["x-callers", "production-x-callers"],
      ["users", "production-users"],
      ["watchlist", "production-watchlist"],
    ];

    for (const [tab, expected] of cases) {
      const markup = renderToStaticMarkup(screenTree(tab));
      const mounted = PRODUCTION_SLOTS.filter((slot) =>
        markup.includes(`data-testid="${slot}"`),
      );
      expect(mounted).toEqual([expected]);
      expect(markup).toContain(`data-mobile-traders-active-tab="${tab}"`);
      // Absent, not hidden: exactly one panel element is in the markup, and no
      // panel is painted and then hidden. Asserted on the panel itself rather
      // than by searching the whole string for "hidden", which also matches the
      // tab strip's scrollbar-hiding utility.
      expect(markup.match(/data-mobile-traders-panel="/g) ?? []).toHaveLength(1);
      expect(markup).not.toContain('hidden=""');
      expect(markup).not.toContain("display:none");
    }
  });

  test("keeps every Copy feature reachable on the three Copy tabs, and off the feed and watchlist", () => {
    for (const tab of ["following", "x-callers", "users"] as const) {
      const markup = renderToStaticMarkup(screenTree(tab));
      expect(markup).toContain('data-testid="mobile-copy-panel"');
      expect(markup).toContain('data-mobile-copy-disclosure="true"');
      expect(markup).toContain("Automation and copy risk");
      expect(markup).toContain('data-testid="mobile-copy-deployment-state"');
      expect(markup).toContain('data-testid="production-risk-settings"');
    }
    for (const tab of ["feed", "watchlist"] as const) {
      const markup = renderToStaticMarkup(screenTree(tab));
      expect(markup).not.toContain('data-testid="mobile-copy-panel"');
      expect(markup).not.toContain("Automation and copy risk");
      expect(markup).not.toContain('data-testid="production-risk-settings"');
    }
  });

  // Traders lost the pinned venue bar with every other mobile screen. It is
  // handed the control instead, and passes it to the ONE tab the venue scopes
  // (Following, whose copy feed is queried with the venue-derived asset
  // class). The five-tab strip keeps its full width on every tab.
  test("routes a supplied venue switch to Following, and keeps it out of the tab strip", () => {
    const rendered = (tab: MobileTradersTab) =>
      renderToStaticMarkup(
        MobileTradersScreen({
          activeTab: tab,
          onTabChange: () => {},
          feed: FEED,
          copyFeed: COPY_FEED,
          xCallers: X_CALLERS,
          users: USERS,
          watchlist: WATCHLIST,
          venueSwitch: <div data-testid="venue-switch">Stocks | Perps</div>,
        }),
      );

    const following = rendered("following");
    expect(following).toContain('data-testid="venue-switch"');
    // Below the strip, not inside it: the tablist is still the screen's only
    // control row and still owns its whole width.
    expect(following.indexOf('role="tablist"')).toBeLessThan(
      following.indexOf('data-testid="venue-switch"'),
    );
    const tablist = flattenElements(rendered("following")).find(
      (element) => element.props.role === "tablist",
    );
    expect(renderToStaticMarkup(tablist!)).not.toContain(
      'data-testid="venue-switch"',
    );

    for (const tab of ["feed", "x-callers", "users", "watchlist"] as const) {
      expect(rendered(tab)).not.toContain('data-testid="venue-switch"');
    }
  });

  test("switches tabs through the controller", () => {
    const selected: MobileTradersTab[] = [];
    const tree = screenTree("feed", (tab) => selected.push(tab));

    click(findByAriaLabel(tree, "Top X"));
    click(findByAriaLabel(tree, "Watchlist"));
    click(findByAriaLabel(tree, "Following"));
    click(findByAriaLabel(tree, "Top Users"));
    click(findByAriaLabel(tree, "Feed"));

    expect(selected).toEqual(["x-callers", "watchlist", "following", "users", "feed"]);
  });

  test("moves focus and selection with horizontal arrow keys, wrapping at the ends", () => {
    withFocusableDocument((focused) => {
      const selected: MobileTradersTab[] = [];
      const tree = screenTree("users", (tab) => selected.push(tab));
      const topUsers = findByAriaLabel(tree, "Top Users");

      expect(topUsers).toBeDefined();
      if (!topUsers) return;

      for (const key of ["ArrowRight", "ArrowLeft"]) {
        (topUsers.props.onKeyDown as (event: unknown) => void)({
          key,
          preventDefault: () => {},
        });
      }
      const watchlist = findByAriaLabel(tree, "Watchlist");
      // Guarded rather than called straight through the optional chain: a
      // missing element must fail as an assertion, not a TypeError.
      const onWatchlist = watchlist?.props.onKeyDown as
        | ((event: unknown) => void)
        | undefined;
      expect(typeof onWatchlist).toBe("function");
      onWatchlist?.({
        key: "ArrowRight",
        preventDefault: () => {},
      });

      expect(selected).toEqual(["watchlist", "x-callers", "feed"]);
      expect(focused).toEqual([
        "mobile-traders-tab-watchlist",
        "mobile-traders-tab-x-callers",
        "mobile-traders-tab-feed",
      ]);
    });
  });

  test("moves focus and selection to the ends with Home and End", () => {
    withFocusableDocument((focused) => {
      const selected: MobileTradersTab[] = [];
      const tree = screenTree("x-callers", (tab) => selected.push(tab));
      const topX = findByAriaLabel(tree, "Top X");

      for (const key of ["Home", "End"]) {
        // Guarded rather than called straight through the optional chain: a
        // missing element must fail as an assertion, not a TypeError.
        const onTopX = topX?.props.onKeyDown as
          | ((event: unknown) => void)
          | undefined;
        expect(typeof onTopX).toBe("function");
        onTopX?.({
          key,
          preventDefault: () => {},
        });
      }

      expect(selected).toEqual(["feed", "watchlist"]);
      expect(focused).toEqual([
        "mobile-traders-tab-feed",
        "mobile-traders-tab-watchlist",
      ]);
    });
  });

  test("leaves vertical arrows available for page scrolling", () => {
    withFocusableDocument((focused) => {
      const selected: MobileTradersTab[] = [];
      let prevented = 0;
      const tree = screenTree("x-callers", (tab) => selected.push(tab));
      const topX = findByAriaLabel(tree, "Top X");

      for (const key of ["ArrowUp", "ArrowDown"]) {
        // Guarded rather than called straight through the optional chain: a
        // missing element must fail as an assertion, not a TypeError.
        const onTopX = topX?.props.onKeyDown as
          | ((event: unknown) => void)
          | undefined;
        expect(typeof onTopX).toBe("function");
        onTopX?.({
          key,
          preventDefault: () => {
            prevented += 1;
          },
        });
      }

      expect(selected).toEqual([]);
      expect(focused).toEqual([]);
      expect(prevented).toBe(0);
    });
  });

  test("treats Spacebar as a keyboard activation", () => {
    const selected: MobileTradersTab[] = [];
    const tree = screenTree("feed", (tab) => selected.push(tab));
    const following = findByAriaLabel(tree, "Following");

    let prevented = false;
    // Guarded rather than called straight through the optional chain: a
    // missing element must fail as an assertion, not a TypeError.
    const onFollowing = following?.props.onKeyDown as
      | ((event: unknown) => void)
      | undefined;
    expect(typeof onFollowing).toBe("function");
    onFollowing?.({
      key: "Spacebar",
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(selected).toEqual(["following"]);
  });

  test("uses tab ARIA for the mounted panel only and keeps it focusable", () => {
    const tree = screenTree("x-callers");
    const tabs = flattenElements(tree).filter((element) => element.props.role === "tab");
    const panel = flattenElements(tree).find(
      (element) => element.props.role === "tabpanel",
    );

    expect(tabs).toHaveLength(5);
    expect(tabs.find((tab) => tab.props["aria-label"] === "Top X")?.props["aria-controls"]).toBe(
      "mobile-traders-panel-x-callers",
    );
    expect(tabs.filter((tab) => tab.props["aria-controls"] !== undefined)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.props["aria-selected"] === true)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.props.tabIndex === 0)).toHaveLength(1);
    expect(tabs.every((tab) => tab.props["aria-pressed"] === undefined)).toBe(true);
    expect(panel?.props.id).toBe("mobile-traders-panel-x-callers");
    expect(panel?.props["aria-labelledby"]).toBe("mobile-traders-tab-x-callers");
    expect(panel?.props.tabIndex).toBe(0);
  });

  test("marks the active tab with brighter text and a hairline gold rule, never a gold fill", () => {
    const tree = screenTree("users");
    const active = findByAriaLabel(tree, "Top Users");
    const idle = findByAriaLabel(tree, "Feed");
    const rules = flattenElements(tree).filter(
      (element) => element.props["data-mobile-traders-tab-rule"] === "true",
    );

    expect(active?.props.className).toContain("text-white");
    expect(active?.props.className).toContain("font-semibold");
    expect(idle?.props.className).toContain("text-[#8da5ad]");
    // Gold is a seasoning: the rule under the active label is the only gold.
    expect(rules).toHaveLength(1);
    expect(rules[0]?.props.className).toContain("h-0.5");
    expect(rules[0]?.props.className).toContain("bg-[#e7c65d]");
    for (const tab of flattenElements(tree).filter((element) => element.props.role === "tab")) {
      expect(tab.props.className).not.toContain("bg-[#e7c65d]");
      expect(tab.props.className).not.toContain("rounded-full");
      expect(tab.props.className).not.toContain("text-[#1c1a0f]");
      expect(tab.props.className).toContain("focus-visible:ring-2");
      expect(tab.props.className).toContain("min-h-11");
    }
  });

  test("keeps the strip to one row that scrolls sideways in its own container rather than wrapping", () => {
    const tablist = flattenElements(screenTree()).find(
      (element) => element.props.role === "tablist",
    );
    const tabs = flattenElements(screenTree()).filter(
      (element) => element.props.role === "tab",
    );

    expect(tablist?.props.className).toContain("flex");
    expect(tablist?.props.className).toContain("overflow-x-auto");
    expect(tablist?.props.className).not.toContain("flex-wrap");
    expect(tablist?.props.className).not.toContain("grid");
    // Sideways only: the strip must never become a vertical scroller.
    expect(tablist?.props.className).not.toContain("overflow-y-auto");
    expect(tablist?.props.className).not.toContain("max-h-");
    for (const tab of tabs) {
      expect(tab.props.className).toContain("whitespace-nowrap");
      expect(tab.props.className).toContain("shrink-0");
    }
  });

  test("leaves vertical scrolling to the shell: no bound, no scroller of its own", () => {
    for (const tab of MOBILE_TRADERS_TABS.map((entry) => entry.value)) {
      const tree = screenTree(tab);
      const elements = flattenElements(tree);
      const screen = elements.find(
        (element) => element.props["data-testid"] === "mobile-traders-screen",
      );
      const panel = elements.find((element) => element.props.role === "tabpanel");

      expect(screen?.props.className).toContain("flex-1");
      for (const element of [screen, panel]) {
        expect(element?.props.className).not.toContain("h-full");
        expect(element?.props.className).not.toContain("min-h-0");
        expect(element?.props.className).not.toContain("overflow-y-auto");
        expect(element?.props.className).not.toContain("overflow-hidden");
        expect(element?.props.className).not.toContain("overscroll-contain");
      }
    }
  });

  test("grows the feed into the shell's slack and keeps the watchlist in a block chain", () => {
    // Feed: `flex-1` so its empty state can center. Watchlist: WatchlistPanel
    // carries `h-full min-h-0` with an inner scroller, and a flex column above
    // it would resolve that height and switch the scroller on.
    expect(mobileTradersPanelFlow("feed")).toContain("flex-1");
    expect(mobileTradersPanelFlow("watchlist")).not.toContain("flex");
    expect(mobileTradersPanelFlow("watchlist")).not.toContain("overflow-y-auto");
    for (const tab of ["following", "x-callers", "users"] as const) {
      expect(mobileTradersPanelFlow(tab)).not.toContain("flex-1");
    }

    const feedPanel = flattenElements(screenTree("feed")).find(
      (element) => element.props.role === "tabpanel",
    );
    const watchlistPanel = flattenElements(screenTree("watchlist")).find(
      (element) => element.props.role === "tabpanel",
    );
    expect(feedPanel?.props.className).toContain("flex-1");
    expect(watchlistPanel?.props.className).not.toContain("flex");
  });

  // The leaderboard is a destination tab here, not a menu link: Top X and Top
  // Users mount the same two ranked bodies /lb renders. The entry the Copy
  // panel paints must therefore be a tab switch on this screen, so the shell,
  // the bottom nav and the screen state all survive the jump.
  test("hands the Copy panel an in-shell leaderboard entry, not a route out", () => {
    const selected: MobileTradersTab[] = [];
    const copyPanel = flattenElements(
      screenTree("following", (tab) => selected.push(tab)),
    ).find(
      (element) => typeof element.props.onOpenLeaderboard === "function",
    );
    const openLeaderboard = copyPanel?.props.onOpenLeaderboard as
      | (() => void)
      | undefined;

    expect(typeof openLeaderboard).toBe("function");
    withFocusableDocument((focused) => {
      openLeaderboard?.();
      // Focus follows the tab the strip now shows as selected.
      expect(focused).toEqual(["mobile-traders-tab-x-callers"]);
    });
    expect(selected).toEqual(["x-callers"]);
  });

  test("names no leaderboard entry on the panels that are not Copy surfaces", () => {
    for (const tab of ["feed", "watchlist"] as const) {
      const withHandler = flattenElements(screenTree(tab)).find(
        (element) => typeof element.props.onOpenLeaderboard === "function",
      );
      expect(withHandler).toBeUndefined();
    }
  });

  test("falls back to the first tab for an unknown controlled value", () => {
    const markup = renderToStaticMarkup(
      screenTree("copy" as unknown as MobileTradersTab),
    );

    expect(markup).toContain('data-mobile-traders-active-tab="feed"');
    expect(markup).toContain('data-testid="production-feed"');
  });
});
