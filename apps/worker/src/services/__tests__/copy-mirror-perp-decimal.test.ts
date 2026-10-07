import { describe, expect, it } from "bun:test";
import {
  divideDecimalCeil,
  multiplyDecimal,
  minPositiveDecimal,
  parsePositiveDecimal,
  percentageDecimal,
  proportionalDecimal,
  signedPerpExposure,
} from "../copy-mirror-perp-decimal";

describe("copy-mirror perp decimal safety", () => {
  it("ceils a positive quotient to the venue size precision", () => {
    expect(divideDecimalCeil("10", "95", 3)).toBe("0.106");
    expect(divideDecimalCeil("10", "0.22478", 0)).toBe("45");
  });

  it("accepts the shared boundary and rejects the first unsafe size", () => {
    expect(parsePositiveDecimal("90071992.54740991")).not.toBeNull();
    expect(parsePositiveDecimal("90071992.54740992")).toBeNull();
  });

  it("takes an exact decimal minimum without truncating the dollar budget", () => {
    expect(minPositiveDecimal("999.915", "10.55")).toBe("10.55");
    expect(minPositiveDecimal("10.1", "10.55")).toBe("10.1");
  });

  it("multiplies a decimal percentage without binary floating-point drift", () => {
    expect(percentageDecimal("0.24", "68.75")).toBe("0.165");
    expect(percentageDecimal("15.36", "68.75")).toBe("10.56");
  });

  it("rejects arithmetic results that leave the shared domain", () => {
    expect(multiplyDecimal("90071992.54740991", 2, 8)).toBeNull();
    expect(proportionalDecimal("90071992.54740991", "2", "1", 8)).toBeNull();
    expect(signedPerpExposure([
      { direction: "long", executedSizeDecimal: "90071992.54740991" },
      { direction: "long", executedSizeDecimal: "0.00000001" },
    ])).toBeNull();
  });
});
