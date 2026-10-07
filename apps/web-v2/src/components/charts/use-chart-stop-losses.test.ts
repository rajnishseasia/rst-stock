/**
 * Venue-isolation cover for the chart's stop-loss read.
 *
 * The property worth pinning is which venue gets called: a stock chart must
 * never poll Hyperliquid and a perp chart must never poll Alpaca, both because
 * it is a rejected request per minute and because reaching the wrong venue is
 * how a take-profit ends up drawn as a stop.
 */

import { describe, expect, mock, test } from "bun:test";

const results = new Map<string, { data: unknown; error: unknown }>();
const calls: Array<{ procedure: string; input: unknown; options: Record<string, unknown> }> = [];

function stubProcedure(procedure: string) {
  return {
    useQuery: (input: unknown, options: Record<string, unknown>) => {
      calls.push({ procedure, input, options });
      return results.get(procedure) ?? { data: undefined, error: null };
    },
  };
}

mock.module("@/lib/trpc", () => ({
  trpc: {
    positions: {
      list: stubProcedure("list"),
      listPerpOpenOrders: stubProcedure("listPerpOpenOrders"),
    },
  },
}));

const { useChartStopLosses, STOP_LOSS_POLL_MS } = await import("./use-chart-stop-losses");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

/**
 * Run the hook inside a real render pass. The hook uses `useMemo`, so calling
 * it bare has no dispatcher; a throwaway probe component is the smallest way
 * to exercise it as React actually runs it.
 */
function run(args: Parameters<typeof useChartStopLosses>[0]) {
  calls.length = 0;
  let captured: ReturnType<typeof useChartStopLosses> = [];
  function Probe() {
    captured = useChartStopLosses(args);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return captured;
}

function optionsFor(procedure: string) {
  return calls.find((call) => call.procedure === procedure)?.options ?? {};
}

describe("useChartStopLosses", () => {
  test("a stock chart reads Alpaca positions and leaves Hyperliquid disabled", () => {
    results.set("list", {
      data: [{ symbol: "AAPL", stopLossOrders: [{ stopPrice: 185 }] }],
      error: null,
    });
    const lines = run({ symbol: "AAPL", isPerps: false });

    expect(lines.map((l) => l.price)).toEqual([185]);
    expect(optionsFor("list").enabled).toBe(true);
    expect(optionsFor("listPerpOpenOrders").enabled).toBe(false);
  });

  test("a perp chart reads Hyperliquid triggers and leaves Alpaca disabled", () => {
    results.set("listPerpOpenOrders", {
      data: {
        orders: [{ coin: "BTC", triggerPx: "60000", tpsl: "sl", isTrigger: true }],
      },
      error: null,
    });
    const lines = run({ symbol: "BTC", isPerps: true });

    expect(lines.map((l) => l.price)).toEqual([60000]);
    expect(optionsFor("listPerpOpenOrders").enabled).toBe(true);
    expect(optionsFor("list").enabled).toBe(false);
  });

  test("draws nothing, and asks nothing, when disabled", () => {
    const lines = run({ symbol: "AAPL", isPerps: false, enabled: false });
    expect(lines).toEqual([]);
    expect(optionsFor("list").enabled).toBe(false);
    expect(optionsFor("listPerpOpenOrders").enabled).toBe(false);
  });

  test("polls the active venue, and stops polling once it has failed", () => {
    results.set("list", { data: undefined, error: null });
    run({ symbol: "AAPL", isPerps: false });
    const poll = optionsFor("list").refetchInterval as (q: unknown) => number | false;

    expect(poll({ state: { error: null } })).toBe(STOP_LOSS_POLL_MS);
    // A user with no broker credential gets a hard rejection; re-issuing it
    // every minute for as long as a chart is open buys nothing.
    expect(poll({ state: { error: new Error("no credentials") } })).toBe(false);
  });

  test("the inactive venue never polls, even while healthy", () => {
    run({ symbol: "BTC", isPerps: true });
    const poll = optionsFor("list").refetchInterval as (q: unknown) => number | false;
    expect(poll({ state: { error: null } })).toBe(false);
  });
});
