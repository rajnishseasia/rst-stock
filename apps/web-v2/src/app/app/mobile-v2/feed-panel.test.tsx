import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { click, findByAriaLabel, flattenElements } from "@/testing/element-tree";

import {
  MobileFeedPanel,
  normalizeMobileFeedVenueFilter,
  visibleMobileFeedVenueFilters,
  type MobileFeedStatus,
  type MobileFeedVenueFilter,
} from "./feed-panel";

function renderFeed({
  venueFilter = "all",
  perpsAvailable = true,
  status,
}: {
  venueFilter?: MobileFeedVenueFilter;
  perpsAvailable?: boolean;
  status?: MobileFeedStatus;
} = {}) {
  return renderToStaticMarkup(
    <MobileFeedPanel
      signalFeed={
        <div data-testid="venue-aware-signal-feed">
          <article data-testid="live-signal">A real signal</article>
        </div>
      }
      venueFilter={venueFilter}
      perpsAvailable={perpsAvailable}
      onVenueFilterChange={() => {}}
      status={status}
    />,
  );
}

describe("MobileFeedPanel", () => {
  test("does not claim Live when transport status is not supplied", () => {
    const html = renderFeed();

    expect(html).not.toContain('data-mobile-feed-status="live"');
    expect(html).not.toContain('aria-label="Live feed status"');
    expect(html).not.toMatch(
      /data-mobile-feed-live-indicator="true"[^>]*>Live<\//,
    );
  });

  test("establishes a premium live-data hierarchy around the supplied feed", () => {
    const html = renderFeed({ venueFilter: "stocks", status: "live" });

    expect(html).toContain('data-mobile-feed-header="true"');
    expect(html).toContain('data-mobile-feed-live-indicator="true"');
    expect(html).toContain('data-mobile-feed-scope="stocks"');
    expect(html).toMatch(
      /data-mobile-feed-live-indicator="true"[^>]*>Live<\//,
    );
    expect(html).toContain('data-mobile-feed-scope-rule="true"');
    expect(html).not.toContain("text-[#1c1a0f]");

    for (const label of ["All", "Stocks", "Perps"]) {
      expect(html).toMatch(
        new RegExp(`aria-label="${label}"[^>]*class="[^"]*min-h-11`),
      );
    }
  });

  test("is a panel, not a screen: no wrapper section, heading, gutter or second shell", () => {
    // The Traders screen owns the section, the h1 and the gutters. A second
    // set here would cost the merged destination the chrome the merge exists
    // to remove, and a second h1 would double the landmark.
    const tree = MobileFeedPanel({
      signalFeed: <div data-testid="live-signal-feed" />,
      venueFilter: "all",
      perpsAvailable: true,
      onVenueFilterChange: () => {},
      status: "live",
    });
    const html = renderToStaticMarkup(tree);
    const elements = flattenElements(tree);
    const root = elements[0];
    const header = elements.find(
      (element) => element.props["data-mobile-feed-header"] === "true",
    );
    const scope = elements.find(
      (element) => element.props["data-mobile-feed-scope"] === "all",
    );
    const content = elements.find(
      (element) => element.props["data-testid"] === "mobile-feed-content",
    );

    expect(root?.type).toBe("div");
    expect(root?.props["data-testid"]).toBe("mobile-feed-panel");
    expect(html).not.toContain("<section");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain(">Feed<");
    expect(root?.props.className).not.toContain("px-");
    expect(root?.props.className).not.toContain("max-w-");
    expect(header?.props.className).toContain("pb-2");
    // The scope shares the header's one row with the status pill; the feed
    // starts directly under it with no title row or extra margin between.
    expect(scope?.props.className).toContain("flex-1");
    expect(scope?.props.className).not.toContain("mt-");
    expect(content?.props.className).not.toContain("mt-");
    expect(header?.props.className).not.toContain("border-b");
  });

  test("mounts one live feed", () => {
    const html = renderFeed();

    expect(html.match(/data-testid="venue-aware-signal-feed"/g)).toHaveLength(1);
    expect(html.match(/data-testid="live-signal"/g)).toHaveLength(1);
  });

  test("routes venue filter changes through the controller callback", () => {
    const selected: MobileFeedVenueFilter[] = [];
    const tree = MobileFeedPanel({
      signalFeed: <div>Live signal feed</div>,
      venueFilter: "all",
      perpsAvailable: true,
      onVenueFilterChange: (filter) => selected.push(filter),
      status: "live",
    });

    click(findByAriaLabel(tree, "Stocks"));
    click(findByAriaLabel(tree, "Perps"));
    click(findByAriaLabel(tree, "All"));

    expect(selected).toEqual(["stocks", "perps", "all"]);
  });

  test("shows a visible focus ring on venue filter controls", () => {
    const tree = MobileFeedPanel({
      signalFeed: <div>Live signal feed</div>,
      venueFilter: "all",
      perpsAvailable: true,
      onVenueFilterChange: () => {},
    });

    for (const label of ["All", "Stocks", "Perps"]) {
      expect(findByAriaLabel(tree, label)?.props.className).toContain(
        "focus-visible:ring-2",
      );
    }
  });

  test("exposes All, Stocks, and Perps as an exclusive venue filter", () => {
    const all = renderFeed({ venueFilter: "all" });
    const stocks = renderFeed({ venueFilter: "stocks" });
    const perps = renderFeed({ venueFilter: "perps" });

    for (const html of [all, stocks, perps]) {
      expect(html).toContain(">All<");
      expect(html).toContain(">Stocks<");
      expect(html).toContain(">Perps<");
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    }
    expect(all).toMatch(/aria-pressed="true"[^>]*>All</);
    expect(stocks).toMatch(/aria-pressed="true"[^>]*>Stocks</);
    expect(perps).toMatch(/aria-pressed="true"[^>]*>Perps</);
  });

  test("omits Perps and resolves a stale Perps selection to All when unavailable", () => {
    const html = renderFeed({
      venueFilter: "perps",
      perpsAvailable: false,
    });

    expect(html).not.toContain(">Perps<");
    expect(html).toContain("grid-cols-2");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>All</);
    expect(visibleMobileFeedVenueFilters(false).map((f) => f.value)).toEqual([
      "all",
      "stocks",
    ]);
    expect(normalizeMobileFeedVenueFilter("perps", false)).toBe("all");
    expect(normalizeMobileFeedVenueFilter("perps", true)).toBe("perps");
  });

  test("announces loading and degraded feed states without inventing signal rows", () => {
    const loading = renderFeed({ status: "loading" });
    const degraded = renderFeed({ status: "degraded" });

    expect(loading).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(loading).toContain("Loading live signals");
    expect(degraded).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(degraded).toContain("Signal feed is degraded");
    expect(degraded).toContain("Retrying automatically");
    expect(loading).not.toContain("Featured signal");
    expect(loading).not.toContain("Demo data");
    expect(loading.match(/data-testid="live-signal"/g)).toHaveLength(1);
  });

  test("marks the selected scope with brighter text over a gold rule, not a gold fill", () => {
    // DESIGN.md: gold is a seasoning. The strip is flat on a hairline, like
    // the Traders strip above it; the selected scope is heavier, brighter
    // text with a gold rule under it, and no segment is a filled pill.
    const html = renderFeed({ venueFilter: "stocks" });
    const scopeClass =
      html.match(/data-mobile-feed-scope="stocks"[^>]*class="([^"]+)"/)?.[1] ??
      "";
    const selectedButton =
      html.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0] ?? "";
    const unselectedButton =
      html.match(/<button[^>]*aria-label="All"[^>]*aria-pressed="false"[^>]*>/)?.[0] ??
      "";

    expect(scopeClass).toContain("border-b");
    expect(scopeClass).not.toContain("rounded-xl");
    expect(scopeClass).not.toContain("border-[#17313c]");
    expect(scopeClass).not.toContain("bg-[#061720]");

    expect(selectedButton).toContain("text-white");
    expect(selectedButton).toContain("font-semibold");
    expect(selectedButton).toContain('data-state="active"');
    expect(selectedButton).not.toContain("bg-[#e7c65d]");
    expect(selectedButton).not.toContain("text-[#1c1a0f]");
    expect(selectedButton).not.toContain("bg-primary");
    expect(html).toMatch(
      /aria-pressed="true"[^>]*>Stocks<span[^>]*data-mobile-feed-scope-rule="true"/,
    );
    expect(html.match(/data-mobile-feed-scope-rule="true"/g)).toHaveLength(1);

    expect(unselectedButton).toContain("text-[#8da5ad]");
    expect(unselectedButton).toContain("hover:text-white");
    expect(unselectedButton).not.toContain("bg-[");
    expect(unselectedButton).not.toContain("text-muted-foreground");
  });

  test("leaves horizontal spacing to the screen for the supplied feed", () => {
    const tree = MobileFeedPanel({
      signalFeed: <div data-testid="live-signal-feed" />,
      venueFilter: "all",
      perpsAvailable: true,
      onVenueFilterChange: () => {},
    });

    const content = flattenElements(tree).find(
      (element) => element.props["data-testid"] === "mobile-feed-content",
    );
    expect(content?.props.className).toContain("min-w-0");
    expect(content?.props.className).not.toContain("px-");
  });

  test("leaves vertical scrolling to the shell and mounts the production feed flat", () => {
    const tree = MobileFeedPanel({
      signalFeed: <div data-testid="live-signal-feed" />,
      venueFilter: "all",
      perpsAvailable: true,
      onVenueFilterChange: () => {},
    });

    const elements = flattenElements(tree);
    const panel = elements.find(
      (element) => element.props["data-testid"] === "mobile-feed-panel",
    );
    const content = elements.find(
      (element) => element.props["data-testid"] === "mobile-feed-content",
    );

    // Growth, so the feed's empty state can center in the slack...
    expect(panel?.props.className).toContain("flex-1");
    expect(content?.props.className).toContain("flex-1");
    // ...but never a bound or a scroller of its own: the shell's `main` is
    // the only one, and a bounded box here would switch on the feed card's
    // inner list scroller.
    for (const element of [panel, content]) {
      expect(element?.props.className).not.toContain("h-full");
      expect(element?.props.className).not.toContain("h-[");
      expect(element?.props.className).not.toContain("min-h-0");
      expect(element?.props.className).not.toContain("overflow-y-auto");
      expect(element?.props.className).not.toContain("overflow-hidden");
    }
    expect(content?.props.className).not.toContain("rounded-2xl");
    expect(content?.props.className).not.toContain("border");
    expect(content?.props.className).not.toContain("shadow-");
  });
});
