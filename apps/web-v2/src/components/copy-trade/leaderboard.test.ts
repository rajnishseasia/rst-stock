import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Include the cache provider required by the embedded Copy panel. */
function renderToStaticMarkup(node: Parameters<typeof renderMarkup>[0]) {
  return renderMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));
}
import { assetClassPresentation, assetCoveragePresentation } from "./asset-coverage";
import type { XCallerRow, UserRow, XHorizon } from "./use-leaderboard-view";

// ============================================================
// @/lib/trpc mock
//
// One fixture-driven mock covers every procedure the real leaderboard hooks,
// row cells (FollowButton), ManageFollows, and the X-caller profile page call,
// so the REAL modules run end to end and only the network boundary is faked.
// Each test sets the fixture(s) it needs and calls resetTrpcFixtures() first.
// ============================================================

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  error?: { message: string } | null;
}

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null as { message: string } | null,
  reset: () => {},
};

let xCallersResult: QueryLike<any> = { data: undefined, isLoading: false };
let usersResult: QueryLike<any> = { data: undefined, isLoading: false };
let followsResult: QueryLike<any> = { data: [], isLoading: false, error: null };
let xCallerProfileResult: QueryLike<any> = { data: undefined, isLoading: false, error: null };

const xCallersCalls: Array<{ input: unknown; options: unknown }> = [];
const usersCalls: Array<{ input: unknown; options: unknown }> = [];
const followsCalls: Array<{ input: unknown; options: unknown }> = [];
const xCallerProfileCalls: Array<{ input: { authorKey: string } }> = [];

function resetTrpcFixtures(): void {
  xCallersResult = { data: undefined, isLoading: false };
  usersResult = { data: undefined, isLoading: false };
  followsResult = { data: [], isLoading: false, error: null };
  xCallerProfileResult = { data: undefined, isLoading: false, error: null };
  xCallersCalls.length = 0;
  usersCalls.length = 0;
  followsCalls.length = 0;
  xCallerProfileCalls.length = 0;
}

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      copyTradeFollows: {
        list: { invalidate: () => {}, getData: () => followsResult.data },
      },
      copyTrade: { feed: { invalidate: () => {} } },
      leaderboard: {
        xCallers: { invalidate: () => {} },
        users: { invalidate: () => {} },
      },
    }),
    leaderboard: {
      xCallers: {
        useQuery: (input: unknown, options: unknown) => {
          xCallersCalls.push({ input, options });
          return xCallersResult;
        },
      },
      users: {
        useQuery: (input: unknown, options: unknown) => {
          usersCalls.push({ input, options });
          return usersResult;
        },
      },
      xCallerProfile: {
        useQuery: (input: { authorKey: string }) => {
          xCallerProfileCalls.push({ input });
          return xCallerProfileResult;
        },
      },
    },
    copyTradeFollows: {
      list: {
        useQuery: (input: unknown, options: unknown) => {
          followsCalls.push({ input, options });
          return followsResult;
        },
      },
      follow: { useMutation: () => noopMutation },
      unfollow: { useMutation: () => noopMutation },
      update: { useMutation: () => noopMutation },
    },
    userSettings: {
      hasApiCredentials: {
        useInfiniteQuery: () => ({
          data: { pages: [{ accounts: [], hasCredentials: false, isComplete: true, nextCursor: null }] },
          hasNextPage: false,
          isFetching: false,
          isLoading: false,
          isSuccess: true,
          isError: false,
          error: null,
          fetchNextPage: async () => undefined,
          refetch: async () => undefined,
        }),
      },
      socialIdentity: {
        useQuery: () => ({
          data: {
            twitterLinked: false,
            twitterHandle: null,
            twitterProfileComplete: false,
          },
          isLoading: false,
          refetch: async () => {},
        }),
      },
      refreshTwitterProfile: { useMutation: () => noopMutation },
    },
    copyTrade: {
      mirrorStatus: { useQuery: () => ({ data: null }) },
      // Only CopyTradePanel's header (the Top Traders link + mobile layout)
      // is under test here; the feed itself is empty so the 1200+ line item
      // renderer that owns sizing/option/perp logic never runs. That surface
      // is copy-trade-panel.test.ts's job, not this file's.
      feed: {
        useInfiniteQuery: () => ({
          data: undefined,
          isLoading: false,
          fetchNextPage: () => {},
          hasNextPage: false,
          isFetchingNextPage: false,
        }),
      },
    },
    positions: {
      account: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    quotes: {
      getChartQuotes: { useQuery: () => ({ data: undefined, isLoading: false }) },
      getOptionQuotes: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    hyperliquid: {
      marketStats: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
  },
}));

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

