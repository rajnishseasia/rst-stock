import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { elementText, flattenElements, type TestElement } from "@/testing/element-tree";
import { toAccountOptions } from "./account-targeting";
import { UNFOLLOW_TOAST, type FollowArmedLookupRow } from "./mirror-consent";
import type { FollowTarget } from "./follow-button";
import type { FollowItem } from "./use-manage-follows";
import type { MirrorLimits } from "./mirror-consent";

/**
 * This file used to assert on follow-button.tsx, manage-follows.tsx and
 * use-manage-follows.ts by readFileSync-ing their source and regexing it,
 * which CLAUDE.md forbids: a passing test proved a string existed somewhere in
 * the file, never that the behaviour it described actually happened. Every
 * assertion below now imports the real modules and either calls a hook-free
 * component directly (FollowButtonView, FollowRow, ManageFollowsBody) or mounts
 * a hook-bearing one (FollowButton, ManageFollows, useManageFollows) through a
 * tiny harness that calls it as a real function inside a React render pass, so
 * its hooks run against a mocked "@/lib/trpc" and its real return value (an
 * unrendered element tree, or the hook's own return object) is captured for
 * inspection. Nothing is rendered to markup and re-parsed: DropdownMenuContent
 * portals via Radix and would throw under renderToStaticMarkup, which is
 * exactly why ManageFollows is captured this way instead.
 *
 * The former "copy-trade panel following view" describe block is gone
 * entirely, not converted: it read copy-trade-panel.tsx, a file this test does
 * not own, and every behaviour it pinned is already covered behaviourally
 * elsewhere. See the comment where that block used to live, below.
 */

// ============================================================================
// Shared "@/lib/trpc" / "sonner" mocks
//
// One mock covers follow-button.tsx, manage-follows.tsx and
// use-manage-follows.ts, since all three are exercised in this file and all
// three ultimately call the same handful of trpc leaves. Each test reassigns
// the mutable query fixtures it needs and calls resetSpies() first; bun runs
// this file's tests sequentially, so a test's own mount-then-assert always
// reads back what that same test just set.
// ============================================================================

type MutationOptions<TVars> = {
  onSuccess?: (data: unknown, variables: TVars) => void;
  onError?: (error: { message: string }) => void;
};

const toastCalls: { success: string[]; error: string[] } = { success: [], error: [] };
mock.module("sonner", () => ({
  toast: {
    success: (message: string) => toastCalls.success.push(message),
    error: (message: string) => toastCalls.error.push(message),
  },
}));

const invalidateCalls: string[] = [];
const followMutateCalls: unknown[] = [];
const unfollowMutateCalls: unknown[] = [];
const updateMutateCalls: unknown[] = [];

let capturedFollowOptions: MutationOptions<{
  targetType: string;
  targetKey: string;
  targetLabel: string;
}> | null = null;
let capturedUnfollowOptions: MutationOptions<{
  targetType: string;
  targetKey: string;
}> | null = null;
let capturedUpdateOptions: MutationOptions<Record<string, unknown>> | null = null;

/** Backs `trpcUtils.copyTradeFollows.list.getData()`, read by FollowButton for armed-state. */
let LIST_DATA_FOR_ARMED_STATE: FollowArmedLookupRow[] = [];

/** Backs `trpc.copyTradeFollows.list.useQuery()`, read by useManageFollows. */
let FOLLOWS_QUERY: {
  data: FollowItem[] | undefined;
  error: { message: string } | null;
  isLoading: boolean;
} = { data: [], error: null, isLoading: false };

/** Backs `userSettings.getCopyPerpLeverageSettings`, read by useManageFollows. */
let GLOBAL_LEVERAGE_QUERY: {
  data: { globalPerpMaxLeverage: number } | undefined;
  error: { message: string } | null;
  isLoading: boolean;
} = { data: { globalPerpMaxLeverage: 2 }, error: null, isLoading: false };

/** Backs the complete-page credentials hook read by useManageFollows. */
let ACCOUNTS_QUERY: {
  accounts: Array<{
    id: string;
    provider: string;
    accountId: string | null;
    accountType: string | null;
  }>;
  isLoading: boolean;
} = { accounts: [], isLoading: false };

