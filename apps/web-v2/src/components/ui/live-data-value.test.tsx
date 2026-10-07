import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { getLiveDataDirection, LiveDataValue } from "./live-data-value";

describe("getLiveDataDirection", () => {
  test("reports upward and downward ticks", () => {
    expect(getLiveDataDirection(100, 100.01)).toBe("up");
    expect(getLiveDataDirection(100, 99.99)).toBe("down");
  });

  test("ignores initial, unchanged, and non-finite values", () => {
    expect(getLiveDataDirection(undefined, 100)).toBeNull();
    expect(getLiveDataDirection(100, 100)).toBeNull();
    expect(getLiveDataDirection(Number.NaN, 100)).toBeNull();
    expect(getLiveDataDirection(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("LiveDataValue", () => {
  test("renders formatted tabular data without an initial flash", () => {
    const markup = renderToStaticMarkup(
      <LiveDataValue value={123.45} format={(value) => `$${value.toFixed(2)}`} />,
    );

    expect(markup).toContain('data-slot="live-data-value"');
    expect(markup).toContain('class="tabular-nums"');
    expect(markup).toContain('data-direction="steady"');
    expect(markup).toContain("$123.45");
  });
});
