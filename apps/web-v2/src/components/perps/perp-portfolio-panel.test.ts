/**
 * Behavioral cover for the perps portfolio panel.
 *
 * This replaces a `readFileSync` + `toContain` test that asserted the component
 * mentioned certain identifiers. That style is banned by the audit rule in
 * CLAUDE.md (the source-string allowlist must shrink, never grow) and it could
 * not actually fail for the bug it was written about: a component can name
 * `hlEquityUsd` and still paint an Alpaca number.
 *
 * The trpc stub here is a Proxy that throws on any router other than
 * `hyperliquid`, so "never Alpaca data" is enforced by the panel's own behavior
 * rather than by grepping for the word.
 */

import { describe, expect, mock, test } from "bun:test";

const statusResult = {
  data: undefined as unknown,
  isLoading: false,
  error: null as { message: string } | null,
};

/** Every useQuery call the panel makes, so the test can see what it asked for. */
const queryCalls: Array<{ router: string; options: Record<string, unknown> }> = [];

mock.module("@/lib/trpc", () => ({
  trpc: new Proxy(
    {},
    {
      get(_target, router: string) {
        if (router !== "hyperliquid") {
          throw new Error(
            `perps portfolio must not read the ${router} router; it is Hyperliquid-only`,
          );
        }
        return {
          status: {
            useQuery: (_input: unknown, options: Record<string, unknown>) => {
              queryCalls.push({ router, options });
              return statusResult;
            },
          },
        };
      },
    },
  ),
}));

mock.module("@/components/perps/perp-fills-panel", () => ({
  PerpFillsPanel: function PerpFillsPanel() {
    return null;
  },
}));

const { PerpPortfolioPanel } = await import("./perp-portfolio-panel");
const { elementText, flattenElements, findByAriaLabel } = await import(
  "@/testing/element-tree"
);
const { PerpFillsPanel } = await import("@/components/perps/perp-fills-panel");

function render(enabled: boolean) {
  queryCalls.length = 0;
  return PerpPortfolioPanel({ enabled });
}

/**
 * The value the panel handed to the metric with this label.
 *
 * The metrics are a local composite, so their text lives in props rather than
 * children and `elementText` cannot see it. Reading the prop is still the
 * component's own output, and it is what actually reaches the screen.
 */
function metricValue(tree: ReturnType<typeof render>, label: string): unknown {
  return flattenElements(tree).find((element) => element.props.label === label)
    ?.props.value;
}

/** Distinct component names the panel renders. */
function componentNames(tree: ReturnType<typeof render>): string[] {
  const names = flattenElements(tree)
    .map((element) => element.type)
    .filter((type) => typeof type === "function")
    .map((type) => (type as { name?: string }).name ?? "anonymous");
  return [...new Set(names)].sort();
}

describe("PerpPortfolioPanel", () => {
  test("paints Hyperliquid equity without trading collateral", () => {
    // The actual bug: this panel used to show the Alpaca portfolio. Asserting
    // the painted numbers is what distinguishes the two, since a component can
    // name `hlEquityUsd` and still render something else.
    statusResult.data = {
      hlEquityUsd: 1234.5,
      hlBalanceUsd: 999.25,
      network: "testnet",
    };
    statusResult.isLoading = false;
    statusResult.error = null;

    const tree = render(true);
    expect(metricValue(tree, "Total equity")).toBe("$1,234.50");
    expect(metricValue(tree, "Trading collateral")).toBeUndefined();
    expect(metricValue(tree, "Network")).toBe("Testnet");
  });

  test("reads ONLY the hyperliquid router", () => {
    // The trpc stub throws on any other router, so reaching for an Alpaca or
    // portfolio query fails here rather than silently shipping.
    statusResult.data = { hlEquityUsd: 1, hlBalanceUsd: 1, network: "mainnet" };
    render(true);
    expect(queryCalls.map((call) => call.router)).toEqual(["hyperliquid"]);
  });

  test("shows realized activity and never a portfolio history chart", () => {
    statusResult.data = { hlEquityUsd: 1, hlBalanceUsd: 1, network: "mainnet" };
    const tree = render(true);
    expect(flattenElements(tree).map((element) => element.type)).toContain(
      PerpFillsPanel,
    );
    // The panel's WHOLE component surface, not a denylist of chart names. A
    // portfolio history chart, or anything else, shows up here as a new entry.
    expect(componentNames(tree)).toEqual(["PerpFillsPanel", "PortfolioMetric"]);
  });

  test("asks for nothing while Hyperliquid is not set up", () => {
    // `enabled` is passed through rather than the query being skipped outright,
    // so the flag has to reach the options for the request not to fire.
    statusResult.data = undefined;
    const tree = render(false);
    expect(elementText(tree)).toContain("Set up Hyperliquid");
    expect(queryCalls[0]?.options.enabled).toBe(false);
    expect(findByAriaLabel(tree, "Perps portfolio")).toBeUndefined();
  });

  test("surfaces a status error instead of a blank panel", () => {
    statusResult.data = undefined;
    statusResult.error = { message: "Hyperliquid unreachable" };
    expect(elementText(render(true))).toContain("Hyperliquid unreachable");
    statusResult.error = null;
  });
});