function resetSpies(): void {
  toastCalls.success.length = 0;
  toastCalls.error.length = 0;
  invalidateCalls.length = 0;
  followMutateCalls.length = 0;
  unfollowMutateCalls.length = 0;
  updateMutateCalls.length = 0;
}

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      copyTradeFollows: {
        list: {
          invalidate: () => invalidateCalls.push("copyTradeFollows.list"),
          getData: () => LIST_DATA_FOR_ARMED_STATE,
        },
      },
      copyTrade: {
        feed: { invalidate: () => invalidateCalls.push("copyTrade.feed") },
      },
      leaderboard: {
        xCallers: { invalidate: () => invalidateCalls.push("leaderboard.xCallers") },
        users: { invalidate: () => invalidateCalls.push("leaderboard.users") },
        // The caller profile board reads the same follow state, so a follow or
        // unfollow has to invalidate it too.
        xCallerProfile: {
          invalidate: () => invalidateCalls.push("leaderboard.xCallerProfile"),
        },
      },
    }),
    copyTradeFollows: {
      follow: {
        useMutation: (
          options: MutationOptions<{ targetType: string; targetKey: string; targetLabel: string }>,
        ) => {
          capturedFollowOptions = options;
          return { mutate: (args: unknown) => followMutateCalls.push(args), isPending: false };
        },
      },
      unfollow: {
        useMutation: (options: MutationOptions<{ targetType: string; targetKey: string }>) => {
          capturedUnfollowOptions = options;
          return { mutate: (args: unknown) => unfollowMutateCalls.push(args), isPending: false };
        },
      },
      update: {
        useMutation: (options: MutationOptions<Record<string, unknown>>) => {
          capturedUpdateOptions = options;
          return { mutate: (args: unknown) => updateMutateCalls.push(args), isPending: false };
        },
      },
      list: {
        useQuery: () => ({
          data: FOLLOWS_QUERY.data,
          error: FOLLOWS_QUERY.error,
          isLoading: FOLLOWS_QUERY.isLoading,
        }),
      },
    },
    userSettings: {
      hasApiCredentials: {
        useInfiniteQuery: () => ({
          data: { pages: [{
            accounts: ACCOUNTS_QUERY.accounts,
            hasCredentials: ACCOUNTS_QUERY.accounts.length > 0,
            isComplete: true,
            nextCursor: null,
          }] },
          hasNextPage: false,
          isFetching: false,
          isLoading: ACCOUNTS_QUERY.isLoading,
          isSuccess: !ACCOUNTS_QUERY.isLoading,
          isError: false,
          error: null,
          fetchNextPage: async () => undefined,
          refetch: async () => undefined,
        }),
      },
      getCopyPerpLeverageSettings: {
        useQuery: () => GLOBAL_LEVERAGE_QUERY,
      },
    },
    copyTrade: {
      mirrorStatus: { useQuery: () => ({ data: null }) },
    },
  },
}));

const { FollowButton, FollowButtonView } = await import("./follow-button");
const { ManageFollows, ManageFollowsBody, FollowRow } = await import("./manage-follows");
const { useManageFollows } = await import("./use-manage-follows");

// ============================================================================
// Local harness: call a hook-bearing function as a real function inside a
// React render pass, and capture what it returns (an element tree, or a
// hook's own return object) without letting React actually render that
// result. That is what keeps a Radix Portal (DropdownMenuContent, inside
// ManageFollows) from ever being reached: the harness component itself
// returns null, so React never attempts to mount the captured tree.
// ============================================================================

function captureCall<P extends object, R>(fn: (props: P) => R, props: P): R {
  let captured: R | undefined;
  function Harness(harnessProps: P): null {
    captured = fn(harnessProps);
    return null;
  }
  renderToStaticMarkup(createElement(Harness, props));
  return captured as R;
}

function findByComponent(node: unknown, component: unknown): TestElement | undefined {
  return flattenElements(node as never).find((element) => element.type === component);
}

const TARGET: FollowTarget = { type: "user", key: "trader-key", label: "Example Trader" };

