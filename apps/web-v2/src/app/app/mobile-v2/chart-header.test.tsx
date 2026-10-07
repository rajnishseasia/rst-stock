import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "@/components/ui/empty-state";
import { click, findByAriaLabel, flattenElements } from "@/testing/element-tree";
import {
  MobileChartEmptyState,
  MobileChartHeader,
  quoteFreshnessClass,
} from "./chart-header";

const freshness = { label: "Live", tone: "live" as const };

describe("MobileChartHeader", () => {
  test("shows a contextual Back with the supplied name and routes it", () => {
    const calls: string[] = [];
    const tree = MobileChartHeader({
      symbol: "NVDA",
      freshness,
      backLabel: "Back to Traders",
      onBack: () => calls.push("back"),
    });
    const markup = renderToStaticMarkup(tree);

    expect(markup).toContain('data-mobile-chart-header="true"');
    expect(markup).toContain('aria-label="Back to Traders"');
    expect(markup).toContain(">NVDA<");
    expect(markup).toContain(">Chart NVDA</h1>");
    expect(markup).toContain(">Live<");
    expect(markup).toContain(quoteFreshnessClass("live"));

    click(findByAriaLabel(tree, "Back to Traders"));
    expect(calls).toEqual(["back"]);
  });

  test("hides Back on the Trade home and carries no Trade CTA of its own", () => {
    // A chart reached from the nav or a cold open has nowhere to go back to,
    // so no dead arrow is painted; the nav is the way out. The header also
    // offers no Trade button: it renders only when a market resolved, which is
    // the same condition that pins Buy/Sell above the nav, so a header CTA
    // would duplicate a control already on screen.
    const calls: string[] = [];
    const tree = MobileChartHeader({
      symbol: "SPY",
      freshness,
      backLabel: null,
      onBack: () => calls.push("back"),
    });
    const markup = renderToStaticMarkup(tree);

    expect(markup).not.toContain("aria-label=\"Back");
    expect(markup).toContain(">SPY<");
    expect(markup).not.toContain(">Trade</button>");

    const trade = flattenElements(tree).find(
      (element) => element.props.children === "Trade",
    );
    expect(trade).toBeUndefined();
  });

  // Trade lost the pinned venue bar with every other mobile screen. It is the
  // one destination the venue changes completely (the charted market, the
  // insight tabs, the ticket the pinned pair opens), so the control moved into
  // this row rather than disappearing.
  test("ends the instrument row with the venue switch when one is supplied", () => {
    const withVenue = renderToStaticMarkup(
      MobileChartHeader({
        symbol: "BTC",
        freshness,
        backLabel: null,
        onBack: () => {},
        venueSwitch: createElement(
          "div",
          { "data-testid": "venue-switch" },
          "Stocks | Perps",
        ),
      }),
    );

    expect(withVenue).toContain('data-mobile-chart-venue="true"');
    expect(withVenue).toContain('data-testid="venue-switch"');
    // Symbol first, venue last: the row still leads with what you are looking
    // at, and stays one row.
    expect(withVenue.indexOf(">BTC<")).toBeLessThan(
      withVenue.indexOf('data-mobile-chart-venue="true"'),
    );
    expect((withVenue.match(/data-mobile-chart-venue="true"/g) ?? []).length).toBe(1);
  });

  test("paints no venue cell for a deployment that has no second venue", () => {
    const markup = renderToStaticMarkup(
      MobileChartHeader({ symbol: "SPY", freshness, backLabel: null, onBack: () => {} }),
    );

    expect(markup).not.toContain("data-mobile-chart-venue");
  });

  test("gives every freshness tone a distinct pill", () => {
    const classes = (["live", "refreshing", "stale", "error", "idle"] as const).map(
      quoteFreshnessClass,
    );
    expect(new Set(classes).size).toBe(classes.length);
  });
});

describe("MobileChartEmptyState", () => {
  test("names the next action instead of a blank chart, Search first", () => {
    const calls: string[] = [];
    const tree = MobileChartEmptyState({
      onSearch: () => calls.push("search"),
      onBrowse: () => calls.push("browse"),
    });
    const markup = renderToStaticMarkup(tree);

    expect(markup).toContain('data-mobile-chart-empty="true"');
    expect(markup).toContain("Pick a market to trade");
    expect(markup).toContain(">Search markets</button>");
    expect(markup).toContain(">Browse markets</button>");
    expect(markup).toContain('id="mobile-chart-screen-title"');

    const empty = flattenElements(tree).find(
      (element) => element.type === EmptyState,
    );
    const actions = empty?.props.actions as Array<{
      label: string;
      emphasis?: string;
      onClick: () => void;
    }>;
    expect(actions.map((action) => action.label)).toEqual([
      "Search markets",
      "Browse markets",
    ]);
    expect(actions[0]?.emphasis).toBeUndefined();
    expect(actions[1]?.emphasis).toBe("secondary");
    actions[0]?.onClick();
    actions[1]?.onClick();
    expect(calls).toEqual(["search", "browse"]);
  });

  // With no market for the venue, the venue is the likeliest explanation for
  // the emptiness, so the control the resolved header carries stays here too.
  test("keeps the venue switch when no market resolved", () => {
    const markup = renderToStaticMarkup(
      MobileChartEmptyState({
        onSearch: () => {},
        onBrowse: () => {},
        venueSwitch: createElement(
          "div",
          { "data-testid": "venue-switch" },
          "Stocks | Perps",
        ),
      }),
    );

    expect(markup).toContain('data-mobile-chart-venue="true"');
    expect(markup).toContain('data-testid="venue-switch"');
    expect(markup).toContain("Pick a market to trade");
  });
});
