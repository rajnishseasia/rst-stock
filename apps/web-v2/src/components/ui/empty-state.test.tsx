import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { click, elementText, flattenElements } from "@/testing/element-tree";
import { EmptyState } from "./empty-state";
import { TOUCH_HEIGHT_COMPACT, TOUCH_TARGET_MIN_PX } from "./touch-target";

/** Height utilities used by the shared controls, in CSS pixels. */
const HEIGHT_PX: Record<string, number> = {
  "h-6": 24,
  "h-7": 28,
  "h-8": 32,
  "h-11": 44,
  "h-12": 48,
};

const BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
};

/** Resolve a height stack at a viewport width, the way the cascade does. */
function resolveHeightPx(stack: string, widthPx: number): number | undefined {
  let height: number | undefined;
  for (const token of stack.split(/\s+/).filter(Boolean)) {
    const [maybePrefix, ...rest] = token.split(":");
    if (rest.length === 0) {
      height = HEIGHT_PX[maybePrefix] ?? height;
      continue;
    }
    const min = BREAKPOINTS[maybePrefix];
    if (min === undefined || widthPx < min) continue;
    height = HEIGHT_PX[rest.join(":")] ?? height;
  }
  return height;
}

function buttons(node: ReturnType<typeof EmptyState>) {
  return flattenElements(node).filter(
    (element) =>
      typeof element.props.className === "string" &&
      /min-h-11/.test(element.props.className),
  );
}

describe("empty state actions", () => {
  test("runs the handler the caller wired, not a navigation of its own", () => {
    let browsed = 0;
    const node = EmptyState({
      title: "No open positions",
      body: "Positions show up here once an order fills.",
      actions: [{ label: "Browse signals", onClick: () => (browsed += 1) }],
    });

    const action = buttons(node)[0];
    expect(elementText(action)).toBe("Browse signals");
    click(action);
    expect(browsed).toBe(1);
  });

  test("every action clears the 44px touch minimum", () => {
    const node = EmptyState({
      title: "No portfolio history yet",
      actions: [
        { label: "Browse signals", onClick: () => {} },
        { label: "Connect Alpaca", href: "/settings", emphasis: "secondary" },
      ],
    });

    const targets = buttons(node);
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      // min-h-11 is 44px and only raises the button variant's own h-7.
      expect(String(target.props.className)).toContain("min-h-11");
    }
    expect(TOUCH_TARGET_MIN_PX).toBe(44);
  });

  test("the signal-first action leads and the funding action is secondary", () => {
    // Product thesis: an empty positions/portfolio state routes to the feed,
    // never into a funding form. Order and emphasis both have to say so.
    const node = EmptyState({
      title: "No stock account connected",
      actions: [
        { label: "Browse signals", onClick: () => {} },
        { label: "Connect Alpaca", href: "/settings", emphasis: "secondary" },
      ],
    });

    const targets = buttons(node);
    expect(elementText(targets[0])).toBe("Browse signals");
    expect(targets[0].props.variant).toBe("default");
    expect(elementText(targets[1])).toBe("Connect Alpaca");
    expect(targets[1].props.variant).toBe("outline");
  });

  test("drops an action row entirely when the caller has nowhere to send them", () => {
    // Desktop renders these panels beside a feed that is already on screen, so
    // callers omit the handler. An empty state must not paint a dead button.
    const node = EmptyState({ title: "No open perp positions" });
    expect(buttons(node)).toHaveLength(0);
    expect(renderToStaticMarkup(node)).toContain("No open perp positions");
  });

  test("fills a flex column only when asked, so a short screen's slack splits around it", () => {
    const plain = renderToStaticMarkup(EmptyState({ title: "Nothing here" }));
    const filled = renderToStaticMarkup(
      EmptyState({ title: "Nothing here", fill: true }),
    );

    expect(plain).not.toContain("flex-1");
    expect(plain).not.toContain("justify-center");
    expect(filled).toMatch(/class="[^"]*flex-1[^"]*justify-center/);
  });
});

describe("shared touch-target stack", () => {
  test("gives a compact terminal control a full target below sm", () => {
    for (const width of [320, 375, 430, 639]) {
      expect(resolveHeightPx(TOUCH_HEIGHT_COMPACT, width)).toBe(
        TOUCH_TARGET_MIN_PX,
      );
    }
  });

  test("hands the terminal its 28px pill back from sm up", () => {
    for (const width of [640, 768, 1280]) {
      expect(resolveHeightPx(TOUCH_HEIGHT_COMPACT, width)).toBe(28);
    }
  });
});