const TYPED_DESTINATIONS = {
  stock: {
    enabled: false,
    credentialId: null,
    sizingMode: "pct",
    sizingValue: 5,
  },
  perp: {
    enabled: false,
    credentialId: null,
    sizingMode: "pct",
    sizingValue: 5,
  },
} as const;

function mountFollowButton(isFollowing: boolean): TestElement {
  return captureCall(FollowButton, { target: TARGET, isFollowing }) as TestElement;
}

describe("copy-trade follow button wiring", () => {
  test("clicking Follow calls copyTradeFollows.follow with the item's followTarget (type/key/label)", () => {
    resetSpies();
    const view = mountFollowButton(false);

    (view.props.onFollow as () => void)();

    expect(followMutateCalls).toEqual([
      { targetType: "user", targetKey: "trader-key", targetLabel: "Example Trader" },
    ]);
  });

  test("clicking Following calls copyTradeFollows.unfollow with the item's targetType/targetKey", () => {
    resetSpies();
    const view = mountFollowButton(true);

    (view.props.onUnfollow as () => void)();

    expect(unfollowMutateCalls).toEqual([{ targetType: "user", targetKey: "trader-key" }]);
  });

  test("reflects followed-state with a filled (default) button when following, outline otherwise", () => {
    const following = FollowButtonView({
      target: TARGET,
      isFollowing: true,
      armed: "unarmed",
      confirmingUnfollow: false,
      onConfirmingUnfollowChange: () => {},
      onFollow: () => {},
      onUnfollow: () => {},
    });
    const notFollowing = FollowButtonView({
      target: TARGET,
      isFollowing: false,
      armed: "unarmed",
      confirmingUnfollow: false,
      onConfirmingUnfollowChange: () => {},
      onFollow: () => {},
      onUnfollow: () => {},
    });

    const followingButton = findByComponent(following, Button);
    const notFollowingButton = findByComponent(notFollowing, Button);

    expect(followingButton?.props.variant).toBe("default");
    expect(elementText(following)).toBe("Following");
    expect(notFollowingButton?.props.variant).toBe("outline");
    expect(elementText(notFollowing)).toBe("Follow");
  });

  test("invalidates the follows list, feed, and leaderboard follow-state after a follow or unfollow mutation succeeds", () => {
    resetSpies();
    mountFollowButton(false);
    capturedFollowOptions!.onSuccess?.(undefined, {
      targetType: "user",
      targetKey: "trader-key",
      targetLabel: "Example Trader",
    });

    expect(invalidateCalls).toContain("copyTradeFollows.list");
    expect(invalidateCalls).toContain("copyTrade.feed");
    expect(invalidateCalls).toContain("leaderboard.xCallers");
    expect(invalidateCalls).toContain("leaderboard.users");
    expect(invalidateCalls).toContain("leaderboard.xCallerProfile");

    resetSpies();
    mountFollowButton(true);
    capturedUnfollowOptions!.onSuccess?.(undefined, { targetType: "user", targetKey: "trader-key" });

    expect(invalidateCalls).toContain("copyTradeFollows.list");
    expect(invalidateCalls).toContain("copyTrade.feed");
    expect(invalidateCalls).toContain("leaderboard.xCallers");
    expect(invalidateCalls).toContain("leaderboard.users");
    expect(invalidateCalls).toContain("leaderboard.xCallerProfile");
  });

  test("shows success and failure toast feedback for follow and unfollow", () => {
    resetSpies();
    mountFollowButton(false);
    capturedFollowOptions!.onSuccess?.(undefined, {
      targetType: "user",
      targetKey: "trader-key",
      targetLabel: "Example Trader",
    });
    expect(toastCalls.success).toContain("Followed Example Trader");
    capturedFollowOptions!.onError?.({ message: "" });
    expect(toastCalls.error).toContain("Could not follow");

    resetSpies();
    mountFollowButton(true);
    capturedUnfollowOptions!.onSuccess?.(undefined, { targetType: "user", targetKey: "trader-key" });
    expect(toastCalls.success).toContain(UNFOLLOW_TOAST);
    capturedUnfollowOptions!.onError?.({ message: "server exploded" });
    expect(toastCalls.error).toContain("server exploded");
  });

  test("passes typed destination state from the cached follows list to the real button", () => {
    // Proves the actual FollowButton keeps the independent destination fields
    // from the list cache instead of reducing the row to autoMirror first.
    LIST_DATA_FOR_ARMED_STATE = [
      {
        targetType: "user",
        targetKey: "trader-key",
        autoMirror: false,
        destinations: {
          stock: {
            ...TYPED_DESTINATIONS.stock,
            enabled: true,
            credentialId: "stock-credential",
          },
          perp: {
            ...TYPED_DESTINATIONS.perp,
            enabled: true,
            credentialId: "perp-credential",
          },
        },
      },
    ];
    const dualArmedView = mountFollowButton(true);
    expect(dualArmedView.props.armed).toBe("armed");

    LIST_DATA_FOR_ARMED_STATE = [
      {
        targetType: "user",
        targetKey: "trader-key",
        autoMirror: true,
        destinations: TYPED_DESTINATIONS,
      },
    ];
    const typedOffView = mountFollowButton(true);
    expect(typedOffView.props.armed).toBe("unarmed");

    LIST_DATA_FOR_ARMED_STATE = [];
    // An unloaded cache cannot prove that the row is harmless.
    const unknownView = mountFollowButton(true);
    expect(unknownView.props.armed).toBe("unknown");

    // Keep subsequent tests independent of the mutable cache fixture.
    LIST_DATA_FOR_ARMED_STATE = [];
  });

  test("still falls back to the legacy flag for an old-shaped row", () => {
    LIST_DATA_FOR_ARMED_STATE = [{ targetType: "user", targetKey: "trader-key", autoMirror: true }];
    const view = mountFollowButton(true);
    expect(view.props.armed).toBe("armed");

    LIST_DATA_FOR_ARMED_STATE = [];
    const unknownView = mountFollowButton(true);
    expect(unknownView.props.armed).toBe("unknown");
  });
});

