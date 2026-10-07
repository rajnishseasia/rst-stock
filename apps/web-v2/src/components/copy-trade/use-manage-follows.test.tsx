/**
 * `copyTradeFollows.update` resolves successfully with `null` when the row it
 * looked up is gone (`apps/api/src/routers/copy-trade-follows.ts`: `if
 * (!current) return null;`, and again if the UPDATE itself matches no row).
 * That happens for real: `unfollow` hard-deletes the row, the follows list
 * carries no `refetchInterval`, and a Manage-follows panel open in another
 * tab or device holds a stale row indefinitely. Flipping that stale row's
 * switch sends an `update` for a follow that no longer exists.
 *
 * The success handler used to ignore the server's response and build its
 * toast purely from the request `variables`, so a `null` (nothing changed,
 * because there was nothing left to change) was reported to the user as
 * "Auto-mirror armed. New trades from this trader are now placed
 * automatically." No follow exists and no automation was armed.
 *
 * These assertions call the REAL `onSuccess` handler `useManageFollows` wires
 * to `trpc.copyTradeFollows.update.useMutation`, captured off a real render of
 * the hook, not a copy of the handler's logic and not a source-string match.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FollowItem } from "./use-manage-follows";
import { buildDestinationPatch, type MirrorDestinationConfig } from "./account-targeting";
import { flattenElements, findByAriaLabel, type TestElement } from "@/testing/element-tree";
import { Select } from "@/components/ui/select";
import { AlertDialogAction } from "@/components/ui/alert-dialog";
import { StopMirrorDialog } from "./mirror-consent-dialogs";

type UpdateVariables = {
  autoMirror?: boolean;
  credentialId?: string | null;
  destinations?: Partial<Record<"stock" | "perp", MirrorDestinationConfig>>;
};

type UpdateMutationOptions = {
  onSuccess: (data: unknown, variables: UpdateVariables) => void;
  onError: (error: { message: string }) => void;
};

let capturedUpdateOptions: UpdateMutationOptions | null = null;

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isError: false,
  error: null as { message: string } | null,
  reset: () => {},
};

const toastCalls: { success: string[]; error: string[] } = { success: [], error: [] };
const invalidateCalls: string[] = [];
const updateMutationCalls: unknown[] = [];

let globalLeverageResult: {
  data: { globalPerpMaxLeverage: number } | undefined;
  error: { message: string } | null;
  isLoading: boolean;
} = { data: { globalPerpMaxLeverage: 3 }, error: null, isLoading: false };

mock.module("sonner", () => ({
  toast: {
    success: (message: string) => {
      toastCalls.success.push(message);
    },
    error: (message: string) => {
      toastCalls.error.push(message);
    },
  },
}));

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      copyTradeFollows: {
        list: { invalidate: () => invalidateCalls.push("copyTradeFollows.list") },
      },
      copyTrade: {
        feed: { invalidate: () => invalidateCalls.push("copyTrade.feed") },
      },
      leaderboard: {
        xCallers: { invalidate: () => invalidateCalls.push("leaderboard.xCallers") },
        users: { invalidate: () => invalidateCalls.push("leaderboard.users") },
      },
    }),
    copyTradeFollows: {
      list: {
        useQuery: () => ({ data: [], error: null, isLoading: false }),
      },
      update: {
        useMutation: (options: UpdateMutationOptions) => {
          capturedUpdateOptions = options;
          return {
            ...noopMutation,
            mutate: (variables: unknown) => updateMutationCalls.push(variables),
          };
        },
      },
      unfollow: {
        useMutation: () => noopMutation,
      },
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
      getCopyPerpLeverageSettings: {
        useQuery: () => globalLeverageResult,
      },
    },
    copyTrade: {
      mirrorStatus: {
        useQuery: () => ({ data: null }),
      },
    },
  },
}));

const { useManageFollows } = await import("./use-manage-follows");
const { IndependentFollowRow, DestinationStopConsentDialog } = await import("./manage-follows");

function Harness() {
  useManageFollows(true);
  return null;
}

/** Render the hook once so its real `useMutation({ onSuccess, ... })` options get captured. */
function mountHook(): void {
  renderToStaticMarkup(<Harness />);
}

function captureHook() {
  let state: ReturnType<typeof useManageFollows> | undefined;
  function StateHarness() {
    state = useManageFollows(true);
    return null;
  }
  renderToStaticMarkup(<StateHarness />);
  return state!;
}

