/**
 * Behavioral cover for the drawer's Balances tab.
 *
 * The panels are hook-free apart from their tRPC reads, so calling them
 * directly returns their element tree and a test can inspect what they actually
 * hand the grid (the same pattern perp-portfolio-panel.test.ts uses). What is
 * worth pinning here is not the layout but the wiring: which router each venue
 * reads, that a hidden or unconfigured venue asks for nothing, and that one
 * failed read does not blank the cells the other read filled.
 */

import { describe, expect, mock, test } from "bun:test";

interface QueryResult {
  data: unknown;
  isLoading: boolean;
  error: { message: string } | null;
}

const accountResult: QueryResult = { data: undefined, isLoading: false, error: null };
const statusResult: QueryResult = { data: undefined, isLoading: false, error: null };
const collateralResult: QueryResult = { data: undefined, isLoading: false, error: null };

const queryCalls: Array<{ path: string; options: Record<string, unknown> }> = [];

function useQueryStub(path: string, result: QueryResult) {
  return (_input: unknown, options: Record<string, unknown>) => {
    queryCalls.push({ path, options });
    return result;
  };
}

mock.module("@/lib/trpc", () => ({
  trpc: {
    positions: {
      account: { useQuery: useQueryStub("positions.account", accountResult) },
    },
    hyperliquid: {
      status: { useQuery: useQueryStub("hyperliquid.status", statusResult) },
      collateral: { useQuery: useQueryStub("hyperliquid.collateral", collateralResult) },
    },
  },
}));

const { PerpBalancesPanel, StockBalancesPanel } = await import("./balances-panel");
const { elementText, flattenElements } = await import(
  "@/testing/element-tree"
);

type Tree = ReturnType<typeof StockBalancesPanel>;

function reset(): void {
  queryCalls.length = 0;
  accountResult.data = undefined;
  accountResult.isLoading = false;
  accountResult.error = null;
  statusResult.data = undefined;
  statusResult.isLoading = false;
  statusResult.error = null;
  collateralResult.data = undefined;
  collateralResult.isLoading = false;
  collateralResult.error = null;
}

/** The cells the panel handed the grid, by label. */
function cells(tree: Tree): Record<string, string> {
  const grid = flattenElements(tree).find((element) =>
    Array.isArray((element.props as { metrics?: unknown }).metrics),
  );
  const metrics = (grid?.props as { metrics?: Array<{ label: string; value: string }> })
    ?.metrics;
  if (!metrics) return {};
  return Object.fromEntries(metrics.map((metric) => [metric.label, metric.value]));
}

function optionsFor(path: string): Record<string, unknown> | undefined {
  return queryCalls.find((call) => call.path === path)?.options;
}

