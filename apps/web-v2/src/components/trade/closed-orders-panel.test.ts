/**
 * Behavioral cover for the extracted closed-orders (trade history) surface.
 *
 * History used to exist only inside positions-panel.tsx, reachable by opening
 * Positions and flipping its Open | Closed toggle. It is now also the drawer's
 * History tab, so the list, the paging rules and the placeholder rule live in
 * their own modules and BOTH surfaces read them. These tests cover the parts
 * that would silently regress if the two ever forked: the query gating, the
 * account-scoped placeholder, and the ordering.
 */

import { describe, expect, mock, test } from "bun:test";

import type { ClosedOrder } from "./closed-orders-list";

interface ClosedOrdersQueryState {
  data: unknown;
  isLoading: boolean;
  error: { message: string } | null;
  isFetching: boolean;
  isPlaceholderData: boolean;
}

const closedOrdersState: ClosedOrdersQueryState = {
  data: [],
  isLoading: false,
  error: null,
  isFetching: false,
  isPlaceholderData: false,
};

let capturedInput: { credentialId?: string; limit?: number } | null = null;
let capturedOptions: Record<string, unknown> | null = null;

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isError: false,
  error: null,
  isSuccess: false,
  variables: undefined,
  reset: () => {},
};

mock.module("@/lib/trpc", () => ({
  trpc: {
    positions: {
      closedOrders: {
        useQuery: (
          input: { credentialId?: string; limit?: number },
          options: Record<string, unknown>,
        ) => {
          capturedInput = input;
          capturedOptions = options;
          return closedOrdersState;
        },
      },
    },
    pnlImage: {
      generateClosedOrder: { useMutation: () => noopMutation },
    },
  },
}));

const { ClosedOrdersPanel } = await import("./closed-orders-panel");
const { sortClosedOrders, formatCompactAgo } = await import("./closed-orders-list");
const { CLOSED_ORDERS_MAX, CLOSED_ORDERS_PAGE_SIZE, closedOrdersQueryCredentialId } =
  await import("./closed-orders-query");
const { renderToStaticMarkup } = await import("react-dom/server");
const React = await import("react");

function order(overrides: Partial<ClosedOrder> = {}): ClosedOrder {
  return {
    id: "order-1",
    symbol: "AAPL",
    side: "sell",
    qty: 10,
    fillPrice: 160,
    filledAt: "2026-09-01T12:00:00.000Z",
    submittedAt: "2026-09-01T11:59:00.000Z",
    status: "filled",
    orderType: "market",
    assetClass: "us_equity",
    realizedPnl: 100,
    ...overrides,
  };
}

function render(props: Parameters<typeof ClosedOrdersPanel>[0]): string {
  capturedInput = null;
  capturedOptions = null;
  return renderToStaticMarkup(React.createElement(ClosedOrdersPanel, props));
}

describe("ClosedOrdersPanel", () => {
  test("renders the closed rows for the active account", () => {
    closedOrdersState.data = [
      order({ id: "a", symbol: "AAPL", realizedPnl: 120.5 }),
      order({ id: "b", symbol: "MSFT", realizedPnl: -40 }),
    ];

    const markup = render({ isSignedIn: true, activeCredentialId: "cred-1" });

    expect(markup).toContain("AAPL");
    expect(markup).toContain("MSFT");
    expect(markup).toContain("$120.50");
    expect(capturedInput?.credentialId).toBe("cred-1");
    closedOrdersState.data = [];
  });

  test("polls while it is the visible tab, unlike the positions panel's hidden Closed view", () => {
    // This panel IS the history view, so it is always active while mounted. The
    // drawer only mounts the selected sub-tab, so "always on" here still means
    // nothing polls while the user is looking at another tab.
    render({ isSignedIn: true, activeCredentialId: "cred-1" });

    expect(capturedOptions?.enabled).toBe(true);
    expect(capturedOptions?.refetchInterval).toBe(15000);
  });

  test("asks for nothing without an account, and offers the connect path", () => {
    const markup = render({ isSignedIn: true, activeCredentialId: undefined });

    expect(capturedOptions?.enabled).toBe(false);
    expect(markup).toContain("No stock account connected");
  });

  test("distinguishes signed out from still-loading credentials", () => {
    expect(render({ isSignedIn: false })).toContain("Sign in to see closed orders.");
    expect(
      render({ isSignedIn: true, credentialsLoading: true }),
    ).toContain("Loading closed orders...");
  });

  test("stays bounded: one page at a time, capped at the server's maximum", () => {
    render({ isSignedIn: true, activeCredentialId: "cred-1" });

    expect(capturedInput?.limit).toBe(CLOSED_ORDERS_PAGE_SIZE);
    expect(CLOSED_ORDERS_MAX).toBe(200);
    expect(CLOSED_ORDERS_PAGE_SIZE).toBeLessThan(CLOSED_ORDERS_MAX);
  });
});