function resetSpies(): void {
  toastCalls.success.length = 0;
  toastCalls.error.length = 0;
  invalidateCalls.length = 0;
  updateMutationCalls.length = 0;
}

describe("useManageFollows update onSuccess", () => {
  for (const destination of ["stock", "perp"] as const) {
    const label = destination === "stock" ? "Stocks" : "Perps";
    const account = {
      id: `${destination}-account`, provider: destination === "stock" ? "alpaca" as const : "hyperliquid" as const,
      accountId: null, accountType: "LIVE" as const,
    };
    for (const credentialId of [null, account.id]) {
      const follow: FollowItem = {
        id: "settings-follow", targetType: "user", targetKey: "trader", targetLabel: "Trader",
        autoMirror: false, credentialId: null, credentialAccountLabel: null,
        credentialAccountType: null, credentialProvider: null,
        sizingMode: "usd", sizingValue: 25, maxTradeSize: null, maxCoinSize: null,
        perpTakeProfitPct: null, perpStopLossPct: null,
        perpMaxLeverage: null, createdAt: "2026-01-01",
        destinations: { [destination]: { enabled: false, credentialId, sizingMode: "usd", sizingValue: 25 } },
      };

      test(`${destination} sizing with ${credentialId} reaches the real mutation success as an ordinary save`, () => {
        resetSpies();
        const state = captureHook();
        const tree = IndependentFollowRow({
          follow, accounts: [account], accountsLoading: false, buyingPower: 1000, equity: 1000,
          balancesCredentialId: null, limits: { dailyCap: 20, maxOrderDollars: 1000, dailyCapFromDefaults: false, maxOrderDollarsFromDefaults: false },
          globalPerpMaxLeverage: 2, deploymentBlockReason: null, disabled: false,
          destinationDrafts: { [destination]: { mode: null, value: "123.45", protection: { stopLoss: "", takeProfit: "" } } },
          onDestinationUpdate: (dest, config) => state.onUpdate(follow, buildDestinationPatch(dest, config)),
          onPerpUpdate() {}, onRequestConsent() {},
        });
        const input = findByAriaLabel(tree, `${label}: Dollars per order`)!;
        (input.props.onKeyDown as (event: { key: string }) => void)({ key: "Enter" });
        expect(updateMutationCalls).toHaveLength(1);
        const variables = updateMutationCalls[0] as UpdateVariables;
        expect(variables.destinations![destination]!.sizingValue).toBe(123.45);
        capturedUpdateOptions!.onSuccess({ id: follow.id }, variables);
        expect(toastCalls.success).toEqual(["Follow settings updated"]);
      });

      for (const kind of ["destination-disarm", "destination-clear"] as const) {
        test(`${destination} ${kind} with ${credentialId} reaches the real mutation toast only after confirmation`, () => {
          resetSpies();
          const state = captureHook();
          const armed = { ...follow, destinations: { [destination]: { ...follow.destinations![destination]!, enabled: true } } };
          const dialog = DestinationStopConsentDialog({
            consent: { follow: armed, ask: { kind, destination } }, accounts: [account],
            mutationPending: false, onClose() {}, onUpdate: state.onUpdate,
          })!;
          expect(updateMutationCalls).toHaveLength(0);
          const renderedDialog = StopMirrorDialog(dialog.props);
          const confirm = flattenElements(renderedDialog).find((element) => element.type === AlertDialogAction)!;
          (confirm.props.onClick as () => void)();
          expect(updateMutationCalls).toHaveLength(1);
          const variables = updateMutationCalls[0] as UpdateVariables;
          expect(Object.keys(variables.destinations!)).toEqual([destination]);
          expect(variables.destinations![destination]!.enabled).toBe(false);
          capturedUpdateOptions!.onSuccess({ id: follow.id }, variables);
          expect(toastCalls.success[0]).toContain(
            kind === "destination-clear" && credentialId !== null ? `${label} mirror account cleared` : `${label} auto-mirror stopped`,
          );
          expect(toastCalls.error).toEqual([]);
        });
      }

      if (credentialId !== null) {
        test(`${destination} explicit account clear while off still announces the clear`, () => {
          resetSpies();
          const state = captureHook();
          const tree = IndependentFollowRow({
            follow, accounts: [account], accountsLoading: false, buyingPower: 1000, equity: 1000,
            balancesCredentialId: null, limits: { dailyCap: 20, maxOrderDollars: 1000, dailyCapFromDefaults: false, maxOrderDollarsFromDefaults: false },
            globalPerpMaxLeverage: 2, deploymentBlockReason: null, disabled: false,
            onDestinationUpdate: (dest, config) => state.onUpdate(follow, buildDestinationPatch(dest, config)),
            onPerpUpdate() {}, onRequestConsent() {},
          });
          const section = flattenElements(tree).find((element) => element.props["data-destination"] === destination)!;
          const picker = flattenElements(section).find((element) => element.type === Select) as TestElement;
          (picker.props.onValueChange as (value: string) => void)("none");
          expect(updateMutationCalls).toHaveLength(1);
          capturedUpdateOptions!.onSuccess({ id: follow.id }, updateMutationCalls[0] as UpdateVariables);
          expect(toastCalls.success[0]).toContain(`${label} mirror account cleared`);
        });
      }
    }
  }
  test("reports a null server response as a failure, not an arm/disarm success", () => {
    mountHook();
    resetSpies();
    expect(capturedUpdateOptions).not.toBeNull();

    // The follow was deleted (unfollowed elsewhere) between this panel's
    // snapshot and the mutation: the server found no row to update and
    // returned null. `variables` still says autoMirror: true because that is
    // what the user's stale switch asked for.
    capturedUpdateOptions!.onSuccess(null, { autoMirror: true });

    expect(toastCalls.success).toEqual([]);
    expect(toastCalls.error.length).toBe(1);
    // The message must not itself claim automation changed.
    expect(toastCalls.error[0]).not.toContain("armed");
    expect(toastCalls.error[0]).not.toContain("placed automatically");
  });

  test("still refreshes the list on a null response, so the stale row clears", () => {
    mountHook();
    resetSpies();

    capturedUpdateOptions!.onSuccess(null, { autoMirror: true });

    expect(invalidateCalls).toContain("copyTradeFollows.list");
    expect(invalidateCalls).toContain("copyTrade.feed");
    expect(invalidateCalls).toContain("leaderboard.xCallers");
    expect(invalidateCalls).toContain("leaderboard.users");
  });

  test("keeps reporting the real arm/disarm success when the server returns the updated row", () => {
    mountHook();
    resetSpies();

    capturedUpdateOptions!.onSuccess({ id: "row-1" }, { autoMirror: true });

    expect(toastCalls.error).toEqual([]);
    expect(toastCalls.success).toEqual([
      "Auto-mirror armed. New trades from this trader are now placed automatically.",
    ]);
  });

  test("keeps reporting the disarm success when the server returns the updated row", () => {
    mountHook();
    resetSpies();

    capturedUpdateOptions!.onSuccess({ id: "row-1" }, { autoMirror: false });

    expect(toastCalls.error).toEqual([]);
    expect(toastCalls.success).toEqual([
      "Auto-mirror stopped. No new orders. Positions it already opened stay open.",
    ]);
  });

  test("returns the current global cap and preserves nullable per-follow updates", () => {
    resetSpies();
    globalLeverageResult = { data: { globalPerpMaxLeverage: 3 }, error: null, isLoading: false };
    const state = captureHook();

    expect(state.globalPerpMaxLeverage).toBe(3);
    expect(state.globalLeverageLoading).toBe(false);
    expect(state.globalLeverageError).toBeNull();

    const follow = {
      targetType: "user",
      targetKey: "trader-key",
    } as FollowItem;
    state.onUpdate(follow, { perpMaxLeverage: null });
    state.onUpdate(follow, { perpMaxLeverage: 2 });
    expect(updateMutationCalls).toEqual([
      { targetType: "user", targetKey: "trader-key", perpMaxLeverage: null },
      { targetType: "user", targetKey: "trader-key", perpMaxLeverage: 2 },
    ]);
  });

  test("surfaces a global cap query error without inventing a leverage value", () => {
    resetSpies();
    globalLeverageResult = {
      data: undefined,
      error: { message: "settings unavailable" },
      isLoading: false,
    };
    const state = captureHook();

    expect(state.globalPerpMaxLeverage).toBeNull();
    expect(state.globalLeverageError).toEqual({ message: "settings unavailable" });
  });
});
