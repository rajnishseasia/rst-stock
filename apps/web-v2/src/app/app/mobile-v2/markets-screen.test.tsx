import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MobileMarketsScreen,
  type MobileMarketsScreenProps,
} from "./markets-screen";

const accountSummary = createElement(
  "div",
  { "data-testid": "account-summary" },
  createElement("span", null, "Checking your account…"),
);
const marketBrowse = createElement(
  "div",
  { "data-testid": "market-browse" },
  "Browse panel",
);

type InspectableProps = {
  children?: ReactNode;
  [key: string]: unknown;
};
type InspectableElement = ReactElement<InspectableProps>;

function props(
  overrides: Partial<MobileMarketsScreenProps> = {},
): MobileMarketsScreenProps {
  return {
    accountSummary,
    marketBrowse,
    onOpenSearch: () => {},
    ...overrides,
  };
}

function elementChildren(element: ReactElement): InspectableElement[] {
  const children = (element.props as InspectableProps).children;
  return (Array.isArray(children) ? children : [children]).filter(
    (child): child is InspectableElement =>
      Boolean(child) && typeof child === "object" && "props" in child,
  );
}

function findElement(
  element: ReactElement,
  predicate: (candidate: InspectableElement) => boolean,
): InspectableElement | undefined {
  const inspectable = element as InspectableElement;
  if (predicate(inspectable)) return inspectable;
  for (const child of elementChildren(element)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

describe("MobileMarketsScreen", () => {
  test("renders the production Browse panel and nothing else to switch to", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props()),
    );

    expect(markup).toContain("Markets");
    expect(markup).toContain('data-testid="market-browse"');
    // The watchlist is a Traders tab now, so Markets carries no section
    // switch: no Browse/Watchlist pair and no second control row.
    expect(markup).not.toContain("Watchlist");
    expect(markup).not.toContain('data-mobile-markets-sections="true"');
    expect(markup).not.toContain('aria-label="Browse"');
  });

  test("keeps account context in the shared shell instead of repeating it above the list", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props()),
    );

    expect(markup).not.toContain('data-testid="account-summary"');
    expect(markup).not.toContain("Checking your account");
    expect(markup.indexOf('data-mobile-markets-header="true"')).toBeLessThan(
      markup.indexOf('data-mobile-markets-content="browse"'),
    );
  });

  test("exposes a Search action that invokes the supplied callback", () => {
    let searchOpened = 0;
    const tree = MobileMarketsScreen(
      props({ onOpenSearch: () => (searchOpened += 1) }),
    ) as InspectableElement;
    const search = findElement(
      tree,
      (element) => element.props["aria-label"] === "Search markets",
    );

    expect(search).toBeDefined();
    (search!.props.onClick as () => void)();
    expect(searchOpened).toBe(1);
  });

  test("hosts the venue switch in its first control row instead of a pinned bar of its own", () => {
    const withVenue = renderToStaticMarkup(
      createElement(
        MobileMarketsScreen,
        props({
          venueSwitch: createElement(
            "div",
            { "data-testid": "venue-switch" },
            "Stocks | Perps",
          ),
        }),
      ),
    );
    const without = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props()),
    );
    const header = withVenue.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";

    // Venue, then Search: one row, in that order.
    expect(header).toContain('data-testid="venue-switch"');
    expect(header.indexOf('data-mobile-markets-venue="true"')).toBeLessThan(
      header.indexOf('aria-label="Search markets"'),
    );
    // No visible title row: the h1 stays for the landmark only.
    expect(withVenue).toMatch(/<h1[^>]*class="sr-only"[^>]*>Markets<\/h1>/);
    expect(without).not.toContain('data-mobile-markets-venue="true"');
  });

  test("gives the Search action a 44px touch target", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props()),
    );

    expect(markup).toContain("min-h-11");
    expect(markup).toContain("min-w-11");
  });

  test("ports the preview's compact dark market hierarchy onto the live panel slot", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props()),
    );

    expect(markup).toContain("bg-[#020f16]");
    expect(markup).toContain("focus-visible:ring-[#e7c65d]");
  });

  test("does not introduce fixture prices, movers, or a Signals feed", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props()),
    );

    expect(markup).not.toContain("Market movers");
    expect(markup).not.toContain("Featured signal");
    expect(markup).not.toContain("$108,402.18");
  });

  test("keeps the panel surface flat: no card around the live list", () => {
    const tree = MobileMarketsScreen(props()) as InspectableElement;
    const markup = renderToStaticMarkup(tree);
    const panelSurface = findElement(
      tree,
      (element) => element.props["data-mobile-markets-panel-surface"] === "true",
    );

    expect(markup).toContain('data-mobile-markets-header="true"');
    expect(markup).toContain('data-mobile-markets-panel-state="ready"');
    expect(panelSurface?.props.className).not.toContain("rounded");
    expect(panelSurface?.props.className).not.toContain("border-[#193742]");
    expect(panelSurface?.props.className).not.toContain("bg-[#071a23]");
    expect(panelSurface?.props.className).not.toContain("shadow-");
  });

  test("shows a neutral unavailable state when the Browse slot is absent", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileMarketsScreen, props({ marketBrowse: null })),
    );

    expect(markup).toContain('data-mobile-markets-panel-state="unavailable"');
    expect(markup).toContain("Market data unavailable.");
  });

  test("grows Browse into the shell's free space without bounding or scrolling it", () => {
    const tree = MobileMarketsScreen(props()) as InspectableElement;
    const screen = findElement(
      tree,
      (element) => element.props["data-testid"] === "mobile-markets-screen",
    );
    const panel = findElement(
      tree,
      (element) => element.props["data-mobile-markets-panel"] === "browse",
    );
    const content = findElement(
      tree,
      (element) => element.props["data-mobile-markets-content"] === "browse",
    );

    // Growth, so an empty state can center in the slack...
    expect(screen?.props.className).toContain("flex-1");
    expect(panel?.props.className).toContain("flex-1");
    expect(content?.props.className).toContain("flex-1");
    // ...but never a bound or a second scroller: `main` is the only one.
    for (const element of [screen, panel, content]) {
      expect(element?.props.className).not.toContain("h-full");
      expect(element?.props.className).not.toContain("min-h-0");
      expect(element?.props.className).not.toContain("overflow-y-auto");
      expect(element?.props.className).not.toContain("overflow-hidden");
    }
  });
});