// Only the X-caller profile page needs these. Mocked at the module level
// (rather than left real) because the page is a client component that reads
// route params, the query string, and the session directly from the framework.
// The App Router hands params already URL-decoded once. "author%20one" is
// deliberately chosen so a second decodeURIComponent call would silently
// change it to "author one" instead of leaving it alone, which is exactly the
// regression "uses the already-decoded author key directly" pins.
const MOCK_AUTHOR_KEY = "author%20one";

mock.module("next/navigation", () => ({
  useParams: () => ({ authorKey: MOCK_AUTHOR_KEY }),
  useSearchParams: () => new URLSearchParams([["window", "30d"], ["horizon", "3"]]),
  useRouter: () => ({ replace: () => {} }),
}));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", name: "Test User", email: "t@example.com" } }, isPending: false }),
  signInWithGoogle: async () => {},
  handleSignOut: async () => {},
}));

const { LeaderboardView, XCallersTab, UsersTab } = await import("./leaderboard-view");
const { useXCallersTab, useUsersTab, useFollowedKeys } = await import("./use-leaderboard-view");
const { XCallerRowCard, UserRowCard, UnavailableMetric } = await import(
  "./leaderboard-row-cells"
);
const { buildCallerProfileHref, buildUserProfileHref } = await import(
  "./leaderboard-row-cells"
);
const { followMembershipKeys } = await import("./use-leaderboard-view");
const { ManageFollows } = await import("./manage-follows");
const { CopyTradePanel } = await import("./copy-trade-panel");
const { default: XCallerProfilePage } = await import(
  "../../app/lb/x/[authorKey]/page"
);

/** Runs a hook once inside a real render and returns what it returned. */
function mountHook<T>(useHook: () => T): T {
  let captured: T | undefined;
  function Harness() {
    captured = useHook();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return captured as T;
}

function xCallerRow(overrides: Partial<XCallerRow> = {}): XCallerRow {
  return {
    followTarget: { type: "x_author", key: "author-1", label: "Author One" },
    displayName: "Author One",
    avatar: null,
    assetCoverage: "stocks",
    hitRate: 0.6,
    avgForwardReturnPct: 4.2,
    assetCallCounts: { stocks: 10, perps: 0 },
    callCount: 10,
    directionalCallCount: 8,
    measuredCallCount: 7,
    measurementCandidateCount: 8,
    measurementCallsRetainedCount: 8,
    measurementCandidateOmittedCount: 0,
    measurementCallCap: 100,
    measurementCapped: false,
    needsMarketData: false,
    latestCallUrl: null,
    ...overrides,
  };
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    followTarget: { type: "user", key: "user-1", label: "Trader One" },
    displayName: "Trader One",
    avatar: "",
    realizedPnl: 120.5,
    alpacaPnl: 120.5,
    hyperliquidPnl: 0,
    winRate: 0.55,
    tradeCount: 9,
    lastTradeAt: null,
    hasHyperliquid: false,
    ...overrides,
  };
}

describe("leaderboard dialog data wiring", () => {
  test("the X Callers tab queries only leaderboard.xCallers, never leaderboard.users", () => {
    resetTrpcFixtures();
    mountHook(() => useXCallersTab(true));
    expect(xCallersCalls.length).toBe(1);
    expect(usersCalls.length).toBe(0);
  });

  test("the Users tab queries only leaderboard.users, never leaderboard.xCallers", () => {
    resetTrpcFixtures();
    mountHook(() => useUsersTab(true));
    expect(usersCalls.length).toBe(1);
    expect(xCallersCalls.length).toBe(0);
  });

  test("renders the Callers and Users tabs, Callers active by default", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(LeaderboardView, { isSignedIn: false }));

    expect(markup).toContain(">Callers<");
    expect(markup).toContain(">Users<");
    expect(markup).not.toContain("X Callers");
    // Radix marks the initially-selected tab trigger data-state="active"; the
    // dialog opens on the caller board, not the users board.
    const xTrigger = /<button[^>]*>Callers<\/button>/.exec(markup)?.[0] ?? "";
    const usersTrigger = /<button[^>]*>Users<\/button>/.exec(markup)?.[0] ?? "";
    expect(xTrigger).toContain('data-state="active"');
    expect(usersTrigger).toContain('data-state="inactive"');
  });

  // A caller row can now come from Discord as well as X, so nothing user-facing
  // may claim the board is X-only. Asserted on RENDERED output rather than on
  // the component's source text: the source-contract debt list (see
  // src/testing/source-contract-debt.test.ts) does not carry this file.
  test("keeps caller copy source-neutral for persisted external signals", () => {
    resetTrpcFixtures();
    xCallersResult = {
      data: { rows: [], rankingFallback: false, partialMarketData: false, dataComplete: true },
      isLoading: false,
    };
    const board = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: true }));
    expect(board).toContain("No calls in this window yet.");
    expect(board).not.toContain("No X calls");
  });

  test("canonical and source-alias follow keys share one client membership", () => {
    const canonical = {
      targetType: "x_author" as const,
      targetKey: "source_author:x:42",
      membershipKeys: ["source_alias:x:alice"],
    };
    const alias = {
      targetType: "x_author" as const,
      targetKey: "source_alias:x:alice",
      membershipKeys: ["source_author:x:42"],
    };

    expect(followMembershipKeys(canonical)).toEqual([
      "source_author:x:42",
      "source_alias:x:alice",
    ]);
    expect(followMembershipKeys(alias)).toEqual([
      "source_alias:x:alice",
      "source_author:x:42",
    ]);
  });
});

