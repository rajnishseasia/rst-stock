import { describe, expect, it } from "bun:test";

import { perpMarketRowMetrics, type PerpMarketRow } from "./perp-market-row";

const btc: PerpMarketRow = {
  coin: "BTC",
  markPx: "64000",
  prevDayPx: "63000",
  dayNtlVlm: "2000000000",
  openInterest: "12000",
  funding: "0.0000125",
};

describe("perpMarketRowMetrics", () => {
  it("returns volume, open interest and funding in a fixed order", () => {
    expect(perpMarketRowMetrics(btc).map((metric) => metric.key)).toEqual([
      "volume",
      "open-interest",
      "funding",
    ]);
    expect(perpMarketRowMetrics(btc).map((metric) => metric.label)).toEqual([
      "Vol",
      "OI",
      "Fund",
    ]);
  });

  it("shows the same three metrics whatever the row's numbers are", () => {
    // Regression: the list used to swap in a single metric based on the active
    // sort, so two rows could not be compared on the same axis and funding was
    // never shown at all.
    const quiet: PerpMarketRow = {
      coin: "QUIET",
      markPx: "1",
      prevDayPx: "1",
      dayNtlVlm: null,
      openInterest: null,
      funding: null,
    };
    expect(perpMarketRowMetrics(quiet).map((metric) => metric.key)).toEqual(
      perpMarketRowMetrics(btc).map((metric) => metric.key),
    );
  });

  it("values open interest in USD at the mark, not in coin units", () => {
    // 12,000 BTC at $64,000 is $768M. The raw coin count (12,000) is not
    // comparable to a memecoin's 90,000,000, so the row must not show it.
    const [, openInterest] = perpMarketRowMetrics(btc);
    expect(openInterest?.value).toBe("$768M");
    expect(openInterest?.value).not.toContain("12,000");
  });

  it("keeps a sub-0.01% funding rate readable instead of rounding it to zero", () => {
    const [, , funding] = perpMarketRowMetrics(btc);
    expect(funding?.value).toBe("+0.00125%");

    const negative = perpMarketRowMetrics({ ...btc, funding: "-0.0000342" });
    expect(negative[2]?.value.startsWith("-")).toBe(true);
  });

  it("compacts 24h volume rather than printing every digit", () => {
    const [volume] = perpMarketRowMetrics(btc);
    expect(volume?.value).toBe("$2B");
  });

  it("falls back to a dash for every metric HL did not report", () => {
    const empty = perpMarketRowMetrics({
      coin: "NEW",
      markPx: null,
      prevDayPx: null,
      dayNtlVlm: null,
      openInterest: null,
      funding: null,
    });
    expect(empty.map((metric) => metric.value)).toEqual(["-", "-", "-"]);
  });

  it("still reports volume and funding when only open interest is unusable", () => {
    const partial = perpMarketRowMetrics({ ...btc, openInterest: null });
    expect(partial.map((metric) => metric.value)).toEqual([
      "$2B",
      "-",
      "+0.00125%",
    ]);
  });
});