// ============================================================================
// manage-follows.tsx and use-manage-follows.ts
// ============================================================================

const BASE_FOLLOW: FollowItem = {
  id: "follow-1",
  targetType: "user",
  targetKey: "trader-key",
  targetLabel: "Example Trader",
  sizingMode: "pct",
  sizingValue: 5,
  maxTradeSize: null,
  maxCoinSize: null,
  autoMirror: false,
  credentialId: null,
  credentialAccountLabel: null,
  credentialAccountType: null,
  credentialProvider: null,
  perpTakeProfitPct: null,
  perpStopLossPct: null,
  perpMaxLeverage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function mountUseManageFollows(isSignedIn = true) {
  return captureCall(
    (props: { isSignedIn: boolean }) => useManageFollows(props.isSignedIn),
    { isSignedIn },
  );
}

describe("manage-follows surface", () => {
  test("ManageFollows renders the hook's real follows through ManageFollowsBody, and wires its onUpdate to the real update mutation", () => {
    // Replaces "the surface actually CALLS the extracted hook", which used to
    // assert only that the strings `from "./use-manage-follows"` and
    // `useManageFollows(` appeared in the file. This mounts ManageFollows for
    // real (hooks and all, against the mocked trpc above) and reads the props
    // it actually handed to ManageFollowsBody and to the FollowRow its
    // renderRow constructs, which fails the moment either wiring is dropped.
    resetSpies();
    FOLLOWS_QUERY = { data: [BASE_FOLLOW], error: null, isLoading: false };
    ACCOUNTS_QUERY = {
      accounts: [{ id: "live-cred", provider: "alpaca", accountId: "LIVE-1", accountType: "LIVE" }],
      isLoading: false,
    };

    const tree = captureCall(ManageFollows, { isSignedIn: true });
    const body = findByComponent(tree, ManageFollowsBody);
    expect(body).toBeDefined();
    expect(body!.props.follows).toEqual([BASE_FOLLOW]);
    expect(body!.props.followsLoading).toBe(false);
    expect(body!.props.followsError).toBeNull();

    const row = (body!.props.renderRow as (f: FollowItem) => TestElement)(BASE_FOLLOW);
    expect(row.type).toBe(FollowRow);
    expect(row.props.accounts).toEqual(toAccountOptions(ACCOUNTS_QUERY.accounts));

    (row.props.onUpdate as (patch: Record<string, unknown>) => void)({ autoMirror: true });
    expect(updateMutateCalls).toEqual([
      { targetType: BASE_FOLLOW.targetType, targetKey: BASE_FOLLOW.targetKey, autoMirror: true },
    ]);
  });

  test("renders the current global copy leverage and links to its single settings editor", () => {
    const body = ManageFollowsBody({
      followsLoading: false,
      followsError: null,
      follows: [],
      globalPerpMaxLeverage: 2,
      globalLeverageLoading: false,
      globalLeverageError: null,
      renderRow: () => null,
    });

    const html = renderToStaticMarkup(body);
    expect(html).toContain("Copy-trading maximum leverage");
    expect(html).toContain("2x");
    expect(html).toContain('href="/settings?t=copy-trading"');
    expect(html).toContain("Change");
    expect(html).toContain('aria-label="Change copy-trading leverage setting"');
  });

  test("passes the global cap to each row and lets a row save a stricter perp cap", () => {
    resetSpies();
    FOLLOWS_QUERY = { data: [BASE_FOLLOW], error: null, isLoading: false };
    GLOBAL_LEVERAGE_QUERY = { data: { globalPerpMaxLeverage: 2 }, error: null, isLoading: false };

    const tree = captureCall(ManageFollows, { isSignedIn: true });
    const body = findByComponent(tree, ManageFollowsBody);
    expect(body?.props.globalPerpMaxLeverage).toBe(2);

    const row = (body!.props.renderRow as (f: FollowItem) => TestElement)(BASE_FOLLOW);
    expect(row.props.globalPerpMaxLeverage).toBe(2);
    (row.props.onUpdate as (patch: Record<string, unknown>) => void)({ perpMaxLeverage: 1 });
    expect(updateMutateCalls).toEqual([
      { targetType: BASE_FOLLOW.targetType, targetKey: BASE_FOLLOW.targetKey, perpMaxLeverage: 1 },
    ]);
  });

  test("keeps the saved follow cap visible to the row after an API error", () => {
    const follow = { ...BASE_FOLLOW, perpMaxLeverage: 1 };
    FOLLOWS_QUERY = { data: [follow], error: null, isLoading: false };
    const tree = captureCall(ManageFollows, { isSignedIn: true });
    const body = findByComponent(tree, ManageFollowsBody);
    const row = (body!.props.renderRow as (f: FollowItem) => TestElement)(follow);
    const renderedRow = FollowRow(row.props as Parameters<typeof FollowRow>[0]);
    const select = flattenElements(renderedRow).filter((element) => element.type === Select)[1];
    expect(select?.props.value).toBe("1");

    capturedUpdateOptions!.onError?.({ message: "cap rejected" });
    expect(toastCalls.error).toContain("cap rejected");
    expect(select?.props.value).toBe("1");
  });

  test("lists the user's follows from the list query, and onUpdate/onUnfollow call the real mutations with the follow's identity", () => {
    resetSpies();
    FOLLOWS_QUERY = { data: [BASE_FOLLOW], error: null, isLoading: false };

    const state = mountUseManageFollows();
    expect(state.follows).toEqual([BASE_FOLLOW]);

    state.onUpdate(BASE_FOLLOW, { autoMirror: true });
    expect(updateMutateCalls).toEqual([
      { targetType: "user", targetKey: "trader-key", autoMirror: true },
    ]);

    state.onUnfollow(BASE_FOLLOW);
    expect(unfollowMutateCalls).toEqual([{ targetType: "user", targetKey: "trader-key" }]);
  });

  // "auto-mirror toggle updates autoMirror via .update" used to assert the
  // literal `buildAutoMirrorPatch(checked, follow.credentialId)` out of the
  // switch's change handler. That handler no longer mutates at all: arming goes
  // through a confirmation. Replaced by behavioural tests in
  // mirror-consent.test.tsx ("arming is gated on a confirmation"), which invoke
  // the real handler and assert no update is issued until the dialog's own
  // confirm control is clicked.

  test("resolves accounts from userSettings.hasApiCredentials via the shared toAccountOptions mapping", () => {
    resetSpies();
    const raw = [
      { id: "paper-cred", provider: "alpaca", accountId: "PA-1", accountType: "PAPER" },
      // Neither an unsupported provider nor a legacy row with no accountType is
      // a destination a follow can be pointed at; toAccountOptions drops both.
      { id: "bad-provider", provider: "coinbase", accountId: "X", accountType: "PAPER" },
      { id: "no-account-type", provider: "alpaca", accountId: "Y", accountType: null },
    ];
    ACCOUNTS_QUERY = { accounts: raw, isLoading: false };

    const state = mountUseManageFollows();

    expect(state.accounts).toEqual(toAccountOptions(raw));
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]!.id).toBe("paper-cred");
  });

  // The third assertion here matched the account picker's handler as a source
  // string, `credentialId: value === "none" ? null : value`. That handler is no
  // longer a one-liner: re-pointing an ARMED follow now raises a consent request
  // instead of mutating, because the API keeps auto-mirror on for any non-null
  // credential. A string match could not tell those two cases apart, which is
  // the whole point of the change. Replaced by behavioural tests in
  // mirror-consent.test.tsx ("moving an armed follow to another account is
  // confirmed first"), which invoke the real `onValueChange` and assert both the
  // patch it emits and the request it raises instead. The account options
  // themselves are asserted there too, from the rendered row.

  test("describes the worker cap as an absolute per-order ceiling, never as auto-scaling", () => {
    const follow: FollowItem = { ...BASE_FOLLOW, sizingMode: "usd", sizingValue: 5000 };
    const limits: MirrorLimits = {
      dailyCap: 20,
      maxOrderDollars: 1_000,
      dailyCapFromDefaults: false,
      maxOrderDollarsFromDefaults: false,
    };
    const tree = FollowRow({
      follow,
      accounts: [],
      accountsLoading: false,
      buyingPower: 10_000,
      equity: 10_000,
      balancesCredentialId: follow.credentialId,
      limits,
      globalPerpMaxLeverage: 2,
      deploymentBlockReason: null,
      valueDraft: String(follow.sizingValue),
      onValueDraftChange: () => {},
      maxTradeSizeDraft: "",
      onMaxTradeSizeDraftChange: () => {},
      maxCoinSizeDraft: "",
      onMaxCoinSizeDraftChange: () => {},
      protectionDraft: { stopLoss: "", takeProfit: "" },
      onProtectionDraftChange: () => {},
      onUpdate: () => {},
      onRequestConsent: () => {},
      disabled: false,
    });

    const text = elementText(tree);
    expect(text).toContain("About $5,000.00 per order. Above the $1,000.00 absolute");
    expect(text).toContain("the worker will skip it");
    expect(text).not.toContain("cap auto-scales");
  });

  // "auto-mirror toggle shows the off-by-default real-orders caption" was only
  // ever satisfied by a comment in the file header, which is exactly the false
  // confidence CLAUDE.md warns about. The caption is now asserted where it is
  // rendered, in mirror-consent.test.tsx ("a usable switch keeps the
  // off-by-default real-orders caption").

  // "sizing override updates mode + value via .update" matched
  // `onUpdate({ sizingMode:` and `onUpdate({ sizingValue: next })` as literal
  // source. Both calls are now pinned behaviourally in mirror-consent.test.tsx
  // ("changing the sizing basis cannot resize a follow on its own": "the staged
  // basis reaches the API only with the number typed for it" invokes the real
  // row and asserts the exact `{ sizingMode, sizingValue }` patch it emits, and
  // "a value edit under an unchanged basis still saves on its own" does the
  // same for a plain `{ sizingValue }` edit).

  test("invalidates the follows list, feed, and leaderboard follow-state after update/unfollow mutations succeed", () => {
    // use-manage-follows.test.tsx already exercises this invalidate() call from
    // the update mutation's null-response branch; this closes the loop on the
    // ordinary (non-null) response and on the unfollow mutation, which that
    // file does not touch.
    resetSpies();
    mountUseManageFollows();
    capturedUpdateOptions!.onSuccess?.({ id: "row-1" }, { autoMirror: true });
    expect(invalidateCalls).toContain("copyTradeFollows.list");
    expect(invalidateCalls).toContain("copyTrade.feed");
    expect(invalidateCalls).toContain("leaderboard.xCallers");
    expect(invalidateCalls).toContain("leaderboard.users");

    resetSpies();
    mountUseManageFollows();
    capturedUnfollowOptions!.onSuccess?.(undefined, { targetType: "user", targetKey: "trader-key" });
    expect(invalidateCalls).toContain("copyTradeFollows.list");
    expect(invalidateCalls).toContain("copyTrade.feed");
    expect(invalidateCalls).toContain("leaderboard.xCallers");
    expect(invalidateCalls).toContain("leaderboard.users");
  });

  test("surfaces the list query's error on the hook, and ManageFollowsBody paints it instead of a silent empty state", () => {
    resetSpies();
    FOLLOWS_QUERY = { data: undefined, error: { message: "network down" }, isLoading: false };

    const state = mountUseManageFollows();
    expect(state.follows).toEqual([]);
    expect(state.followsError).toEqual({ message: "network down" });

    const body = ManageFollowsBody({
      followsLoading: false,
      followsError: state.followsError,
      follows: [],
      renderRow: () => null,
    });
    const text = elementText(body);
    expect(text).toContain("Could not load follows");
    expect(text).toContain("network down");
  });

  test("update onError and unfollow onSuccess/onError show the right toast", () => {
    // The armed/disarm/null-response update-success toasts are covered in
    // use-manage-follows.test.tsx already; this closes the remaining gaps
    // (update's onError, and the unfollow mutation's own toasts) that no
    // existing behavioural test touches.
    resetSpies();
    mountUseManageFollows();
    capturedUpdateOptions!.onError?.({ message: "" });
    expect(toastCalls.error).toContain("Could not update follow");

    resetSpies();
    mountUseManageFollows();
    capturedUnfollowOptions!.onSuccess?.(undefined, { targetType: "user", targetKey: "trader-key" });
    expect(toastCalls.success).toContain(UNFOLLOW_TOAST);

    resetSpies();
    mountUseManageFollows();
    capturedUnfollowOptions!.onError?.({ message: "server exploded" });
    expect(toastCalls.error).toContain("server exploded");
  });

  // "allows auto-mirror for user and x_author follows" and "keeps politician
  // auto-mirror disabled with a coming soon caption" both matched source
  // fragments of the switch that FollowRow no longer contains inline. Replaced
  // by mirror-consent.test.tsx, "auto-mirror is offered only where the worker
  // supports it", which renders the row and reads the switch it mounted.
});

