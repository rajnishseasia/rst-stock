import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { overlayToggleButtonClassName } from "./terminal-chart-panel-layout";

const venueState = {
  venue: "stocks" as const,
  setVenue: () => {},
  searchFilter: "all" as const,
  setSearchFilter: () => {},
};

/** The aria-checked state of one segment, keyed by its aria-label. */
function segmentChecked(markup: string, label: string): string | undefined {
  return markup
    .match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0]
    .match(/aria-checked="([^"]+)"/)?.[1];
}

mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));
mock.module("@/lib/venue-context", () => ({ useVenue: () => venueState }));

const { VenueSwitch } = await import("./venue-switch");

/** How every mobile screen renders the control now that the bar is gone. */
const mobileSwitch = () =>
  createElement(VenueSwitch, { showLabels: true, fill: true });

describe("venue switch is a two-way venue choice", () => {
  // It was briefly a three-way All / Stocks / Perps filter, with the venue you
  // were actually trading shown only as a 6px dot. "All" is not a venue you
  // can trade on, so the control could sit in a state that answered neither
  // "what am I trading" nor "what am I looking at".
  test("offers exactly Stocks and Perps, and no All segment", () => {
    const markup = renderToStaticMarkup(createElement(VenueSwitch));

    expect(markup).toContain(">Stocks<");
    expect(markup).toContain(">Perps<");
    expect(markup).not.toContain(">All<");
  });

  test("marks the traded venue as the selected segment, not with a separate dot", () => {
    const markup = renderToStaticMarkup(createElement(VenueSwitch));

    // The stocks segment is the checked one because `venue` is "stocks",
    // even though the search filter is still the legacy "all".
    expect(segmentChecked(markup, "Trade stocks")).toBe("true");
    expect(segmentChecked(markup, "Trade perps")).toBe("false");
    // The old active-venue dot is gone; the selection carries that meaning.
    expect(markup).not.toContain("h-1.5 w-1.5 rounded-full bg-primary");
  });
});

describe("the selected venue is visibly marked", () => {
  // The shared toggle-group marks selection with `bg-background`, which is
  // DARKER than the `bg-muted` track it sits on. In the mobile venue bar that
  // made the unselected half read as the chosen one, so switching venue looked
  // like nothing had happened. Selection has to be stated in its own way, and
  // on mobile that way is the one every mobile tab strip uses (DESIGN.md:
  // gold is a seasoning): brighter, heavier text over a gold hairline rule,
  // never a gold-filled segment.
  test("on mobile, the traded venue is brighter text over a gold rule, not a gold fill", () => {
    const markup = renderToStaticMarkup(
      createElement(VenueSwitch, { showLabels: true, fill: true }),
    );
    const track =
      markup.match(/data-slot="toggle-group"[^>]*class="([^"]+)"/)?.[1] ?? "";
    const stocks =
      markup.match(/<button[^>]*aria-label="Trade stocks"[^>]*>/)?.[0] ?? "";

    expect(track).toContain("border-b");
    expect(track).toContain("bg-transparent");
    expect(track).not.toContain("bg-muted");
    expect(track).not.toContain("rounded-full");

    expect(stocks).toContain("data-[state=on]:text-white");
    expect(stocks).toContain("data-[state=on]:font-semibold");
    expect(stocks).toContain("rounded-none");
    expect(stocks).not.toContain("data-[state=on]:bg-[#e7c65d]");
    expect(stocks).not.toContain("data-[state=on]:text-[#071219]");
    // Both segments carry the rule; the group state shows only the traded one.
    expect(markup.match(/data-mobile-venue-rule="true"/g)).toHaveLength(2);
    expect(markup).toContain("group-data-[state=on]/venue:block");
  });

  test("on mobile, the flat override replaces the bg-background default rather than sitting under it", () => {
    const markup = renderToStaticMarkup(mobileSwitch());
    const selectedBackgrounds = markup.match(/data-\[state=on\]:bg-\S+/g) ?? [];

    expect(selectedBackgrounds).toEqual([
      "data-[state=on]:bg-transparent",
      "data-[state=on]:bg-transparent",
    ]);
  });

  // There is no pinned mobile bar any more: the control is routed to the
  // screens that read the venue and sits inside a control row each of them
  // already paints, so it must bring its own baseline for the gold rule.
  test("the mobile presentation carries its own hairline baseline under the rule", () => {
    const markup = renderToStaticMarkup(mobileSwitch());
    const track =
      markup.match(/data-slot="toggle-group"[^>]*class="([^"]+)"/)?.[1] ?? "";

    expect(track).toContain("border-b");
    expect(track).not.toContain("border-b-0");
    expect(track).toContain("w-full");
  });

  // The desktop segment used to state selection with a solid gold fill plus a
  // glow. This control sits in the persistent header, so that made it the
  // brightest object on screen at all times and it outshouted every real CTA
  // (DESIGN.md: gold is a seasoning, not a sauce). Selection is now the tint
  // recipe the chart-overlay toggles use.
  test("on desktop, selection is a primary tint, not a solid gold fill", () => {
    const markup = renderToStaticMarkup(createElement(VenueSwitch));
    const selectedBackgrounds = markup.match(/data-\[state=on\]:bg-\S+/g) ?? [];

    expect(markup).toContain("data-[state=on]:bg-primary/15");
    expect(markup).toContain("data-[state=on]:border-primary/45");
    expect(markup).toContain("data-[state=on]:text-primary");
    expect(markup).not.toContain("data-mobile-venue-rule");
    // No solid fill, no hard-coded hex, and no glow around the header control.
    expect(markup).not.toContain("data-[state=on]:bg-[#e7c65d]");
    expect(markup).not.toContain("data-[state=on]:text-[#071219]");
    expect(markup).not.toContain("data-[state=on]:shadow-");
    expect(markup).not.toMatch(/data-\[state=on\]:bg-primary(?![-/])/);
    // The tint override must come after the base `bg-background` so it wins.
    expect(selectedBackgrounds.at(-1)).toBe("data-[state=on]:bg-primary/15");
  });

  test("on desktop, the tint reuses the shared overlay-toggle recipe", () => {
    const markup = renderToStaticMarkup(createElement(VenueSwitch));
    const shared = overlayToggleButtonClassName(true).split(" ");

    // The recipe really is the chart overlay toggles', not a look-alike, so
    // the two selected states cannot drift apart.
    for (const token of ["border-primary/45", "bg-primary/15", "text-primary"]) {
      expect(shared).toContain(token);
      expect(markup).toContain(`data-[state=on]:${token}`);
    }
  });
});

describe("venue switch touch targets", () => {
  test("expands mobile venue controls to at least 44px while keeping desktop controls dense", () => {
    const mobile = renderToStaticMarkup(mobileSwitch());
    const desktop = renderToStaticMarkup(createElement(VenueSwitch));

    expect(mobile).toContain("min-h-11");
    expect(mobile).toContain("xl:min-h-0");
    expect(desktop).toContain("h-8");
    expect(desktop).not.toContain("min-h-11");
  });
});