describe("closedOrdersQueryCredentialId", () => {
  test("reads the account a previous page belonged to, and fails safe on anything else", () => {
    // The placeholder rule this feeds is a correctness rule: carrying rows
    // across a Paper/Live switch shows the other account's realized P&L with no
    // loading state in between.
    expect(
      closedOrdersQueryCredentialId({
        queryKey: [["positions", "closedOrders"], { input: { credentialId: "cred-7" } }],
      }),
    ).toBe("cred-7");
    expect(closedOrdersQueryCredentialId(undefined)).toBeUndefined();
    expect(closedOrdersQueryCredentialId({ queryKey: "not-an-array" })).toBeUndefined();
    expect(closedOrdersQueryCredentialId({ queryKey: [["positions"]] })).toBeUndefined();
    expect(
      closedOrdersQueryCredentialId({ queryKey: [["positions"], { input: {} }] }),
    ).toBeUndefined();
  });

  test("the panel only carries rows forward within the same account", () => {
    render({ isSignedIn: true, activeCredentialId: "cred-1" });
    const placeholderData = capturedOptions?.placeholderData as (
      prev: unknown,
      prevQuery: unknown,
    ) => unknown;

    const previousRows = [order()];
    expect(
      placeholderData(previousRows, {
        queryKey: [["positions", "closedOrders"], { input: { credentialId: "cred-1" } }],
      }),
    ).toBe(previousRows);
    expect(
      placeholderData(previousRows, {
        queryKey: [["positions", "closedOrders"], { input: { credentialId: "cred-2" } }],
      }),
    ).toBeUndefined();
  });
});

describe("sortClosedOrders", () => {
  const older = order({ id: "older", filledAt: "2026-08-01T00:00:00.000Z", realizedPnl: 500, qty: 1, fillPrice: 10 });
  const newer = order({ id: "newer", filledAt: "2026-09-01T00:00:00.000Z", realizedPnl: -20, qty: 100, fillPrice: 10 });

  test("date is newest first", () => {
    expect(sortClosedOrders([older, newer], "date").map((o) => o.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("pnl is best first, and value is largest notional first", () => {
    expect(sortClosedOrders([newer, older], "pnl").map((o) => o.id)).toEqual([
      "older",
      "newer",
    ]);
    expect(sortClosedOrders([older, newer], "value").map((o) => o.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("does not mutate the caller's array", () => {
    const input = [older, newer];
    sortClosedOrders(input, "date");
    expect(input.map((o) => o.id)).toEqual(["older", "newer"]);
  });

  test("falls back to the submit time when a row never filled", () => {
    const canceled = order({
      id: "canceled",
      filledAt: null,
      submittedAt: "2026-09-02T00:00:00.000Z",
      status: "canceled",
      realizedPnl: null,
    });
    expect(sortClosedOrders([older, newer, canceled], "date")[0].id).toBe("canceled");
  });
});

describe("formatCompactAgo", () => {
  test("stays short enough that a history row cannot overlap its own P&L", () => {
    const now = Date.now();
    expect(formatCompactAgo(new Date(now - 30_000))).toBe("30s");
    expect(formatCompactAgo(new Date(now - 5 * 60_000))).toBe("5m");
    expect(formatCompactAgo(new Date(now - 3 * 3_600_000))).toBe("3h");
    expect(formatCompactAgo(new Date(now - 3 * 86_400_000))).toBe("3d");
    expect(formatCompactAgo(new Date(now - 14 * 86_400_000))).toBe("2w");
    expect(formatCompactAgo(new Date(now - 60 * 86_400_000))).toBe("2mo");
    expect(formatCompactAgo(new Date(now - 800 * 86_400_000))).toBe("2y");
    // A clock skew that puts a fill in the future must not print "-42s".
    expect(formatCompactAgo(new Date(now + 42_000))).toBe("0s");
  });
});