describe("leaderboard dialog controls", () => {
  test("offers a window selector with exactly 7d / 30d / All, 30d active by default on the X tab", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: false }));

    expect(markup).toContain(">7d<");
    expect(markup).toContain(">30d<");
    expect(markup).toContain(">All<");
    // useXCallersTab defaults window to "30d".
    const thirtyDay = /<button[^>]*>30d<\/button>/.exec(markup)?.[0] ?? "";
    expect(thirtyDay).toContain('aria-pressed="true"');
    const sevenDay = /<button[^>]*>7d<\/button>/.exec(markup)?.[0] ?? "";
    expect(sevenDay).toContain('aria-pressed="false"');
  });

  test("Users tab defaults to the All window", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(UsersTab, { isSignedIn: false }));
    const allWindow = /<button[^>]*>All<\/button>/.exec(markup)?.[0] ?? "";
    expect(allWindow).toContain('aria-pressed="true"');
  });

  test("exposes the Users tab's own sortBy keys: P&L / Win rate / Trades, P&L active by default", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(UsersTab, { isSignedIn: false }));

    expect(markup).toContain(">P&amp;L<");
    expect(markup).toContain(">Win rate<");
    expect(markup).toContain(">Trades<");
    const pnl = /<button[^>]*>P&amp;L<\/button>/.exec(markup)?.[0] ?? "";
    expect(pnl).toContain('aria-pressed="true"');
  });

  test("exposes the X tab's own sortBy keys: Forward return / Hit rate / Calls, Forward return active by default", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: false }));

    expect(markup).toContain(">Forward return<");
    expect(markup).toContain(">Hit rate<");
    expect(markup).toContain(">Calls<");
    const forwardReturn = /<button[^>]*>Forward return<\/button>/.exec(markup)?.[0] ?? "";
    expect(forwardReturn).toContain('aria-pressed="true"');
  });

  test("lets callers select a 1D, 3D, or 7D forward horizon", () => {
    // Assert the EXACT union, not mere assignability. `const h: XHorizon[] =
    // [1, 3, 7]` keeps compiling if the type is widened to `number`, which would
    // silently drop the regression coverage this test exists for. The helper
    // below fails to COMPILE unless XHorizon is exactly 1 | 3 | 7.
    type Exact<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    const horizonUnionIsExact: Exact<XHorizon, 1 | 3 | 7> = true;
    expect(horizonUnionIsExact).toBe(true);

    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: false }));
    expect(markup).toContain(">1D<");
    expect(markup).toContain(">3D<");
    expect(markup).toContain(">7D<");
    const oneDay = /<button[^>]*>1D<\/button>/.exec(markup)?.[0] ?? "";
    expect(oneDay).toContain('aria-pressed="true"');

    // The default and the state live in the hook, not the view: assert the
    // REAL hook's initial value directly, rather than matching its source text.
    resetTrpcFixtures();
    const hook = mountHook(() => useXCallersTab(true));
    expect(hook.horizonDays).toBe(1);
    expect(typeof hook.setHorizonDays).toBe("function");
  });

  test("uses externally controlled Callers filters as the query source of truth", () => {
    resetTrpcFixtures();
    const hook = mountHook(() =>
      useXCallersTab(true, {
        window: "7d",
        sortBy: "calls",
        horizonDays: 7,
      }),
    );

    expect(hook.window).toBe("7d");
    expect(hook.sortBy).toBe("calls");
    expect(hook.horizonDays).toBe(7);
    expect(xCallersCalls.at(-1)?.input).toEqual({
      window: "7d",
      sortBy: "calls",
      horizonDays: 7,
      limit: 25,
    });
  });

  test("uses externally controlled Users filters as the query source of truth", () => {
    resetTrpcFixtures();
    const hook = mountHook(() =>
      useUsersTab(true, { window: "30d", sortBy: "winRate" }),
    );

    expect(hook.window).toBe("30d");
    expect(hook.sortBy).toBe("winRate");
    expect(usersCalls.at(-1)?.input).toEqual({
      window: "30d",
      sortBy: "winRate",
      limit: 25,
    });
  });
});

