import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getMobileVenueScopeForKey,
  isMobileVenueActivationKey,
  MobileVenueStack,
} from "./mobile-venue-stack";
import {
  MOBILE_PORTFOLIO_VENUE_LABELS,
  showMobilePerpsSection,
} from "./mobile-portfolio";

/**
 * Plan A7's venue rule, rendered rather than grepped.
 *
 * page.tsx composes this exactly one way:
 *
 *   <MobileVenueStack
 *     stocks={<PositionsPanel ... />}
 *     perps={mobilePerpsConnected ? <PerpPositionsPanel ... /> : null}
 *   />
 *
 * so the tests below drive `showMobilePerpsSection` through that same
 * conditional. Stand-in nodes keep this a test of the STACK: the two real panels
 * each need a tRPC provider, and what is being asserted is which venues reach
 * the screen, not how either panel renders a row.
 */
const STOCKS = <div>stock positions</div>;
const PERPS = <div>perp positions</div>;

/**
 * The labels as they appear in markup. Derived from the real constants rather
 * than retyped, so renaming a venue label cannot leave these tests asserting a
 * string the UI no longer shows; "Stocks & options" is HTML-escaped on render.
 */
const STOCKS_LABEL = MOBILE_PORTFOLIO_VENUE_LABELS.stocks.replace(/&/g, "&amp;");
const PERPS_LABEL = MOBILE_PORTFOLIO_VENUE_LABELS.perps.replace(/&/g, "&amp;");

function renderStack(perpsConnected: boolean) {
  return renderToStaticMarkup(
    <MobileVenueStack
      stocks={STOCKS}
      perps={perpsConnected ? PERPS : null}
    />,
  );
}

