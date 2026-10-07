import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BinaryToggle } from "./binary-toggle";

/** Every tone the primitive still offers. "gold" is deliberately not one. */
const TONES = ["positive", "negative", "neutral"] as const;

function renderTone(tone: (typeof TONES)[number]): string {
  return renderToStaticMarkup(
    createElement(BinaryToggle, {
      ariaLabel: "Direction",
      value: "a",
      onChange: () => {},
      options: [
        { value: "a", label: "A", tone },
        { value: "b", label: "B", tone },
      ],
    }),
  );
}

describe("BinaryToggle tones", () => {
  // The primitive carried an unused "gold" tone whose active state was a solid
  // `bg-primary` / `text-primary-foreground` fill. No call site ever passed it,
  // and an unused accent fill sitting in a shared primitive is exactly how the
  // next gold slab gets seeded (DESIGN.md: gold is a seasoning, not a sauce).
  test("no tone fills a segment with the accent", () => {
    for (const tone of TONES) {
      const markup = renderTone(tone);

      expect(markup).not.toContain("bg-primary");
      expect(markup).not.toContain("text-primary-foreground");
    }
  });

  test("keeps the solid fills that actually carry meaning", () => {
    // Direction is the one thing worth a solid fill in this control, so green
    // and red survive; everything else stays neutral.
    expect(renderTone("positive")).toContain("bg-green-500 text-black");
    expect(renderTone("negative")).toContain("bg-red-500 text-white");
    expect(renderTone("neutral")).toContain("bg-background text-foreground");
  });

  test("marks exactly one segment active per tone", () => {
    for (const tone of TONES) {
      const markup = renderTone(tone);

      expect(markup.match(/data-state="active"/g)).toHaveLength(1);
      expect(markup.match(/data-state="inactive"/g)).toHaveLength(1);
      expect(markup).not.toContain('data-tone="gold"');
    }
  });
});