describe("mobile leaderboard access", () => {
  test("keeps the panel's leaderboard actions visible on mobile", () => {
    resetTrpcFixtures();
    // The real panel, real markup: the Top Traders link and the Manage
    // follows trigger must stack full-width with a 44px touch target on
    // mobile, then collapse back to a compact inline row from sm: up.
    const markup = renderToStaticMarkup(
      createElement(CopyTradePanel, {
        isSignedIn: false,
        onCopy: () => {},
        onViewSymbol: () => {},
      }),
    );
    expect(markup).toContain("flex-col items-stretch");
    expect(markup).toContain("sm:flex-row");
    expect(markup).toContain("w-full items-center");
    expect(markup).toContain("flex-1 sm:flex-none");
    expect(markup).toContain("h-11 w-full");
  });

  test("Manage follows trigger gets the 44px mobile touch target, 28px on desktop", () => {
    resetTrpcFixtures();
    // No follows and no accounts, so the trigger button is the only rendered
    // control - the real component, real markup, real classes the user's
    // browser receives.
    const markup = renderToStaticMarkup(createElement(ManageFollows, { isSignedIn: false }));
    expect(markup).toContain("Manage follows");
    expect(markup).toContain("h-11");
    expect(markup).toContain("sm:h-7");
  });

  test("wraps long caller content in the rendered row", () => {
    resetTrpcFixtures();
    const html = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow({ displayName: "A".repeat(80) }),
        window: "30d",
        horizonDays: 1,
        isFollowing: false,
      }),
    );
    expect(html).toContain("break-words");
    expect(html).toContain("flex-[1_1_12rem]");
  });

  test("gives the caller profile a labelled, wrapping call history", () => {
    resetTrpcFixtures();
    xCallerProfileResult = {
      data: {
        followTarget: { type: "x_author", key: "author-1", label: "Author One" },
        displayName: "Author One",
        avatar: null,
        assetCoverage: "stocks",
        hitRate: 0.5,
        avgForwardReturnPct: 2.1,
        callCount: 1,
        measuredCallCount: 1,
        calls: [],
        dataComplete: true,
        assetCallCounts: { stocks: 0, perps: 0 },
        marketDataHealth: {
          capped: false,
          marketCap: 0,
          omittedMarketCount: 0,
          unresolvedCandidateCount: 0,
          deadlineMarketCount: 0,
          skippedMarketCount: 0,
          unavailableMarketCount: 0,
        },
      },
      isLoading: false,
      error: null,
    };
    const markup = renderToStaticMarkup(createElement(XCallerProfilePage, {}));
    expect(markup).toContain('aria-label="Caller call history"');
    expect(markup).toContain("break-words");
    // One keyboard stop per navigation action: the Button renders AS the link
    // (asChild), so the anchor must not wrap a nested button.
    expect(markup).toContain('href="/lb"');
    expect(markup).not.toMatch(/<a[^>]*href="\/lb"[^>]*>\s*<button/);
  });
});

describe("leaderboard dialog honesty copy", () => {
  test("users caption distinguishes shared realized from live Hyperliquid P&L", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(UsersTab, { isSignedIn: false }));
    expect(markup).toContain("Approximate");
    expect(markup).toContain("realized P&amp;L from shared trades");
    expect(markup).toContain("live Hyperliquid unrealized P&amp;L");
    expect(markup).not.toContain("excludes account size and open/unfilled lots");
  });

  test("x caption marks the metric as direction-adjusted ticker return, not account P&L", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: false }));
    expect(markup).toContain("Canonical stock and Hyperliquid perp calls are measured");
    expect(markup).toContain("direction-adjusted signal forward return");
    expect(markup).toContain("not the caller&#x27;s option, leverage, or account P&amp;L");
  });
});