describe("the mobile Tools stack is venue-aware", () => {
  test("a perps user sees their perp positions, under their own label", () => {
    const connected = showMobilePerpsSection({ wired: true, provisioned: true });
    const markup = renderStack(connected);

    expect(connected).toBe(true);
    expect(markup).toContain("perp positions");
    expect(markup).toContain(PERPS_LABEL);
  });

  test("and still sees their equities, because a phone has one account", () => {
    // The desktop trick of venue-FILTERING a rail would hide one venue's money
    // entirely below xl, where there is no second rail to put it in.
    const markup = renderStack(true);

    expect(markup).toContain("stock positions");
    expect(markup).toContain(STOCKS_LABEL);
  });

  test("an equities-only user is never shown a perps surface", () => {
    // Not wired for this deployment, and not provisioned for this user: both
    // paths must collapse to the stocks panel alone.
    expect(showMobilePerpsSection({ wired: false, provisioned: true })).toBe(false);
    expect(showMobilePerpsSection({ wired: true, provisioned: false })).toBe(false);

    const markup = renderStack(false);

    expect(markup).toContain("stock positions");
    expect(markup).not.toContain("perp positions");
    expect(markup).not.toContain(PERPS_LABEL);
  });

  test("and is not labeled either, so no venue is advertised to them", () => {
    // A lone "Stocks & options" header implies a second section exists. With one
    // venue the panel fills the surface exactly as it did before A7.
    const markup = renderStack(false);

    expect(markup).not.toContain(STOCKS_LABEL);
    expect(markup).toContain('data-mobile-venue-panel="stocks"');
    expect(markup).toContain("stock positions");
  });

  test("keeps an equities-only supplied panel width-safe", () => {
    const markup = renderToStaticMarkup(
      <MobileVenueStack
        stocks={
          <div className="min-w-[80rem] whitespace-nowrap">
            wide stock content
          </div>
        }
        perps={null}
      />,
    );
    const panelClass = markup.match(
      /data-mobile-venue-panel="stocks"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";

    expect(markup).toContain("wide stock content");
    expect(markup).not.toContain(STOCKS_LABEL);
    expect(panelClass).toContain("min-w-0");
    expect(panelClass).toContain("max-w-full");
    expect(panelClass).toContain("overflow-x-clip");
    expect(panelClass).not.toContain("overflow-y-auto");
  });

  test("the two venues stay in separate sections, stocks first", () => {
    // Shares and perp rows (size, leverage, liquidation, funding) are never
    // merged into one table: that is the equities-safety guard A7 inherits from
    // the desktop "All" view.
    const markup = renderStack(true);
    const stocksLabel = markup.search(/id="[^"]+-stocks-label"/);
    const stocksBody = markup.indexOf("stock positions");
    const perpsLabel = markup.search(/id="[^"]+-perps-label"/);
    const perpsBody = markup.indexOf("perp positions");

    expect(stocksLabel).toBeGreaterThanOrEqual(0);
    expect(stocksLabel).toBeLessThan(stocksBody);
    expect(stocksBody).toBeLessThan(perpsLabel);
    expect(perpsLabel).toBeLessThan(perpsBody);
  });

  test("uses one bounded workspace with both venue surfaces instead of nested scrollers", () => {
    const markup = renderStack(true);

    expect(markup).toContain('data-mobile-venue-stack="true"');
    expect(markup).toContain('data-mobile-venue-scope="all"');
    expect(markup).not.toContain("overflow-y-auto");
    expect(markup).not.toContain("overflow-y-scroll");
    expect(markup).not.toContain("overflow-x-auto");
    expect(markup).not.toContain("overscroll-contain");
    const workspaceClassName = markup.match(
      /data-mobile-venue-workspace="true"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    expect(workspaceClassName).not.toContain("flex-1");
  });

  test("offers compact All, Stocks, and Perps scope controls without a draggable divider", () => {
    const markup = renderStack(true);

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Asset scope"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain(">All<");
    expect(markup).toContain(">Stocks<");
    expect(markup).toContain(">Perps<");
    expect(markup.match(/<button[^>]*role="tab"[^>]*>/g)).toHaveLength(3);
    expect(markup.match(/<button[^>]*role="tab"[^>]*min-h-11[^>]*>/g)).toHaveLength(3);
    expect(markup).not.toContain('role="separator"');
    expect(markup).not.toContain("Drag to resize");
    expect(markup).not.toContain("cursor-row-resize");
  });

  test("marks the selected scope with brighter text over a gold rule, not a gold pill", () => {
    // DESIGN.md: gold is a seasoning. The strip is flat on a hairline, like
    // the Account rail above it; the selected scope is not a gold-filled pill.
    const markup = renderStack(true);
    const tablist = markup.match(
      /<div[^>]*aria-label="Asset scope"[^>]*class="([^"]+)"/,
    )?.[1] ?? "";
    const selected =
      markup.match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0] ?? "";
    const idle =
      markup.match(/<button[^>]*aria-selected="false"[^>]*>/)?.[0] ?? "";

    expect(tablist).toContain("border-b");
    expect(tablist).not.toContain("gap-1");
    expect(selected).toContain('data-state="active"');
    expect(selected).toContain("text-white");
    expect(selected).toContain("font-semibold");
    expect(selected).not.toContain("bg-[#e7c65d]");
    expect(selected).not.toContain("rounded-lg");
    expect(idle).toContain("text-[#8da5ad]");
    expect(idle).not.toContain("bg-[");
    expect(markup.match(/data-mobile-venue-scope-rule="true"/g)).toHaveLength(1);
  });

  test("keeps both venue panels in one flat document-flow workspace", () => {
    const markup = renderStack(true);
    const workspaceClassName =
      markup.match(
        /<div[^>]*data-mobile-venue-workspace="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";
    const venueSections = [
      ...markup.matchAll(
        /data-mobile-venue-section="(stocks|perps)"[^>]*class="([^"]+)"/g,
      ),
    ];

    expect(workspaceClassName).toContain("min-w-0");
    expect(workspaceClassName).toContain("max-w-full");
    expect(workspaceClassName).not.toContain("flex-1");
    expect(workspaceClassName).not.toContain("rounded");
    expect(workspaceClassName).not.toContain("border");
    expect(workspaceClassName).not.toContain("shadow");
    expect(venueSections).toHaveLength(2);

    for (const [, , className] of venueSections) {
      expect(className).toContain("px-2");
      expect(className).toContain("sm:px-3");
      expect(className).toContain("border-b");
      expect(className).not.toContain("rounded");
      expect(className).not.toContain("shadow-");
    }
  });

  test("keeps supplied venue panels width-safe without creating another scroll owner", () => {
    const markup = renderToStaticMarkup(
      <MobileVenueStack
        stocks={
          <div className="min-w-[80rem] whitespace-nowrap">
            wide stock content
          </div>
        }
        perps={<div>perp content</div>}
      />,
    );
    const panels = [
      ...markup.matchAll(
        /data-mobile-venue-panel="(stocks|perps)"[^>]*class="([^"]+)"/g,
      ),
    ];

    expect(panels).toHaveLength(2);
    for (const [, , className] of panels) {
      expect(className).toContain("min-w-0");
      expect(className).toContain("max-w-full");
      expect(className).toContain("overflow-x-clip");
      expect(className).not.toContain("overflow-y-auto");
      expect(className).not.toContain("overflow-y-scroll");
      expect(className).not.toMatch(/\[&[^\]]*\]:!/);
    }
  });

  test("associates each venue region with its visible section label", () => {
    const markup = renderStack(true);
    const regions = [...markup.matchAll(/<section[^>]*role="region"[^>]*aria-labelledby="([^"]+)"[^>]*>/g)];

    expect(regions).toHaveLength(2);

    for (const region of regions) {
      const labelId = region[1];
      expect(labelId).toBeTruthy();
      expect(markup).toContain(`id="${labelId}"`);
      expect(markup).toMatch(
        new RegExp(
          `<div[^>]*id="${escapeRegExp(labelId)}"[^>]*>[\\s\\S]*?</div>`,
        ),
      );
      expect(markup.indexOf(`id="${labelId}"`)).toBeLessThan(
        markup.indexOf(`aria-labelledby="${labelId}"`),
      );
    }

    expect(markup).toContain(STOCKS_LABEL);
    expect(markup).toContain(PERPS_LABEL);
  });
});