describe("StockBalancesPanel", () => {
  test("paints the Alpaca account fields, leading with the non-marginable floor", () => {
    reset();
    accountResult.data = {
      equity: 25_000.5,
      cash: 4_200,
      nonMarginableBuyingPower: 4_200,
      buyingPower: 16_800,
      longMarketValue: 21_300.25,
      shortMarketValue: 0,
      initialMargin: 10_650,
      maintenanceMargin: 6_390,
    };

    const painted = cells(StockBalancesPanel({ isSignedIn: true, activeCredentialId: "cred-1" }));

    expect(painted["Buying power"]).toBe("$4,200.00");
    expect(painted["Margin BP"]).toBe("$16,800.00");
    expect(painted["Maint. margin"]).toBe("$6,390.00");
    expect(queryCalls.map((call) => call.path)).toEqual(["positions.account"]);
  });

  test("asks for nothing until an account is selected", () => {
    reset();
    const tree = StockBalancesPanel({ isSignedIn: true, activeCredentialId: undefined });

    expect(optionsFor("positions.account")?.enabled).toBe(false);
    expect(cells(tree)).toEqual({});
    expect(
      flattenElements(tree).some(
        (element) =>
          (element.props as { title?: unknown }).title === "No stock account connected",
      ),
    ).toBe(true);
  });

  test("distinguishes 'not signed in' from 'no account connected'", () => {
    reset();
    const signedOut = StockBalancesPanel({ isSignedIn: false });
    expect(elementText(signedOut)).toContain("Sign in");
    expect(optionsFor("positions.account")?.enabled).toBe(false);

    reset();
    const stillLoadingCredentials = StockBalancesPanel({
      isSignedIn: true,
      credentialsLoading: true,
    });
    // Credentials still in flight is not the same as "you have no broker": the
    // connect prompt must not flash while we are still finding out.
    expect(elementText(stillLoadingCredentials)).toContain("Loading balances");
    expect(elementText(stillLoadingCredentials)).not.toContain("No stock account connected");
  });

  test("surfaces an account error instead of a silently empty grid", () => {
    reset();
    accountResult.error = { message: "Alpaca rejected the credentials" };

    const tree = StockBalancesPanel({ isSignedIn: true, activeCredentialId: "cred-1" });
    expect(elementText(tree)).toContain("Alpaca rejected the credentials");
  });

  test("labels itself so the drawer's tab and the panel agree", () => {
    reset();
    // Every branch (loaded, empty, signed out) goes through the same labeled
    // shell, so a screen reader never lands on an unnamed region.
    const labels = [
      StockBalancesPanel({ isSignedIn: true, activeCredentialId: "cred-1" }),
      StockBalancesPanel({ isSignedIn: false }),
      StockBalancesPanel({ isSignedIn: true }),
    ].map((tree) => (tree as { props: { label?: unknown } }).props.label);

    expect(labels).toEqual(["Stock balances", "Stock balances", "Stock balances"]);
  });
});

describe("PerpBalancesPanel", () => {
  test("combines status and collateral into one grid", () => {
    reset();
    statusResult.data = {
      hlEquityUsd: "35100.42",
      hlBalanceUsd: "3900.18",
      network: "mainnet",
    };
    collateralResult.data = {
      enabled: true,
      freeUsd: "2010.43",
      accountValueUsd: "3157.26",
      source: "spot-unified",
    };

    const painted = cells(PerpBalancesPanel({ enabled: true }));

    expect(painted["Account value"]).toBe("$35,100.42");
    expect(painted["Free margin"]).toBe("$2,010.43");
    expect(painted["Used margin"]).toBe("$1,146.83");
    expect(queryCalls.map((call) => call.path).sort()).toEqual([
      "hyperliquid.collateral",
      "hyperliquid.status",
    ]);
  });

  test("a failed collateral read leaves the status cells intact", () => {
    // The whole reason collateral is a second query: its failure mode (an
    // unreadable abstraction mode, a venue timeout) must not take the equity
    // and collateral numbers down with it.
    reset();
    statusResult.data = {
      hlEquityUsd: "35100.42",
      hlBalanceUsd: "3900.18",
      network: "mainnet",
    };
    collateralResult.data = undefined;
    collateralResult.error = { message: "Hyperliquid unreachable" };

    const painted = cells(PerpBalancesPanel({ enabled: true }));

    expect(painted["Account value"]).toBe("$35,100.42");
    expect(painted["Collateral"]).toBe("$3,900.18");
    expect(painted["Free margin"]).toBe("-");
    expect(painted["Used margin"]).toBe("-");
  });

  test("asks for nothing while Hyperliquid is not set up", () => {
    reset();
    const tree = PerpBalancesPanel({ enabled: false });

    expect(elementText(tree)).toContain("Set up Hyperliquid");
    expect(optionsFor("hyperliquid.status")?.enabled).toBe(false);
    expect(optionsFor("hyperliquid.collateral")?.enabled).toBe(false);
    expect(cells(tree)).toEqual({});
  });

  test("never reads an Alpaca router", () => {
    reset();
    statusResult.data = { hlEquityUsd: "1", hlBalanceUsd: "1", network: "mainnet" };
    PerpBalancesPanel({ enabled: true });

    expect(queryCalls.some((call) => call.path.startsWith("positions."))).toBe(false);
  });
});