describe("leaderboard dialog graceful degradation", () => {
  test("derives rankingFallback and partialMarketData from the query response", () => {
    resetTrpcFixtures();
    xCallersResult = {
      data: { rows: [], rankingFallback: true, partialMarketData: true, dataComplete: true },
      isLoading: false,
    };
    const hook = mountHook(() => useXCallersTab(true));
    expect(hook.rankingFallback).toBe(true);
    expect(hook.partialMarketData).toBe(true);
  });

  test("shows the ranking-fallback banner when the query reports it, and only then", () => {
    resetTrpcFixtures();
    xCallersResult = {
      data: {
        rows: [xCallerRow()],
        rankingFallback: true,
        partialMarketData: false,
        dataComplete: true,
      },
      isLoading: false,
    };
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: true }));
    expect(markup).toContain("Market data unavailable - ranked by call count only");
    expect(markup).not.toContain("Some market candidates were unavailable or intentionally omitted");
  });

  test("shows the partial-market-data banner when only some calls were measured", () => {
    resetTrpcFixtures();
    xCallersResult = {
      data: {
        rows: [xCallerRow()],
        rankingFallback: false,
        partialMarketData: true,
        dataComplete: true,
      },
      isLoading: false,
    };
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: true }));
    expect(markup).toContain("Some market candidates were unavailable or intentionally omitted");
    expect(markup).not.toContain("Market data unavailable - ranked by call count only");
  });

  test("the row card reads its own needsMarketData, independent of the top-level banner", () => {
    resetTrpcFixtures();
    // Top-level flags both false (no banner), but THIS row still needs market
    // data - the per-row reason must still show. Asserting only the hook-level
    // flags would stay green even if the row stopped reading its own flag.
    const html = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow({
          needsMarketData: true,
          avgForwardReturnPct: null,
          hitRate: null,
          measuredCallCount: 0,
        }),
        window: "30d",
        horizonDays: 1,
        isFollowing: false,
      }),
    );
    expect(html).toContain('aria-label="Market data unavailable"');
  });
});

test('shows "-" with an explanatory tooltip when metrics are null', () => {
  // Assert the component's actual OUTPUT, not the file's text. A bare
  // `toContain('"-"')` would be satisfied by unrelated `"-"` fallbacks
  // elsewhere in the source, without saying anything about UnavailableMetric.
  const reason = "No closed shared trades in this window";
  const html = renderToStaticMarkup(createElement(UnavailableMetric, { reason }));

  // The dash the reader actually sees, and the reason they can reach.
  expect(html).toContain(">-<");
  expect(html).toContain(`aria-label="${reason}"`);
  // Reachable on TOUCH as well: Radix tooltips open on hover/focus only, so
  // the trigger has to be a real focusable button, not a bare span.
  expect(html).toContain("<button");
});

describe("leaderboard dialog graceful degradation - loading and empty states", () => {
  test("X tab: sign-in prompt, loading skeletons, and the empty state, each in their own branch", () => {
    resetTrpcFixtures();
    const signedOut = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: false }));
    expect(signedOut).toContain("Sign in to see this leaderboard.");
    expect(signedOut).not.toContain('data-slot="skeleton"');

    resetTrpcFixtures();
    xCallersResult = { data: undefined, isLoading: true };
    const loading = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: true }));
    expect(loading).toContain('data-slot="skeleton"');

    resetTrpcFixtures();
    xCallersResult = {
      data: { rows: [], rankingFallback: false, partialMarketData: false, dataComplete: true },
      isLoading: false,
    };
    const empty = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: true }));
    expect(empty).toContain("No calls in this window yet.");
  });

  test("Users tab: sign-in prompt, loading skeletons, and the empty state, each in their own branch", () => {
    resetTrpcFixtures();
    const signedOut = renderToStaticMarkup(createElement(UsersTab, { isSignedIn: false }));
    expect(signedOut).toContain("Sign in to see the user leaderboard.");
    expect(signedOut).not.toContain('data-slot="skeleton"');

    resetTrpcFixtures();
    usersResult = { data: undefined, isLoading: true };
    const loading = renderToStaticMarkup(createElement(UsersTab, { isSignedIn: true }));
    expect(loading).toContain('data-slot="skeleton"');

    resetTrpcFixtures();
    usersResult = { data: { rows: [], me: null }, isLoading: false };
    const empty = renderToStaticMarkup(createElement(UsersTab, { isSignedIn: true }));
    expect(empty).toContain("No closed trades in this window yet.");
  });
});

