/**
 * The product removed day-trade / PDT (Pattern Day Trader) tracking entirely:
 * Alpaca's account payload still reports `daytrade_count` and
 * `pattern_day_trader`, but nothing user-facing may surface them again
 * (docs/superpowers/plans/2026-06-09-remove-day-trades.md).
 *
 * These assertions run against RENDERED markup and real exported data, not
 * against component source text, so a day-trade string reintroduced behind
 * dead code, or one that never actually reaches the DOM, is not enough to
 * pass here - and a harmless rename/reformat of the surrounding source can't
 * fail it either.
 *
 * Coverage that moved elsewhere (not duplicated here, but not dropped):
 *  - apps/api/src/routers/positions.ts (`positions.account` procedure) is
 *    covered by apps/api/src/__tests__/positions-account-no-day-trade.test.ts,
 *    which calls the real procedure with a mocked Alpaca account payload that
 *    includes `daytrade_count` / `pattern_day_trader` and asserts the
 *    returned object omits them.
 *  - apps/api/src/lib/chat/stock-context.ts (`buildStockChatContext`) is
 *    covered by apps/api/src/lib/chat/stock-context.test.ts, which calls the
 *    real function against the same kind of mocked payload and asserts the
 *    built chat context string never mentions day trades.
 *  Both moved because this test file lives in the web-v2 workspace, which
 *  cannot import server-only apps/api modules (Node-only deps, its own env
 *  wiring); colocating each behavioral test next to the code it exercises
 *  matches this repo's existing per-package test convention.
 *
 * Dropped (not converted, and not replaced): the original version of this
 * file also read two docs/tasks/* text snapshots (glossary-section.jsx.txt,
 * guide-review.md). Both are historical planning/review artifacts from a
 * 2026-06 doc workflow - grep confirms nothing in the app imports, renders,
 * or otherwise executes either file, so a stale mention of "day trade" in
 * either one pins no product behavior. See the report for detail.
 */

import { describe, expect, test, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const DAY_TRADE_PATTERN = /day[ _-]?trades?|daytrade|pattern[ _-]?day[ _-]?trader|\bPDT\b/i;

// ---------------------------------------------------------------------------
// positions-panel.tsx
// ---------------------------------------------------------------------------

type MutationResult = {
  mutate: () => void;
  mutateAsync: () => Promise<Record<string, never>>;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  variables: unknown;
  reset: () => void;
};

function noopMutation(): MutationResult {
  return {
    mutate: () => {},
    mutateAsync: async () => ({}),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    variables: undefined,
    reset: () => {},
  };
}

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      positions: {
        account: { invalidate: async () => {} },
        list: {
          cancel: async () => {},
          getData: () => undefined,
          setData: () => {},
          invalidate: async () => {},
        },
      },
    }),
    positions: {
      list: {
        useQuery: () => ({ data: [], isLoading: false, error: null, refetch: async () => {} }),
      },
      closedOrders: {
        useQuery: () => ({
          data: [],
          isLoading: false,
          error: null,
          isFetching: false,
          isPlaceholderData: false,
          refetch: async () => {},
        }),
      },
      close: { useMutation: () => noopMutation() },
      updateStopLoss: { useMutation: () => noopMutation() },
      cancelExitOrder: { useMutation: () => noopMutation() },
      updateTakeProfit: { useMutation: () => noopMutation() },
      createExitStrategy: { useMutation: () => noopMutation() },
    },
    pnlImage: {
      generateClosedOrder: { useMutation: () => noopMutation() },
      generateOpenPosition: { useMutation: () => noopMutation() },
    },
  },
}));

const { PositionsPanel } = await import("../positions-panel");

/**
 * Renders every state PositionsPanel can reach WITHOUT simulating a click
 * (there is no per-row account/day-trade data to render anyway: the
 * `Position` type the panel consumes has never carried day-trade fields,
 * only the removed top-level account summary block did, and that block no
 * longer exists in this component at all - `account` is not even a prop
 * anymore). Concatenating every reachable state's markup means a
 * reintroduced day-trade string anywhere in this component's render tree
 * gets caught regardless of which state it landed in.
 */
function allPositionsPanelMarkup(): string {
  const states = [
    { isSignedIn: false },
    { isSignedIn: true, credentialsLoading: true },
    { isSignedIn: true, activeCredentialId: undefined },
    { isSignedIn: true, activeCredentialId: "cred-1" },
  ];

  return states
    .map((props) => renderToStaticMarkup(createElement(PositionsPanel, props)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// guide/page.tsx
// ---------------------------------------------------------------------------

// UserMenu drags in the better-auth client (session fetching, cookies). Its
// own behavior is irrelevant to whether the guide's copy mentions day
// trades, so replace it with a stub rather than wiring up an auth session.
mock.module("@/components/auth/user-menu", () => ({
  UserMenu: () => null,
}));

const { default: GuidePage } = await import("../../../app/guide/page");
// Imported from its own module, not from the page: a Next page may only export
// `default`, and re-exporting this from there breaks `next build`.
const { ACCOUNT_GLOSSARY_TERMS } = await import("../../../app/guide/account-glossary");

describe("day-trade product removal", () => {
  test("positions-panel.tsx never renders day-trade / PDT content", () => {
    expect(allPositionsPanelMarkup()).not.toMatch(DAY_TRADE_PATTERN);
  });

  test("guide/page.tsx never renders day-trade / PDT copy", () => {
    const markup = renderToStaticMarkup(createElement(GuidePage));
    expect(markup).not.toMatch(DAY_TRADE_PATTERN);

    // Sanity check that this render actually reached the account-summary
    // copy the day-trade bullet used to live next to - an empty/broken
    // render would vacuously pass the assertion above.
    expect(markup).toContain("Portfolio Value");
    expect(markup).toContain("Buying Power");
  });

  test("guide/page.tsx documents current perps, copy, and AI entry points", () => {
    const markup = renderToStaticMarkup(createElement(GuidePage));

    expect(markup).toContain("Trade Perpetual Futures on Hyperliquid");
    expect(markup).toContain('href="/settings?t=perps"');
    expect(markup).toContain("native Circle USDC on Arbitrum only");
    expect(markup).toContain("Create new wallet");

    expect(markup).toContain("Follow &amp; Copy Traders");
    expect(markup).toContain('href="/lb"');
    expect(markup).toContain('href="/settings?t=copy-trading"');
    expect(markup).toContain("explicitly enabled for automatic copying");

    expect(markup).toContain("Use AI Chat");
    expect(markup).toContain('href="/settings?t=models"');
    expect(markup).toContain("/draft $SYM");
    expect(markup).toContain("AI Chat never submits an order automatically");
  });

  test("guide/page.tsx's Account glossary group never lists a day-trade term", () => {
    // This group renders inside a CollapsibleSection that is CLOSED by
    // default, so a plain render of GuidePage never reaches its children -
    // asserting against the exported data the component actually maps over
    // is what makes this reachable at all (see the extraction note on
    // ACCOUNT_GLOSSARY_TERMS in guide/page.tsx).
    expect(ACCOUNT_GLOSSARY_TERMS.length).toBeGreaterThan(0);
    for (const { term, definition } of ACCOUNT_GLOSSARY_TERMS) {
      expect(`${term} ${definition}`).not.toMatch(DAY_TRADE_PATTERN);
    }
  });
});
