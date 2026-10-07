import { describe, expect, test } from "bun:test";
import {
  formatPerpChangePct,
  formatPerpFundingPct,
  formatPerpRoePct,
  formatPerpPx,
  formatPerpExitPx,
  formatPerpNotionalUsd,
  formatPerpQuote,
  formatPerpUsd,
} from "./perp-format";
import { formatUsd } from "@/lib/format";

describe("formatPerpChangePct", () => {
  test("derives a signed positive percentage from mark vs prevDay", () => {
    const { text, tone } = formatPerpChangePct("110", "100");
    expect(text).toBe("+10.00%");
    expect(tone).toBe("positive");
  });

  test("derives a negative percentage and tone", () => {
    const { text, tone } = formatPerpChangePct("90", "100");
    expect(text).toBe("-10.00%");
    expect(tone).toBe("negative");
  });

  test("widens precision for a sub-0.01% move", () => {
    const { text } = formatPerpChangePct("100.001", "100");
    expect(text).toBe("+0.00100%");
  });

  test("returns neutral '-' when a price is missing or the reference is zero", () => {
    expect(formatPerpChangePct(null, "100")).toEqual({ text: "-", tone: "neutral" });
    expect(formatPerpChangePct("100", null)).toEqual({ text: "-", tone: "neutral" });
    expect(formatPerpChangePct("100", "0")).toEqual({ text: "-", tone: "neutral" });
    expect(formatPerpChangePct("100", "")).toEqual({ text: "-", tone: "neutral" });
  });
});

describe("formatPerpPx", () => {
  test("keeps large prices at 2dp", () => {
    expect(formatPerpPx("109234.5")).toBe("109,234.50");
  });

  test("widens precision for sub-$1 prices so they do not collapse to 0.00", () => {
    // A low-priced coin keeps its significant figures.
    expect(formatPerpPx("0.0000075")).toBe("0.0000075");
  });

  test("returns a dash for absent / non-numeric input", () => {
    expect(formatPerpPx(null)).toBe("-");
    expect(formatPerpPx(undefined)).toBe("-");
    expect(formatPerpPx("")).toBe("-");
    expect(formatPerpPx("not-a-number")).toBe("-");
  });
});

describe("formatPerpExitPx", () => {
  test("omits empty cents but preserves meaningful trigger precision", () => {
    expect(formatPerpExitPx("396.00")).toBe("396");
    expect(formatPerpExitPx("396.25")).toBe("396.25");
    expect(formatPerpExitPx("0.1866")).toBe("0.1866");
  });
});

describe("formatPerpUsd", () => {
  test("adds a currency symbol and adaptive precision", () => {
    expect(formatPerpUsd("109234.5")).toBe("$109,234.50");
    expect(formatPerpUsd("0.0034")).toBe("$0.0034");
  });

  test("returns a dash for absent input", () => {
    expect(formatPerpUsd(null)).toBe("-");
  });
});

describe("formatPerpFundingPct", () => {
  test("renders a sub-0.01% hourly rate without rounding to 0.00%", () => {
    // 0.0000125 (per hour) => 0.00125%.
    expect(formatPerpFundingPct("0.0000125")).toBe("+0.00125%");
  });

  test("renders a negative funding rate with a sign", () => {
    expect(formatPerpFundingPct("-0.0001")).toBe("-0.01%");
  });

  test("returns a dash when funding is absent", () => {
    expect(formatPerpFundingPct(null)).toBe("-");
  });
});

describe("formatPerpRoePct", () => {
  test("formats Hyperliquid's return-on-equity decimal as a signed percentage", () => {
    expect(formatPerpRoePct("0.0344", "1.72", "50")).toBe("+3.44%");
    expect(formatPerpRoePct("-0.1566", "-1.54", "9.83")).toBe("-15.66%");
  });

  test("falls back to unrealized P&L over margin for legacy position payloads", () => {
    expect(formatPerpRoePct(null, "-1.54", "9.83")).toBe("-15.67%");
  });

  test("returns a dash when neither source can produce a finite percentage", () => {
    expect(formatPerpRoePct(null, "1", "0")).toBe("-");
    expect(formatPerpRoePct(null, "bad", "10")).toBe("-");
  });
});

