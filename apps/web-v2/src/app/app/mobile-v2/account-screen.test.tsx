import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MobileVenueStack } from "../mobile-venue-stack";
import {
  MobileAccountScreen,
  type MobileAccountScreenProps,
  type MobileAccountTab,
} from "./account-screen";

const accountSummary = createElement(
  "p",
  { role: "status", "aria-live": "polite", "data-testid": "connection-summary" },
  "Checking your connected venues…",
);

const positions = createElement(
  MobileVenueStack,
  {
    stocks: createElement("article", { "data-testid": "stock-position-row" }, "NVDA · 10 shares"),
    perps: createElement("article", { "data-testid": "perp-position-row" }, "BTC · 2x long"),
  },
);

const closed = createElement("article", { "data-testid": "closed-panel" }, "Closed perp round trips");
const orders = createElement("article", { "data-testid": "orders-panel" }, "Open orders");
const portfolio = createElement("article", { "data-testid": "portfolio-panel" }, "Portfolio history");
const ai = createElement("article", { "data-testid": "ai-panel" }, "Account AI");

type InspectableProps = {
  children?: ReactNode;
  [key: string]: unknown;
};
type InspectableElement = ReactElement<InspectableProps>;

function props(
  overrides: Partial<MobileAccountScreenProps> = {},
): MobileAccountScreenProps {
  return {
    activeTab: "positions",
    onTabChange: () => {},
    positions,
    closed,
    orders,
    portfolio,
    ai,
    connectionSummary: accountSummary,
    ...overrides,
  };
}

function elementChildren(element: InspectableElement): InspectableElement[] {
  const children = (element.props as InspectableProps).children;
  return (Array.isArray(children) ? children : [children]).filter(
    (child): child is InspectableElement =>
      Boolean(child) && typeof child === "object" && "props" in child,
  );
}

