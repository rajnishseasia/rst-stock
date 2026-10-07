import { describe, expect, test } from "bun:test";

import {
  parseShareVolume,
  perpLeverageMetric,
  perpRowMetrics,
  stockRowMetrics,
} from "./market-row-metrics";
import type { PerpMarketRow } from "@/components/perps/perp-market-row";

const btc: PerpMarketRow = {
  coin: "BTC",
  markPx: "64000",
  prevDayPx: "63000",
  dayNtlVlm: "2000000000",
  openInterest: "12000",
  funding: "0.0000125",
};

describe("parseShareVolume", () => {
  test("reads the grouped locale string the quote routers actually return", () => {
    // Regression: `quotes.getStockQuotes` and `quotes.getChartQuotes` both
    // return volume as `Number#toLocaleString()`, and Number("12,345,678") is
    // NaN, so a naive parse blanks the metric on every stock row.
    expect(parseShareVolume("12,345,678")).toBe(12345678);
  });

  test("reads a ranking tile's plain number just as well", () => {
    expect(parseShareVolume(52100000)).toBe(52100000);
  });

  test("treats absent, blank and unparseable volume as no volume, not zero", () => {
    expect(parseShareVolume(null)).toBeNull();
    expect(parseShareVolume(undefined)).toBeNull();
    expect(parseShareVolume("")).toBeNull();
    expect(parseShareVolume("   ")).toBeNull();
    expect(parseShareVolume("n/a")).toBeNull();
    expect(parseShareVolume(Number.NaN)).toBeNull();
  });
});

describe("stockRowMetrics", () => {
  test("renders share volume as a count, never as dollars", () => {
    // 52.1 million SHARES. "$52.1M" would be a different number entirely, so
    // the equity side must not reach for formatCompactUsd.
    const [volume] = stockRowMetrics("52,100,000");
    expect(volume?.label).toBe("Vol");
    expect(volume?.value).toBe("52.1M");
    expect(volume?.value).not.toContain("$");
  });

  test("omits the metric entirely when nothing has traded yet", () => {
    // A pre-market snapshot has no volume. An omitted number reads better
    // than a row asserting there was none.
    expect(stockRowMetrics("0")).toEqual([]);
    expect(stockRowMetrics(null)).toEqual([]);
    expect(stockRowMetrics(-5)).toEqual([]);
  });
});

describe("perpRowMetrics", () => {
  test("reuses the desktop composer's three axes in its fixed order", () => {
    expect(perpRowMetrics(btc).map((metric) => metric.key)).toEqual([
      "volume",
      "open-interest",
      "funding",
    ]);
    expect(perpRowMetrics(btc).map((metric) => metric.label)).toEqual([
      "Vol",
      "OI",
      "Fund",
    ]);
    // Open interest stays valued in USD at the mark, exactly as the desktop
    // HL Markets list values it: 12,000 BTC at $64,000 is $768M.
    expect(perpRowMetrics(btc)[1]?.value).toBe("$768M");
  });

  test("falls back to a ranking tile's notional volume when live stats are absent", () => {
    const metrics = perpRowMetrics(null, 2_000_000_000);
    expect(metrics).toHaveLength(1);
    // Hyperliquid volume really is notional dollars, so this one keeps the $.
    expect(metrics[0]?.value).toBe("$2B");
  });

  test("shows nothing at all rather than a row of dashes with no data", () => {
    expect(perpRowMetrics(null)).toEqual([]);
    expect(perpRowMetrics(null, 0)).toEqual([]);
    expect(perpRowMetrics(null, "not a number")).toEqual([]);
  });
});

describe("perpLeverageMetric", () => {
  test("labels the venue's max leverage without restating a badge", () => {
    expect(perpLeverageMetric(40)).toEqual([
      { key: "leverage", label: "Max", value: "40x" },
    ]);
  });

  test("is dropped when the venue reports no usable leverage", () => {
    expect(perpLeverageMetric(null)).toEqual([]);
    expect(perpLeverageMetric(0)).toEqual([]);
    expect(perpLeverageMetric(Number.NaN)).toEqual([]);
  });
});