describe("formatPerpQuote", () => {
  test("derives price, positive 24h change, and top-of-book bid/ask", () => {
    const quote = formatPerpQuote({
      markPx: "110000",
      midPx: "110000",
      prevDayPx: "100000",
      bid: "109990",
      ask: "110010",
    });
    expect(quote.price).toBe("$110,000.00");
    expect(quote.dayChange).toBe("+10.00%");
    expect(quote.dayChangeTone).toBe("positive");
    expect(quote.bidAsk).toBe("$109,990.00 / $110,010.00");
    expect(quote.hasData).toBe(true);
  });

  test("marks a down day negative", () => {
    const quote = formatPerpQuote({
      markPx: "95000",
      prevDayPx: "100000",
      bid: null,
      ask: null,
    });
    expect(quote.dayChange).toBe("-5.00%");
    expect(quote.dayChangeTone).toBe("negative");
  });

  test("shows only the percentage change for a low-priced coin", () => {
    const quote = formatPerpQuote({
      markPx: "0.0105",
      prevDayPx: "0.01",
      bid: "0.0104",
      ask: "0.0106",
    });
    expect(quote.dayChange).toBe("+5.00%");
    expect(quote.price).toBe("$0.0105");
    expect(quote.bidAsk).toBe("$0.0104 / $0.0106");
  });

  test("falls back to mid price when mark is missing", () => {
    const quote = formatPerpQuote({
      markPx: null,
      midPx: "42.5",
      prevDayPx: "40",
      bid: null,
      ask: null,
    });
    expect(quote.price).toBe("$42.50");
    expect(quote.hasData).toBe(true);
  });

  test("returns dashes and no data for an empty / loading snapshot", () => {
    const quote = formatPerpQuote(undefined);
    expect(quote.price).toBe("-");
    expect(quote.dayChange).toBe("-");
    expect(quote.dayChangeTone).toBe("neutral");
    expect(quote.bidAsk).toBe("-");
    expect(quote.hasData).toBe(false);
  });

  test("does not divide by a zero previous-day price", () => {
    const quote = formatPerpQuote({
      markPx: "100",
      prevDayPx: "0",
      bid: "99",
      ask: "101",
    });
    expect(quote.dayChange).toBe("-");
    expect(quote.dayChangeTone).toBe("neutral");
    // Price and bid/ask still render.
    expect(quote.price).toBe("$100.00");
    expect(quote.bidAsk).toBe("$99.00 / $101.00");
  });

  test("renders one side of the book when only a bid is present", () => {
    const quote = formatPerpQuote({
      markPx: "10",
      prevDayPx: "10",
      bid: "9.99",
      ask: null,
    });
    expect(quote.bidAsk).toBe("$9.99 / -");
  });
});

describe("sub-cent coins on the order review surface", () => {
  // Regression guard for the perp review dialog. Hyperliquid lists coins priced
  // in fractions of a cent (kPEPE, kBONK, kSHIB), and the fixed 2-decimal
  // formatter renders those as "$0.00". That is tolerable on a glanceable
  // readout and NOT tolerable on the trigger and limit prices in the dialog the
  // user approves before a real-money order.
  test("formatPerpUsd keeps a sub-cent trigger price readable", () => {
    expect(formatPerpUsd(0.002711)).not.toBe("$0.00");
    expect(formatPerpUsd(0.002711)).toBe("$0.002711");
    expect(formatPerpUsd(0.00042)).not.toBe("$0.00");
  });

  test("formatUsd would have collapsed the same price, which is why it is not used", () => {
    // Pins the reason the two helpers exist, so a future refactor that swaps
    // them back has a failing test explaining itself.
    expect(formatUsd(0.002711)).toBe("$0.00");
  });

  test("large perp prices still read normally", () => {
    expect(formatPerpUsd(63048)).toBe("$63,048.00");
    expect(formatPerpUsd(1855.4)).toBe("$1,855.40");
  });
});

describe("formatPerpNotionalUsd", () => {
  test("values a coin size at the given price", () => {
    expect(formatPerpNotionalUsd("0.0231", "63048")).toBe("$1,456.41");
    expect(formatPerpNotionalUsd(120000, "0.002711")).toBe("$325.32");
  });

  test("a short position reports its notional, not a negative amount", () => {
    expect(formatPerpNotionalUsd("-2.5", "1855.4")).toBe("$4,638.50");
  });

  test("returns a dash when the size or price is unusable", () => {
    expect(formatPerpNotionalUsd(null, "63048")).toBe("-");
    expect(formatPerpNotionalUsd("0.5", null)).toBe("-");
    expect(formatPerpNotionalUsd("0.5", "0")).toBe("-");
  });
});