describe("mobile venue scope keyboard navigation", () => {
  test("ArrowRight and ArrowLeft move through scopes and wrap", () => {
    expect(getMobileVenueScopeForKey("all", "ArrowRight")).toBe("stocks");
    expect(getMobileVenueScopeForKey("stocks", "ArrowRight")).toBe("perps");
    expect(getMobileVenueScopeForKey("perps", "ArrowRight")).toBe("all");
    expect(getMobileVenueScopeForKey("all", "ArrowLeft")).toBe("perps");
    expect(getMobileVenueScopeForKey("stocks", "ArrowLeft")).toBe("all");
    expect(getMobileVenueScopeForKey("perps", "ArrowLeft")).toBe("stocks");
  });

  test("Home and End move to the first and last scope", () => {
    expect(getMobileVenueScopeForKey("perps", "Home")).toBe("all");
    expect(getMobileVenueScopeForKey("all", "End")).toBe("perps");
  });

  test("Enter and Space activate the focused scope", () => {
    expect(isMobileVenueActivationKey("Enter")).toBe(true);
    expect(isMobileVenueActivationKey(" ")).toBe(true);
    expect(isMobileVenueActivationKey("Spacebar")).toBe(true);
    expect(isMobileVenueActivationKey("Tab")).toBe(false);
    expect(getMobileVenueScopeForKey("stocks", "Enter")).toBeNull();
    expect(getMobileVenueScopeForKey("stocks", " ")).toBeNull();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}
