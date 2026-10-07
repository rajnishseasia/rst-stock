import { describe, it, expect } from "bun:test";
import type { LibrarySymbolInfo, ResolutionString, PeriodParams } from "@/vendor/charting_library";
import {
  createTradingViewDatafeed,
  type DatafeedDeps,
} from "../tv-datafeed";

/**
 * Real-module tests for the datafeed's symbol casing (per CLAUDE.md audit: no
 * readFileSync+regex). HL perp coins are canonical case-sensitive spellings
 * (kPEPE, xyz:GOOGL) and every HL lookup is exact-match, so the resolved
 * symbol that later feeds getBars/fetchSnapshot must NOT be uppercased on the
 * perps path. Stocks keep the historical trim+uppercase behavior.
 */

function makeDeps(overrides: Partial<DatafeedDeps> = {}): DatafeedDeps {
  return {
    fetchBars: async () => [],
    fetchSnapshot: async () => null,
    fetchExecutionGroups: async () => [],
    fetchSignals: async () => [],
    ...overrides,
  };
}

function resolve(
  deps: DatafeedDeps,
  symbolName: string,
): Promise<LibrarySymbolInfo> {
  const datafeed = createTradingViewDatafeed(deps);
  return new Promise((resolvePromise, rejectPromise) => {
    datafeed.resolveSymbol(
      symbolName,
      (info) => resolvePromise(info),
      (reason) => rejectPromise(new Error(String(reason))),
    );
  });
}

describe("tv-datafeed resolveSymbol casing", () => {
  it("preserves HL canonical coin casing on the perps path (resolveSymbolInfo present)", async () => {
    const deps = makeDeps({
      // Mirrors the perps wrapper in advanced-chart: always returns overrides.
      resolveSymbolInfo: () => ({
        type: "crypto",
        session: "24x7",
        timezone: "Etc/UTC",
        pricescale: 100,
        minmov: 1,
      }),
    });
    for (const coin of ["kPEPE", "kBONK", "xyz:GOOGL"]) {
      const info = await resolve(deps, ` ${coin} `);
      expect(info.ticker).toBe(coin);
      expect(info.name).toBe(coin);
      expect(info.type).toBe("crypto");
      expect(info.session).toBe("24x7");
    }
  });

  it("still trims + uppercases on the stocks path (no resolveSymbolInfo)", async () => {
    const info = await resolve(makeDeps(), " aapl ");
    expect(info.ticker).toBe("AAPL");
    expect(info.name).toBe("AAPL");
    expect(info.type).toBe("stock");
    expect(info.session).toBe("0930-1600");
  });

  it("feeds the preserved perp coin into getBars", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      fetchBars: async ({ symbol }) => {
        seen.push(symbol);
        return [];
      },
      resolveSymbolInfo: () => ({ type: "crypto", session: "24x7" }),
    });
    const info = await resolve(deps, "kPEPE");
    const datafeed = createTradingViewDatafeed(deps);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      datafeed.getBars(
        info,
        "5" as ResolutionString,
        {
          firstDataRequest: true,
          countBack: 10,
          from: 0,
          to: 0,
        } as PeriodParams,
        () => resolvePromise(),
        (reason) => rejectPromise(new Error(String(reason))),
      );
    });
    expect(seen).toEqual(["kPEPE"]);
  });
});
