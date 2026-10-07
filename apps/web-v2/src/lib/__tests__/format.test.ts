import { describe, it, expect } from "bun:test";
import {
  changeTone,
  formatChangePct,
  formatCompactNumber,
  formatCompactUsd,
  formatPriceUsd,
  formatSignedNumber,
  formatSignedUsd,
  formatUsd, toFiniteNumber } from "../format";

describe("formatUsd (audit M16)", () => {
  it("formats numbers and numeric strings", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd("1234.5")).toBe("$1,234.50");
  });

  it("renders '-' for invalid input instead of NaN", () => {
    expect(formatUsd(null)).toBe("-");
    expect(formatUsd(undefined)).toBe("-");
    expect(formatUsd("not a number")).toBe("-");
  });
});

describe("formatCompactUsd", () => {
  it("compacts at 10k without trailing zeros", () => {
    expect(formatCompactUsd(12345)).toBe("$12.3K");
    expect(formatCompactUsd(5_000_000)).toBe("$5M");
    expect(formatCompactUsd(859_600)).toBe("$859.6K");
  });

  it("keeps standard notation below 10k and widens under $1", () => {
    expect(formatCompactUsd(999)).toBe("$999.00");
    expect(formatCompactUsd(0.1234)).toBe("$0.1234");
    expect(formatCompactUsd(0.00001234)).toBe("$0.00001234");
  });
});

describe("formatCompactNumber", () => {
  it("formats activity without a currency symbol", () => {
    expect(formatCompactNumber(1_250_000)).toBe("1.3M");
    expect(formatCompactNumber(Number.NaN)).toBe("-");
  });
});

describe("formatSignedNumber", () => {
  it("adds a plus sign for positives and supports suffixes", () => {
    expect(formatSignedNumber(1.234)).toBe("+1.23");
    expect(formatSignedNumber(-1.234, "%")).toBe("-1.23%");
    expect(formatSignedNumber(undefined)).toBe("-");
  });
});

describe("formatPriceUsd", () => {
  it("uses 2 decimals at $1 and above, 4 below", () => {
    expect(formatPriceUsd(1234.5)).toBe("$1,234.50");
    expect(formatPriceUsd("0.4321")).toBe("$0.4321");
  });

  it("renders '-' for missing, failed (zero) and negative quotes", () => {
    expect(formatPriceUsd(undefined)).toBe("-");
    expect(formatPriceUsd("0")).toBe("-");
    expect(formatPriceUsd(-5)).toBe("-");
  });
});

describe("formatSignedUsd", () => {
  it("signs both directions and leaves zero unsigned", () => {
    expect(formatSignedUsd(1234.56)).toBe("+$1,234.56");
    expect(formatSignedUsd(-42)).toBe("-$42.00");
    expect(formatSignedUsd(0)).toBe("$0.00");
  });

  it("renders '-' for invalid input", () => {
    expect(formatSignedUsd(null)).toBe("-");
    expect(formatSignedUsd("nope")).toBe("-");
  });
});

describe("changeTone", () => {
  it("maps sign to tone", () => {
    expect(changeTone(0.01)).toBe("positive");
    expect(changeTone("-3")).toBe("negative");
    expect(changeTone(0)).toBe("neutral");
  });

  it("treats invalid input as neutral, never a false direction", () => {
    expect(changeTone(null)).toBe("neutral");
    expect(changeTone("abc")).toBe("neutral");
  });
});

describe("formatChangePct", () => {
  it("pairs the signed percent text with its tone", () => {
    expect(formatChangePct(1.234)).toEqual({ text: "+1.23%", tone: "positive" });
    expect(formatChangePct("-0.4")).toEqual({ text: "-0.40%", tone: "negative" });
    expect(formatChangePct(undefined)).toEqual({ text: "-", tone: "neutral" });
  });
});

describe("toFiniteNumber", () => {
  it("parses live decimal strings and passes numbers through", () => {
    expect(toFiniteNumber("65132.5")).toBe(65132.5);
    expect(toFiniteNumber("0.000021")).toBe(0.000021);
    expect(toFiniteNumber(42)).toBe(42);
    expect(toFiniteNumber(0)).toBe(0);
  });

  it("absence is null, never zero", () => {
    // Number("") is 0. A missing quote must read as "no price", not a real
    // zero that a formatter would happily print.
    expect(toFiniteNumber("")).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
  });

  it("unparseable and non-finite values are null", () => {
    expect(toFiniteNumber("n/a")).toBeNull();
    expect(toFiniteNumber(Number.NaN)).toBeNull();
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
