import { describe, expect, test } from "bun:test";
import {
  formatSignalChipChange,
  formatSignalChipPrice,
  signalChangeTone,
} from "./signal-quote-format";

describe("feed chip price", () => {
  test("formats a usable last price as USD", () => {
    expect(formatSignalChipPrice("123.4")).toBe("$123.40");
    expect(formatSignalChipPrice(1234.5)).toBe("$1,234.50");
  });

  test("returns null when there is no price to show", () => {
    // A zero-valued placeholder is how a failed snapshot lookup arrives; it is
    // not a price, so the chip renders no pill instead of "$0.00".
    expect(formatSignalChipPrice("0")).toBeNull();
    expect(formatSignalChipPrice("-1")).toBeNull();
    expect(formatSignalChipPrice(null)).toBeNull();
    expect(formatSignalChipPrice(undefined)).toBeNull();
    expect(formatSignalChipPrice("not a number")).toBeNull();
  });
});

describe("feed chip change", () => {
  test("signs the percent change", () => {
    expect(formatSignalChipChange("1.25")).toBe("+1.25%");
    expect(formatSignalChipChange("-0.4")).toBe("-0.40%");
    expect(formatSignalChipChange("0")).toBe("0.00%");
  });

  test("renders nothing when the change is missing or unparseable", () => {
    expect(formatSignalChipChange(undefined)).toBe("");
    expect(formatSignalChipChange("n/a")).toBe("");
  });

  test("an empty or null change reads as flat, matching the pre-extraction chip", () => {
    // Number("") and Number(null) are 0, so these render "0.00%" rather than
    // dropping the pill. Documented so a future change is deliberate.
    expect(formatSignalChipChange("")).toBe("0.00%");
    expect(formatSignalChipChange(null)).toBe("0.00%");
  });

  test("tones follow the sign, and an unknown change is neutral", () => {
    expect(signalChangeTone("1.1")).toBe("positive");
    expect(signalChangeTone("-1.1")).toBe("negative");
    expect(signalChangeTone("0")).toBe("neutral");
    expect(signalChangeTone(undefined)).toBe("neutral");
    expect(signalChangeTone("n/a")).toBe("neutral");
  });
});
