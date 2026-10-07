/**
 * Behavioral cover for the perps Closed tab.
 *
 * The fold itself is unit-tested in `perp-closed-positions.test.ts`; what is
 * asserted here is the panel's own behavior: that it reads only the perp fills
 * feed, that it does not poll while its tab is hidden (the responsive-shell
 * rule in CLAUDE.md), and that a stop-loss close is actually labelled as one
 * on screen. The last is the reason the tab exists.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const fillsResult = {
  data: undefined as unknown,
  isLoading: false,
  error: null as { message: string } | null,
};

const queryCalls: Array<{ router: string; input: unknown; options: Record<string, unknown> }> = [];

mock.module("@/lib/trpc", () => ({
  trpc: new Proxy(
    {},
    {
      get(_target, router: string) {
        if (router !== "positions") {
          throw new Error(
            `the closed-positions panel must not read the ${router} router`,
          );
        }
        return {
          listPerpFills: {
            useQuery: (input: unknown, options: Record<string, unknown>) => {
              queryCalls.push({ router, input, options });
              return fillsResult;
            },
          },
        };
      },
    },
  ),
}));

const { PerpClosedPanel, CLOSED_POSITION_FILL_SCAN } = await import("./perp-closed-panel");

/** Server-rendered text of the panel, with tags stripped. */
function render(props: { enabled: boolean; active?: boolean }): string {
  queryCalls.length = 0;
  fillsResult.isLoading = false;
  fillsResult.error = null;
  return renderToStaticMarkup(<PerpClosedPanel {...props} />).replace(/<[^>]*>/g, " ");
}

function fill(overrides: Record<string, unknown>) {
  return {
    coin: "BTC",
    side: "buy",
    px: "100",
    sz: "1",
    closedPnl: "0.0",
    fee: "0.1",
    dir: "Open Long",
    oid: 1,
    hash: "0xabc",
    tid: 1,
    orderType: null,
    ...overrides,
  };
}

describe("PerpClosedPanel", () => {
  test("names a stop-loss close on screen rather than showing a bare exit", () => {
    fillsResult.data = {
      fills: [
        fill({ time: 2, side: "sell", px: "90", dir: "Close Long", closedPnl: "-10", oid: 2, orderType: "StopMarket" }),
        fill({ time: 1, side: "buy", px: "100", dir: "Open Long", oid: 1 }),
      ],
    };

    const text = render({ enabled: true });
    expect(text).toContain("Stop loss");
    expect(text).toContain("BTC");
    expect(text).toContain("long");
  });

  test("a manual close is not labelled as a stop", () => {
    fillsResult.data = {
      fills: [
        fill({ time: 2, side: "sell", dir: "Close Long", oid: 2, orderType: "Market" }),
        fill({ time: 1, side: "buy", dir: "Open Long", oid: 1 }),
      ],
    };

    const text = render({ enabled: true });
    expect(text).toContain("Manual");
    expect(text).not.toContain("Stop loss");
  });

  test("shows an empty state rather than a bare table when nothing has closed", () => {
    fillsResult.data = { fills: [fill({ time: 1, dir: "Open Long" })] };
    expect(render({ enabled: true })).toContain("No closed perp positions yet.");
  });

  test("does not fetch until perps are enabled, and says why", () => {
    fillsResult.data = { fills: [] };
    const markup = render({ enabled: false });
    // The hook must still be called (rules of hooks); what matters is that it
    // is disabled, so a user with no perps credential never hits Hyperliquid.
    expect(queryCalls[0]?.options.enabled).toBe(false);
    expect(markup).toContain("Set up perpetual futures");
  });

  test("a hidden tab neither fetches nor polls", () => {
    fillsResult.data = { fills: [] };
    render({ enabled: true, active: false });
    expect(queryCalls[0]?.options.enabled).toBe(false);
    expect(queryCalls[0]?.options.refetchInterval).toBe(false);
  });

  test("scans a wider fill window than the per-fill history tab", () => {
    fillsResult.data = { fills: [] };
    render({ enabled: true });
    expect(queryCalls[0]?.input).toEqual({ limit: CLOSED_POSITION_FILL_SCAN });
    expect(CLOSED_POSITION_FILL_SCAN).toBeGreaterThan(100);
    // The procedure caps at 500; asking for more would be rejected outright.
    expect(CLOSED_POSITION_FILL_SCAN).toBeLessThanOrEqual(500);
  });

  test("keeps every column reachable on a phone instead of demanding a 760px table", () => {
    queryCalls.length = 0;
    fillsResult.isLoading = false;
    fillsResult.error = null;
    fillsResult.data = {
      fills: [
        fill({ time: 2, side: "sell", px: "90", dir: "Close Long", closedPnl: "-10", oid: 2, orderType: "StopMarket" }),
        fill({ time: 1, side: "buy", px: "100", dir: "Open Long", oid: 1 }),
      ],
    };

    // The positions panel's Closed view wraps this in an overflow-x-hidden
    // content box, so a fixed minimum table width is not a sideways scroll
    // there, it is columns the user cannot reach at all.
    const markup = renderToStaticMarkup(<PerpClosedPanel bare enabled />);
    expect(markup).not.toMatch(/min-w-\[\d+px\]/);
    // The table sizes itself from its own container, not the viewport, so the
    // same markup serves the desktop drawer and the phone.
    expect(markup).toContain("@container/perpclosed");

    // The stacked phone row states the close time, size, close price and fee
    // under the coin, so the narrow layout loses nothing the wide one shows.
    const text = markup.replace(/<[^>]*>/g, " ");
    for (const label of ["Closed", "Size", "Avg close", "Fee", "Stop loss", "long"]) {
      expect(text).toContain(label);
    }
  });

  test("surfaces a failed read instead of an empty table", () => {
    queryCalls.length = 0;
    fillsResult.data = undefined;
    fillsResult.isLoading = false;
    fillsResult.error = { message: "hyperliquid unreachable" };
    const markup = renderToStaticMarkup(<PerpClosedPanel enabled />).replace(/<[^>]*>/g, " ");
    expect(markup).toContain("hyperliquid unreachable");
    expect(markup).not.toContain("No closed perp positions yet.");
  });
});