function findElement(
  element: InspectableElement,
  predicate: (candidate: InspectableElement) => boolean,
): InspectableElement | undefined {
  if (predicate(element)) return element;
  for (const child of elementChildren(element)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function renderAccount(activeTab: MobileAccountTab = "positions") {
  return renderToStaticMarkup(
    createElement(MobileAccountScreen, props({ activeTab })),
  );
}

function renderPlainAccount(
  overrides: Partial<MobileAccountScreenProps> = {},
) {
  return renderToStaticMarkup(
    createElement(
      MobileAccountScreen,
      props({
        positions: createElement(
          "article",
          { "data-testid": "plain-positions" },
          "Positions content",
        ),
        ...overrides,
      }),
    ),
  );
}

describe("MobileAccountScreen", () => {
  test("renders the unified account heading, all destinations, and supplied connection state", () => {
    const markup = renderAccount();

    expect(markup).toContain('aria-labelledby="mobile-account-screen-title"');
    expect(markup).toContain(">Account<");
    expect(markup).toContain("Positions");
    expect(markup).toContain("Closed");
    expect(markup).toContain("Orders");
    expect(markup).toContain("Portfolio");
    expect(markup).toContain(">AI<");
    expect(markup).toContain('data-testid="connection-summary"');
    expect(markup).toContain("Checking your connected venues…");
  });

  test("mounts only the controlled destination panel", () => {
    const markerByTab: Record<MobileAccountTab, string> = {
      positions: 'data-testid="stock-position-row"',
      closed: 'data-testid="closed-panel"',
      orders: 'data-testid="orders-panel"',
      portfolio: 'data-testid="portfolio-panel"',
      ai: 'data-testid="ai-panel"',
    };

    for (const tab of Object.keys(markerByTab) as MobileAccountTab[]) {
      const markup = renderAccount(tab);
      for (const [candidate, marker] of Object.entries(markerByTab)) {
        if (candidate === tab) expect(markup).toContain(marker);
        else expect(markup).not.toContain(marker);
      }
    }
  });

  test("keeps stock and perp position rows in separate venue sections", () => {
    const markup = renderAccount("positions");

    expect(markup).toContain('data-testid="stock-position-row"');
    expect(markup).toContain('data-testid="perp-position-row"');
    expect(markup).toContain("Stocks &amp; options");
    expect(markup).toContain("Perps");
    expect(markup.indexOf("stock-position-row")).toBeLessThan(
      markup.indexOf("perp-position-row"),
    );
  });

  test("preserves loading, connected, and failed venue copy without inventing zero balances", () => {
    const states = [
      "Checking your connected venues…",
      "Connected venues ready.",
      "Could not check your connected venues just now.",
    ];

    for (const message of states) {
      const markup = renderToStaticMarkup(
        createElement(
          MobileAccountScreen,
          props({
            connectionSummary: createElement(
              "p",
              { role: "status", "aria-live": "polite" },
              message,
            ),
          }),
        ),
      );

      expect(markup).toContain(message);
      expect(markup).not.toContain("$0.00");
    }
  });

  test("renders unavailable copy for an empty typed connection summary", () => {
    const emptySummary: MobileAccountScreenProps["connectionSummary"] = {};
    const markup = renderToStaticMarkup(
      createElement(MobileAccountScreen, props({ connectionSummary: emptySummary })),
    );

    expect(markup).toContain("Could not check your connected venues just now.");
    expect(markup).not.toContain("[object Object]");
  });

  test("preserves iterable ReactNode connection summaries", () => {
    const iterableSummary: MobileAccountScreenProps["connectionSummary"] = new Set([
      "Connected from adapter",
    ]);
    const markup = renderToStaticMarkup(
      createElement(MobileAccountScreen, props({ connectionSummary: iterableSummary })),
    );

    expect(markup).toContain("Connected from adapter");
    expect(markup).not.toContain("Could not check your connected venues just now.");
  });

  test("exposes the complete ARIA tabs contract and 44px tab targets", () => {
    const markup = renderAccount("orders");
    const tabListClass = markup.match(
      /role="tablist"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const tabClass = markup.match(
      /id="mobile-account-tab-positions"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const tabStripClass = markup.match(
      /data-mobile-account-tab-strip="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).toContain('role="tablist"');
    expect((markup.match(/role="tab"/g) ?? []).length).toBe(5);
    expect((markup.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect((markup.match(/aria-controls=/g) ?? []).length).toBe(1);
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-controls="mobile-account-panel-orders"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('tabindex="0"');
    expect(tabClass).toContain("min-h-11");
    expect(tabClass).toContain("min-w-0");
    expect(tabClass).toContain("shrink-0");
    expect(tabClass).toContain("whitespace-nowrap");
    expect(tabListClass).toContain("min-w-0");
    expect(tabListClass).toContain("overflow-x-auto");
    expect(tabListClass).toContain("overscroll-x-contain");
    expect(tabListClass).toContain("touch-pan-x");
    expect(tabListClass).not.toContain("overflow-x-clip");
    expect(tabStripClass).toContain("flex");
    expect(tabStripClass).toContain("min-w-max");
    expect(tabStripClass).not.toContain("grid-cols-5");
  });

  test("marks the selected destination with brighter text over a gold rule, not a gold pill", () => {
    // DESIGN.md: gold is a seasoning. The rail is a flat strip on a hairline,
    // like the Traders strip; the selected tab is not a gold-filled pill.
    const markup = renderAccount("orders");
    const selected =
      markup.match(/<button[^>]*id="mobile-account-tab-orders"[^>]*>/)?.[0] ?? "";
    const idle =
      markup.match(/<button[^>]*id="mobile-account-tab-positions"[^>]*>/)?.[0] ?? "";
    const tabStripClass = markup.match(
      /data-mobile-account-tab-strip="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(selected).toContain('aria-selected="true"');
    expect(selected).toContain('data-state="active"');
    expect(selected).toContain("text-white");
    expect(selected).toContain("font-semibold");
    expect(selected).not.toContain("bg-[#e7c65d]");
    expect(selected).not.toContain("rounded-lg");
    expect(idle).toContain("text-[#8da5ad]");
    expect(idle).not.toContain("bg-[");
    expect(tabStripClass).not.toContain("p-1");
    expect(markup.match(/data-mobile-account-tab-rule="true"/g)).toHaveLength(1);
  });

  test("bounds the active panel surface so supplied panels cannot widen the phone", () => {
    const markup = renderPlainAccount({
      positions: createElement(
        "div",
        { className: "min-w-[80rem] whitespace-nowrap" },
        "A very wide supplied panel",
      ),
    });
    const panelSurface = markup.match(
      /data-mobile-account-panel-surface="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).toContain('data-mobile-account-workspace="true"');
    expect(markup).toContain('data-mobile-account-panel-surface="true"');
    expect(panelSurface).toContain("w-full");
    expect(panelSurface).toContain("min-w-0");
    expect(panelSurface).toContain("max-w-full");
    expect(panelSurface).toContain("overflow-x-clip");
  });

  test("leaves vertical scrolling to the mobile frame and avoids nested card framing", () => {
    const markup = renderPlainAccount();
    const screenClass = markup.match(
      /data-testid="mobile-account-screen"[^>]*class="([^"]+)"/,
    )?.[1];
    const panelClass = markup.match(
      /id="mobile-account-panel-positions"[^>]*class="([^"]+)"/,
    )?.[1];
    const innerClass = markup.match(/<div class="([^"]+)"><header/)?.[1];
    const panelSurface = markup.match(
      /data-mobile-account-panel-surface="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).not.toContain("overflow-y-auto");
    expect(markup).not.toContain("overflow-y-scroll");
    expect(screenClass).not.toContain("h-full");
    expect(innerClass).not.toContain("h-full");
    expect(panelClass).not.toContain("flex-1");
    expect(panelSurface).not.toContain("rounded");
    expect(panelSurface).not.toContain("border");
    expect(panelSurface).not.toContain("shadow");
    expect(panelSurface).not.toContain("ring");
  });

  test("shows a visible focus ring on Account tab controls", () => {
    const tree = MobileAccountScreen(props()) as InspectableElement;
    const positionsTab = findElement(
      tree,
      (element) =>
        element.props.id === "mobile-account-tab-positions",
    );
    const closedTab = findElement(
      tree,
      (element) =>
        element.props.id === "mobile-account-tab-closed",
    );

    expect(positionsTab?.props.className).toContain("focus-visible:ring-2");
    expect(closedTab?.props.className).toContain("focus-visible:ring-2");
  });

  test("uses controlled click and keyboard navigation for account tabs", () => {
    const changedTo: MobileAccountTab[] = [];
    const tree = MobileAccountScreen(
      props({ onTabChange: (tab) => changedTo.push(tab) }),
    ) as InspectableElement;
    const ordersTab = findElement(
      tree,
      (element) =>
        element.props.id === "mobile-account-tab-orders",
    );
    const positionsTab = findElement(
      tree,
      (element) =>
        element.props.id === "mobile-account-tab-positions",
    );

    expect(ordersTab).toBeDefined();
    expect(positionsTab).toBeDefined();
    if (!ordersTab || !positionsTab) return;

    (ordersTab.props.onClick as () => void)();
    (positionsTab.props.onKeyDown as (event: unknown) => void)({
      key: "ArrowRight",
      preventDefault: () => {},
    });

    expect(changedTo).toEqual(["orders", "closed"]);
  });

  test("does not hijack vertical arrow keys in the horizontal tablist", () => {
    const changedTo: MobileAccountTab[] = [];
    const tree = MobileAccountScreen(
      props({ onTabChange: (tab) => changedTo.push(tab) }),
    ) as InspectableElement;
    const positionsTab = findElement(
      tree,
      (element) =>
        element.props.id === "mobile-account-tab-positions",
    );

    expect(positionsTab).toBeDefined();
    if (!positionsTab) return;

    for (const key of ["ArrowUp", "ArrowDown"]) {
      let prevented = false;
      (positionsTab.props.onKeyDown as (event: unknown) => void)({
        key,
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(false);
    }

    expect(changedTo).toEqual([]);
  });

  test("does not add fixture totals or static account rows", () => {
    const markup = renderAccount();

    expect(markup).not.toContain("$108,402.18");
    expect(markup).not.toContain("Featured holding");
    expect(markup).not.toContain("Demo data");
  });

  test("keeps the account chrome compact instead of framing the page as nested cards", () => {
    const markup = renderPlainAccount();
    const heroClass = markup.match(
      /data-mobile-account-hero="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const destinationsClass = markup.match(
      /data-mobile-account-destinations="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const surfaceClass = markup.match(
      /data-mobile-account-panel-surface="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).toContain('data-mobile-account-hero="true"');
    expect(markup).not.toContain('data-mobile-account-hero-mark="true"');
    expect(markup).toContain('data-mobile-account-destinations="true"');
    expect(heroClass).toContain("border-b");
    expect(heroClass).not.toContain("rounded");
    expect(heroClass).not.toContain("shadow");
    expect(heroClass).not.toContain("bg-[linear-gradient");
    expect(destinationsClass).toContain("overflow-x-auto");
    expect(destinationsClass).not.toContain("rounded");
    expect(destinationsClass).not.toContain("shadow");
    expect(surfaceClass).not.toContain("rounded");
    expect(surfaceClass).not.toContain("shadow");
    expect(surfaceClass).not.toContain("ring");
  });

  test("treats Spacebar as a keyboard activation for account destinations", () => {
    const changedTo: MobileAccountTab[] = [];
    const tree = MobileAccountScreen(
      props({ onTabChange: (tab) => changedTo.push(tab) }),
    ) as InspectableElement;
    const ordersTab = findElement(
      tree,
      (element) =>
        element.props.id === "mobile-account-tab-orders",
    );

    expect(ordersTab).toBeDefined();
    if (!ordersTab) return;

    let prevented = false;
    (ordersTab.props.onKeyDown as (event: unknown) => void)({
      key: "Spacebar",
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(changedTo).toEqual(["orders"]);
  });

  test("renders a controller-supplied available account value in the hero", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MobileAccountScreen,
        props({
          accountValue: "$12,345.67",
          accountValueState: "available",
        }),
      ),
    );
    const valueClass = markup.match(
      /data-mobile-account-value="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).toContain('data-mobile-account-value-state="available"');
    expect(markup).toContain(">$12,345.67<");
    expect(valueClass).toContain("font-data");
    expect(valueClass).toContain("tabular-nums");
    expect(valueClass).toContain("text-2xl");
  });

  test("keeps long totals and connection copy width-safe at the smallest phone width", () => {
    const markup = renderPlainAccount({
      accountValue: "$123,456,789,012.34",
      accountValueState: "available",
      connectionSummary: {
        state: "connected",
        message: "Connected through a deliberately long venue status message.",
      },
    });
    const valueClass = markup.match(
      /data-mobile-account-value="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const summaryClass = markup.match(
      /data-testid="mobile-account-connection-summary"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).toContain(">$123,456,789,012.34<");
    expect(markup).toContain("Connected through a deliberately long venue status message.");
    expect(valueClass).toContain("min-w-0");
    expect(valueClass).toContain("max-w-full");
    expect(valueClass).toContain("[overflow-wrap:anywhere]");
    expect(valueClass).not.toContain("truncate");
    expect(summaryClass).toContain("min-w-0");
    expect(summaryClass).toContain("max-w-full");
    expect(summaryClass).not.toContain("rounded");
    expect(summaryClass).not.toContain("shadow");
  });

  test("never renders a zero account value while the value is not available", () => {
    for (const accountValueState of [
      "loading",
      "unavailable",
      "partial",
    ] as const) {
      const markup = renderToStaticMarkup(
        createElement(
          MobileAccountScreen,
          props({ accountValue: "$0.00", accountValueState }),
        ),
      );

      expect(markup).toContain(
        `data-mobile-account-value-state="${accountValueState}"`,
      );
      expect(markup).not.toContain("$0.00");
    }
  });

  test("keeps every Account destination reachable through a 320px-safe tab rail", () => {
    const markup = renderAccount();
    const tabListClass = markup.match(
      /data-mobile-account-destinations="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const tabStripClass = markup.match(
      /data-mobile-account-tab-strip="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(tabListClass).toContain("overflow-x-auto");
    expect(tabListClass).toContain("overscroll-x-contain");
    expect(tabListClass).toContain("touch-pan-x");
    expect(tabListClass).not.toContain("overflow-x-clip");
    expect(tabStripClass).toContain("min-w-max");
    expect(tabStripClass).toContain("flex");
    expect(tabStripClass).not.toContain("grid-cols-5");
  });
});