// ============================================================================
// The former "copy-trade panel following view" describe block read
// copy-trade-panel.tsx, a file this test does not own, and every behaviour it
// pinned is already covered behaviourally elsewhere:
//
//   - source filter and its localStorage round trip, including "following":
//     parseStoredSourceFilter and the SOURCES_KEY assertions in
//     copy-trade-panel.test.ts ("copy-trade panel persistence")
//   - followedOnly reaching the feed query: the query-arg spy in
//     copy-trade-panel.test.ts ("copy-trade panel data wiring (full render)")
//   - armingDestination and the Paper/Live chip it feeds: account-targeting.test.ts
//     ("inline mirror switch arming destination")
//   - InlineMirrorSwitch and its accessible name: mirror-consent.test.tsx
//     ("arming is gated on a confirmation" / "6c. Re-pointing an armed follow
//     is a consent decision")
//   - FollowButton, FollowRow and ManageFollows themselves: behaviourally, in
//     this file, above
//
// Its "persists the source filter" test was failing on this branch because the
// panel refactor moved the string it grepped for (`raw === "following"`) to
// copy-trade-persistence.ts's parseStoredSourceFilter, which is exactly the
// brittleness this whole conversion removes: the property (a stored
// `"following"` value round-trips) never broke, only the source-text match did.
// ============================================================================