describe("leaderboard row unavailable-metric reasons", () => {
  function reasonFor(overrides: Partial<Record<string, unknown>>, horizonDays: XHorizon = 1): string {
    const html = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow(overrides),
        window: "30d",
        horizonDays,
        isFollowing: false,
      }),
    );
    const match = /aria-label="([^"]*)"/.exec(html);
    return match?.[1] ?? "";
  }

  test("missing market data reads as Market data unavailable", () => {
    expect(
      reasonFor({
        needsMarketData: true,
        avgForwardReturnPct: null,
        hitRate: null,
        measuredCallCount: 0,
      }),
    ).toBe("Market data unavailable");
  });

  test("no directional calls reads as Direction unclear", () => {
    expect(
      reasonFor({ needsMarketData: false, directionalCallCount: 0, avgForwardReturnPct: null }),
    ).toBe("Direction unclear for these calls");
  });

  test("directional calls with no complete result yet name the horizon", () => {
    expect(
      reasonFor(
        {
          needsMarketData: false,
          directionalCallCount: 4,
          measuredCallCount: 0,
          avgForwardReturnPct: null,
          hitRate: null,
        },
        3,
      ),
    ).toBe("Waiting for a complete forward result at the 3D horizon");
  });

  test("shows the measured/total call fraction it derives from measuredCallCount", () => {
    const html = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow({ measuredCallCount: 3, callCount: 10 }),
        window: "30d",
        horizonDays: 1,
        isFollowing: false,
      }),
    );
    expect(html).toContain("10 total");
    expect(html).toContain("3 measured");
  });
});

describe("leaderboard dialog follow wiring", () => {
  test("XCallerRowCard's Follow control is wired to the row's own followTarget", () => {
    resetTrpcFixtures();
    const following = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow({ followTarget: { type: "x_author", key: "a1", label: "Author One" } }),
        window: "30d",
        horizonDays: 1,
        isFollowing: true,
      }),
    );
    expect(following).toContain('title="Unfollow Author One"');
    expect(following).toContain(">Following<");

    const notFollowing = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow({ followTarget: { type: "x_author", key: "a1", label: "Author One" } }),
        window: "30d",
        horizonDays: 1,
        isFollowing: false,
      }),
    );
    expect(notFollowing).toContain('title="Follow Author One"');
    expect(notFollowing).toContain(">Follow<");
  });

  test("UserRowCard's Follow control is wired to the row's own followTarget", () => {
    resetTrpcFixtures();
    const html = renderToStaticMarkup(
      createElement(UserRowCard, {
        rank: 2,
        row: userRow({
          followTarget: { type: "user", key: "u9", label: "Trader Nine" },
          hasHyperliquid: true,
        }),
        isFollowing: true,
      }),
    );
    expect(html).toContain('title="Unfollow Trader Nine"');
  });

  test("adds a mobile Perp trades link only to Hyperliquid user rows", () => {
    resetTrpcFixtures();
    const eligible = renderToStaticMarkup(
      createElement(UserRowCard, {
        rank: 1,
        row: userRow({
          displayName: "SOL Decoder",
          profileSlug: "SOL_Decoder",
          followTarget: { type: "user", key: "sol-wallet", label: "SOL Decoder" },
          hasHyperliquid: true,
        }),
        isFollowing: false,
      }),
    );

    expect(eligible).toMatch(
      /<a[^>]*href="\/lb\/users\/SOL_Decoder\?t=fills"[^>]*>Perp trades<\/a>/,
    );
    expect(eligible).toContain("sm:hidden");
    expect(eligible).toContain('href="/lb/users/SOL_Decoder"');
    expect(eligible).toContain('title="Follow SOL Decoder"');

    const stockOnly = renderToStaticMarkup(
      createElement(UserRowCard, {
        rank: 2,
        row: userRow({
          profileSlug: "Stock_Only",
          hasHyperliquid: false,
        }),
        isFollowing: false,
      }),
    );
    expect(stockOnly).not.toContain("Perp trades");
    expect(stockOnly).not.toContain('title="Follow Trader One"');
    expect(stockOnly).toContain('href="/lb/users/Stock_Only"');
  });

  test("shows both venue P&L lines when Hyperliquid is connected at zero P&L", () => {
    resetTrpcFixtures();
    const html = renderToStaticMarkup(
      createElement(UserRowCard, {
        rank: 1,
        row: userRow({
          realizedPnl: 0,
          alpacaPnl: 0,
          hyperliquidPnl: 0,
          hasHyperliquid: true,
        }),
        isFollowing: false,
      }),
    );

    expect(html).toContain("Stocks $0.00");
    expect(html).toContain("HL $0.00");
  });

  test("keeps the Stocks breakdown for a stock-only trader with realized P&L", () => {
    resetTrpcFixtures();
    const html = renderToStaticMarkup(
      createElement(UserRowCard, {
        rank: 1,
        row: userRow({
          realizedPnl: 87.55,
          alpacaPnl: 87.55,
          hyperliquidPnl: 0,
          hasHyperliquid: false,
        }),
        isFollowing: false,
      }),
    );

    expect(html).toContain("Stocks +$87.55");
    expect(html).not.toContain("HL $0.00");
  });

  test("useFollowedKeys derives the followed set keyed type|key from copyTradeFollows.list", () => {
    resetTrpcFixtures();
    followsResult = {
      data: [{ targetType: "user", targetKey: "trader-1" }],
      isLoading: false,
      error: null,
    };
    const keys = mountHook(() => useFollowedKeys(true));
    expect(keys.has("user|trader-1")).toBe(true);
    expect(keys.has("x_author|trader-1")).toBe(false);
  });

  test("a row whose followTarget key matches the follows list renders as Following, end to end", () => {
    resetTrpcFixtures();
    xCallersResult = {
      data: {
        rows: [xCallerRow({ followTarget: { type: "x_author", key: "author-1", label: "Author One" } })],
        rankingFallback: false,
        partialMarketData: false,
        dataComplete: true,
      },
      isLoading: false,
    };
    followsResult = {
      data: [{ targetType: "x_author", targetKey: "author-1" }],
      isLoading: false,
      error: null,
    };
    const markup = renderToStaticMarkup(createElement(XCallersTab, { isSignedIn: true }));
    expect(markup).toContain('title="Unfollow Author One"');
  });
});

