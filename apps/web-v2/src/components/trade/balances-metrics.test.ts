/**
 * The Balances grid's cells, tested as data.
 *
 * The rule these assertions exist for: a value we do not have renders "-", not
 * "$0.00". A zeroed free-margin or maintenance-margin cell is a specific and
 * wrong claim about the account, and it is the kind of wrongness a trader acts
 * on.
 */

import { describe, expect, test } from "bun:test";

import {
  perpBalanceMetrics,
  perpNetworkLabel,
  stockBalanceMetrics,
} from "./balances-metrics";

function value(metrics: ReturnType<typeof stockBalanceMetrics>, label: string): string {
  const metric = metrics.find((entry) => entry.label === label);
  if (!metric) throw new Error(`no metric labeled ${label}`);
  return metric.value;
}

const ACCOUNT = {
  equity: 25_000.5,
  cash: 4_200,
  nonMarginableBuyingPower: 4_200,
  buyingPower: 16_800,
  longMarketValue: 21_300.25,
  shortMarketValue: -1_500,
  initialMargin: 10_650,
  maintenanceMargin: 6_390,
};

describe("stockBalanceMetrics", () => {
  test("surfaces the account fields the header was already fetching and dropping", () => {
    const metrics = stockBalanceMetrics(ACCOUNT);

    expect(value(metrics, "Equity")).toBe("$25,000.50");
    expect(value(metrics, "Cash")).toBe("$4,200.00");
    expect(value(metrics, "Long value")).toBe("$21,300.25");
    expect(value(metrics, "Short value")).toBe("-$1,500.00");
    expect(value(metrics, "Initial margin")).toBe("$10,650.00");
    expect(value(metrics, "Maint. margin")).toBe("$6,390.00");
  });

  test("leads with the non-marginable floor, and labels the margin-inflated figure as margin", () => {
    // The two differ by 4x here. Painting `buyingPower` as "Buying power" is
    // how a user sizes an order against $16,800 and gets rejected for
    // insufficient buying power on a non-marginable symbol.
    const metrics = stockBalanceMetrics(ACCOUNT);

    expect(value(metrics, "Buying power")).toBe("$4,200.00");
    expect(value(metrics, "Margin BP")).toBe("$16,800.00");
    expect(metrics.findIndex((entry) => entry.label === "Buying power")).toBeLessThan(
      metrics.findIndex((entry) => entry.label === "Margin BP"),
    );
  });

  test("renders every cell as unknown when the account has not loaded", () => {
    for (const account of [undefined, null, {}]) {
      const metrics = stockBalanceMetrics(account);
      expect(metrics.length).toBeGreaterThan(0);
      for (const metric of metrics) {
        expect(metric.value).toBe("-");
      }
    }
  });

  test("a real zero still reads as zero", () => {
    // "-" means "we do not know". An account that genuinely holds no cash must
    // say so, or the two states become indistinguishable.
    expect(value(stockBalanceMetrics({ cash: 0 }), "Cash")).toBe("$0.00");
  });

  test("every cell carries an explanation", () => {
    for (const metric of stockBalanceMetrics(ACCOUNT)) {
      expect(metric.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("perpBalanceMetrics", () => {
  const status = {
    hlEquityUsd: "35100.42",
    hlBalanceUsd: "3900.18",
    network: "mainnet",
  };

  test("separates account value from collateral, and shows what is still free", () => {
    // These two are far apart on a unified account holding non-USDC spot
    // (measured: about $3.9k collateral against $35.1k equity), which is
    // exactly why they are two cells and not one.
    const metrics = perpBalanceMetrics({
      status,
      collateral: { freeUsd: "2010.43", accountValueUsd: "3157.26" },
    });

    expect(value(metrics, "Account value")).toBe("$35,100.42");
    expect(value(metrics, "Collateral")).toBe("$3,900.18");
    expect(value(metrics, "Free margin")).toBe("$2,010.43");
    expect(value(metrics, "Network")).toBe("Mainnet");
  });

  test("used margin is the committed half of the SAME collateral snapshot", () => {
    // total - free is the `hold` the venue reported in that one response, not
    // a subtraction across two different ledgers.
    const metrics = perpBalanceMetrics({
      status,
      collateral: { freeUsd: "2010.43", accountValueUsd: "3157.26" },
    });

    expect(value(metrics, "Used margin")).toBe("$1,146.83");
  });

  test("a missing collateral read leaves free and used unknown, and does not blank the rest", () => {
    // The collateral procedure fails soft to nulls. Those cells go to "-" while
    // equity and collateral, which came from a different query, still paint.
    const metrics = perpBalanceMetrics({ status, collateral: undefined });

    expect(value(metrics, "Free margin")).toBe("-");
    expect(value(metrics, "Used margin")).toBe("-");
    expect(value(metrics, "Account value")).toBe("$35,100.42");
    expect(value(metrics, "Collateral")).toBe("$3,900.18");
  });

  test("half an answer is not an answer: used margin needs both halves", () => {
    const metrics = perpBalanceMetrics({
      status,
      collateral: { freeUsd: "2010.43", accountValueUsd: null },
    });

    expect(value(metrics, "Free margin")).toBe("$2,010.43");
    expect(value(metrics, "Used margin")).toBe("-");
  });

  test("renders every cell as unknown before anything has loaded", () => {
    for (const metric of perpBalanceMetrics({ status: undefined, collateral: undefined })) {
      expect(metric.value).toBe("-");
    }
  });
});

describe("perpNetworkLabel", () => {
  test("capitalizes a known network and dashes an unknown one", () => {
    expect(perpNetworkLabel("mainnet")).toBe("Mainnet");
    expect(perpNetworkLabel("testnet")).toBe("Testnet");
    expect(perpNetworkLabel(null)).toBe("-");
    expect(perpNetworkLabel(undefined)).toBe("-");
    expect(perpNetworkLabel("")).toBe("-");
  });
});
