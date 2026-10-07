import { describe, expect, test } from "bun:test";

import { formatExitPriceUsd } from "./format";

describe("formatExitPriceUsd", () => {
  test("omits empty cents but keeps meaningful trigger precision", () => {
    expect(formatExitPriceUsd(396)).toBe("$396");
    expect(formatExitPriceUsd(396.25)).toBe("$396.25");
    expect(formatExitPriceUsd(0.5)).toBe("$0.50");
    expect(formatExitPriceUsd(0.1866)).toBe("$0.1866");
  });
});