describe("copy-trade panel links to the leaderboard page", () => {
  test("the panel header links to the /lb page", () => {
    resetTrpcFixtures();
    const markup = renderToStaticMarkup(
      createElement(CopyTradePanel, {
        isSignedIn: false,
        onCopy: () => {},
        onViewSymbol: () => {},
      }),
    );
    expect(markup).toContain('href="/lb"');
    expect(markup).toContain("Top Traders");
  });
});

describe("caller profile", () => {
  test("links caller names with only the meaningful non-default measurement params", () => {
    resetTrpcFixtures();
    const html = renderToStaticMarkup(
      createElement(XCallerRowCard, {
        rank: 1,
        row: xCallerRow({ followTarget: { type: "x_author", key: "shar di", label: "Shardi" } }),
        window: "7d",
        horizonDays: 3,
        isFollowing: false,
      }),
    );
    expect(html).toContain(
      `href="/lb/x/${encodeURIComponent("shar di")}?w=7d&amp;h=3"`,
    );
    expect(html).toContain("call history");
  });

  test("keeps X and Discord author keys on the existing profile route", () => {
    for (const key of ["source_author:x:42", "source_author:discord:42"]) {
      expect(
        buildCallerProfileHref({ key }, "30d", 7),
      ).toEqual({
        pathname: "/lb/x/" + encodeURIComponent(key),
        query: { h: "7" },
      });
    }
  });

  test("links user profiles by readable slug without default filter or tab noise", () => {
    expect(
      buildUserProfileHref({
        profileSlug: "SOL_Decoder",
        followTarget: { key: "test-target-key" },
      }),
    ).toEqual({
      pathname: "/lb/users/SOL_Decoder",
    });
  });

  test("falls back to the follow key when a cached row carries no slug", () => {
    expect(
      buildUserProfileHref({
        profileSlug: "",
        followTarget: { key: "trader key" },
      }),
    ).toEqual({
      pathname: "/lb/users/trader%20key",
    });
  });

  test("loads the exact calls and explains measured versus excluded results", () => {
    resetTrpcFixtures();
    xCallerProfileResult = {
      data: {
        followTarget: { type: "x_author", key: "author-1", label: "Author One" },
        displayName: "Author One",
        avatar: null,
        assetCoverage: "stocks",
        hitRate: 0.5,
        avgForwardReturnPct: 2.1,
        callCount: 2,
        measuredCallCount: 1,
        calls: [
          {
            id: "call-1",
            symbol: "AAPL",
            content: "Buying the dip",
            url: "https://x.com/example/status/1",
            source: "x",
            calledAt: "2026-01-01T12:00:00.000Z",
            direction: "bullish",
            measurementStatus: "measured",
            forwardReturnPct: 3.4,
          },
          {
            id: "call-2",
            symbol: "TSLA",
            content: "Direction unclear here",
            url: null,
            source: "x",
            calledAt: "2026-01-02T12:00:00.000Z",
            direction: "unknown",
            measurementStatus: "direction_unknown",
            forwardReturnPct: null,
          },
        ],
        assetCallCounts: { stocks: 0, perps: 0 },
        marketDataHealth: {
          capped: false,
          marketCap: 0,
          omittedMarketCount: 0,
          unresolvedCandidateCount: 0,
          deadlineMarketCount: 0,
          skippedMarketCount: 0,
          unavailableMarketCount: 0,
        },
      },
      isLoading: false,
      error: null,
    };
    followsResult = { data: [], isLoading: false, error: null };

    const markup = renderToStaticMarkup(createElement(XCallerProfilePage, {}));
    expect(markup).toContain("Calls behind this score");
    expect(markup).toContain("Buying the dip");
    // formatCalledAt renders "Jan 1, 2026" (en-US month/day/year/hour/minute).
    expect(markup).toContain("Jan 1, 2026");
    expect(markup).toContain("3.4");
    expect(markup).toContain("Direction unclear");
    expect(markup).toContain("View source");
  });

  test("horizon-incomplete calls are labelled Horizon incomplete", () => {
    resetTrpcFixtures();
    xCallerProfileResult = {
      data: {
        followTarget: { type: "x_author", key: "author-1", label: "Author One" },
        displayName: "Author One",
        avatar: null,
        assetCoverage: "stocks",
        hitRate: null,
        avgForwardReturnPct: null,
        callCount: 1,
        measuredCallCount: 0,
        calls: [
          {
            id: "call-3",
            symbol: "MSFT",
            content: "Too soon to score",
            url: null,
            source: "x",
            calledAt: "2026-01-03T12:00:00.000Z",
            direction: "bullish",
            measurementStatus: "horizon_incomplete",
            forwardReturnPct: null,
          },
        ],
        assetCallCounts: { stocks: 0, perps: 0 },
        marketDataHealth: {
          capped: false,
          marketCap: 0,
          omittedMarketCount: 0,
          unresolvedCandidateCount: 0,
          deadlineMarketCount: 0,
          skippedMarketCount: 0,
          unavailableMarketCount: 0,
        },
      },
      isLoading: false,
      error: null,
    };
    followsResult = { data: [], isLoading: false, error: null };

    const markup = renderToStaticMarkup(createElement(XCallerProfilePage, {}));
    expect(markup).toContain("Horizon incomplete");
  });

  test("uses the already-decoded App Router author key directly, without re-decoding it", () => {
    resetTrpcFixtures();
    xCallerProfileResult = { data: undefined, isLoading: true, error: null };
    followsResult = { data: [], isLoading: false, error: null };

    renderToStaticMarkup(createElement(XCallerProfilePage, {}));

    // next/navigation is mocked (module-wide, above) to hand back
    // MOCK_AUTHOR_KEY = "author%20one". A second decodeURIComponent would
    // silently turn that into "author one" before it reached the query - the
    // exact bug this test exists to catch. Assert on what the page actually
    // sent to the query, not on its source text.
    expect(xCallerProfileCalls.length).toBe(1);
    expect(xCallerProfileCalls[0]!.input.authorKey).toBe(MOCK_AUTHOR_KEY);
    expect(xCallerProfileCalls[0]!.input.authorKey).not.toBe("author one");
  });
});

describe("caller asset coverage", () => {
  test("labels callers as Stocks, Perps, or Both from API coverage", () => {
    expect(assetCoveragePresentation("stocks")).toEqual({
      label: "Stocks",
      title: "Calls in this window: Stocks",
      className: undefined,
    });
    expect(assetCoveragePresentation("perps")).toEqual({
      label: "Perps",
      title: "Calls in this window: Perps",
      className: "border-primary/40 text-primary",
    });
    expect(assetCoveragePresentation("both")).toEqual({
      label: "Both",
      title: "Calls in this window: Both",
      className: "border-amber-500/40 text-amber-500",
    });
  });

  test("labels individual profile calls with their server asset class", () => {
    expect(assetClassPresentation("stocks")).toMatchObject({ label: "Stocks" });
    expect(assetClassPresentation("perps")).toMatchObject({ label: "Perps" });
  });
});
