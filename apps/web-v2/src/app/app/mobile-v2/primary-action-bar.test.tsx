import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { click, findByAriaLabel, flattenElements } from "@/testing/element-tree";
import {
  MobilePrimaryActionBar,
  mobilePrimaryActionLabels,
  type MobilePrimaryActionSide,
} from "./primary-action-bar";

describe("MobilePrimaryActionBar", () => {
  test("names the pair for the venue: Long/Short on perps, Buy/Sell on stocks", () => {
    expect(mobilePrimaryActionLabels(true)).toEqual({ long: "Long", short: "Short" });
    expect(mobilePrimaryActionLabels(false)).toEqual({ long: "Buy", short: "Sell" });

    const perps = renderToStaticMarkup(
      <MobilePrimaryActionBar symbol="BTC" isPerps onTrade={() => {}} />,
    );
    const stocks = renderToStaticMarkup(
      <MobilePrimaryActionBar symbol="AAPL" isPerps={false} onTrade={() => {}} />,
    );

    expect(perps).toContain('aria-label="Long BTC"');
    expect(perps).toContain('aria-label="Short BTC"');
    expect(perps).toContain(">Long</button>");
    expect(perps).toContain(">Short</button>");
    expect(perps).toContain('data-mobile-v2-action-venue="perps"');
    expect(stocks).toContain('aria-label="Buy AAPL"');
    expect(stocks).toContain('aria-label="Sell AAPL"');
    expect(stocks).not.toContain(">Long</button>");
    expect(stocks).toContain('data-mobile-v2-action-venue="stocks"');
  });

  test("hands the chosen side to the controller without submitting anything itself", () => {
    const sides: MobilePrimaryActionSide[] = [];
    const tree = MobilePrimaryActionBar({
      symbol: "BTC",
      isPerps: true,
      onTrade: (side) => sides.push(side),
    });

    click(findByAriaLabel(tree, "Long BTC"));
    click(findByAriaLabel(tree, "Short BTC"));

    expect(sides).toEqual(["long", "short"]);
    expect(renderToStaticMarkup(tree)).not.toContain("<form");
  });

  test("keeps both actions full-width 44px targets in one in-flow row", () => {
    const tree = MobilePrimaryActionBar({
      symbol: "AAPL",
      isPerps: false,
      onTrade: () => {},
    });
    const elements = flattenElements(tree);
    const bar = elements.find(
      (element) => element.props["data-mobile-v2-action-bar"] === "true",
    );
    const buttons = elements.filter((element) => element.props.type === "button");

    expect(String(bar?.props.className)).toContain("grid-cols-2");
    expect(String(bar?.props.className)).toContain("w-full");
    expect(String(bar?.props.className)).not.toContain("fixed");
    expect(String(bar?.props.className)).not.toContain("overflow-y-auto");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      // 44px, the DESIGN.md tap-target floor. The pair sits directly above the
      // nav and is the loudest thing on the chart screen, so it takes the
      // smallest comfortable height rather than the largest that fits.
      expect(String(button.props.className)).toContain("min-h-11");
      expect(String(button.props.className)).toContain("touch-manipulation");
      expect(String(button.props.className)).toContain("focus-visible:ring-2");
    }
  });
});
