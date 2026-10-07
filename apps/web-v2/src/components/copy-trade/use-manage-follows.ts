"use client";

import { trpc } from "@/lib/trpc";
import { useCompleteApiCredentials } from "@/lib/use-complete-api-credentials";
import { toast } from "sonner";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";
import { toAccountOptions, type AlpacaAccountOption } from "./account-targeting";
import type {
  MirrorDestination,
  MirrorDestinationConfig,
} from "./account-targeting";
import {
  followUpdateToast,
  UNFOLLOW_TOAST,
  type MirrorStatus,
} from "./mirror-consent";

function validPerpLeverage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COPY_PERP_MAX_LEVERAGE_MIN &&
    value <= COPY_PERP_MAX_LEVERAGE_MAX
  );
}

type FollowTargetType = "x_author" | "user" | "politician" | "hl_wallet";

/** A single follow row as returned by copyTradeFollows.list. */
export interface FollowItem {
  id: string;
  targetType: FollowTargetType;
  targetKey: string;
  targetLabel: string | null;
  sizingMode: "pct" | "pct_equity" | "usd" | "ratio";
  sizingValue: number;
  /** Dollar cap per single mirrored trade. Null = no cap. */
  maxTradeSize: number | null;
  /** Total copied exposure cap per ticker. Null = no cap. */
  maxCoinSize: number | null;
  autoMirror: boolean;
  credentialId: string | null;
  /**
   * The automatic exit attached to Hyperliquid perp mirrors from this follow, as
   * percent of the margin behind the position. Null on either leg means that leg
   * is not configured, and both null (the default) means no exit at all.
   */
  perpTakeProfitPct: number | null;
  perpStopLossPct: number | null;
  /** Null means this follow inherits the user's global copy-perp ceiling. */
  perpMaxLeverage: number | null;
  credentialAccountLabel: string | null;
  credentialAccountType: "PAPER" | "LIVE" | null;
  credentialProvider: "alpaca" | "hyperliquid" | null;
  /** Present after the independent stock/perp API rollout. */
  destinations?: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
  createdAt: string;
}

export interface ManageFollowsState {
  follows: FollowItem[];
  /** Current user-owned global automatic-perp ceiling, or null while unavailable. */
  globalPerpMaxLeverage: number | null;
  globalLeverageLoading: boolean;
  globalLeverageError: { message: string } | null;
  accounts: AlpacaAccountOption[];
  accountsLoading: boolean;
  followsLoading: boolean;
  followsError: { message: string } | null;
  /**
   * What this deployment reports about auto-mirroring, or null while the query
   * is in flight / has failed. NEVER treat null as "off": see MirrorStatus.
   */
  mirrorStatus: MirrorStatus | null;
  mutationPending: boolean;
  onUpdate: (
    follow: FollowItem,
    patch: {
      autoMirror?: boolean;
      sizingMode?: FollowItem["sizingMode"];
      sizingValue?: number;
      maxTradeSize?: number | null;
      maxCoinSize?: number | null;
      credentialId?: string | null;
      // Absent leaves the stored exit alone; an explicit null removes it. The
      // router draws the same distinction and is the authority on it, so a
      // caller must never send null to mean "unchanged".
      perpTakeProfitPct?: number | null;
      perpStopLossPct?: number | null;
      perpMaxLeverage?: number | null;
      destinations?: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
    },
  ) => void;
  onUnfollow: (follow: FollowItem) => void;
}

export function useManageFollows(isSignedIn: boolean): ManageFollowsState {
  const trpcUtils = trpc.useUtils();

  const followsQuery = trpc.copyTradeFollows.list.useQuery(undefined, {
    enabled: isSignedIn,
  });
  const follows = (followsQuery.error ? [] : (followsQuery.data ?? [])) as FollowItem[];

  // Older embedded/test callers may provide a partial trpc mock while the real
  // router always has this procedure. Keeping the fallback here lets the rest
  // of the manage-follows surface remain usable while the cap query is absent,
  // without inventing a leverage value.
  const leverageSettingsQuery =
    trpc.userSettings.getCopyPerpLeverageSettings?.useQuery(undefined, {
      enabled: isSignedIn,
    }) ?? { data: undefined, isLoading: false, error: null };
  const rawGlobalPerpMaxLeverage = leverageSettingsQuery.error
    ? undefined
    : leverageSettingsQuery.data?.globalPerpMaxLeverage;
  const globalPerpMaxLeverage = validPerpLeverage(rawGlobalPerpMaxLeverage)
    ? rawGlobalPerpMaxLeverage
    : null;

  const accountsQuery = useCompleteApiCredentials(undefined, { enabled: isSignedIn });
  const accounts: AlpacaAccountOption[] = toAccountOptions(accountsQuery.accounts);

  // What this deployment can honestly say about auto-mirroring. Read once here
  // so the banner and every row's arming switch agree on it.
  const mirrorStatusQuery = trpc.copyTrade.mirrorStatus.useQuery(undefined, {
    enabled: isSignedIn,
    staleTime: 60_000,
  });

  const invalidate = () => {
    trpcUtils.copyTradeFollows.list.invalidate();
    trpcUtils.copyTrade.feed.invalidate();
    trpcUtils.leaderboard.xCallers.invalidate();
    trpcUtils.leaderboard.users.invalidate();
  };

  const updateMutation = trpc.copyTradeFollows.update.useMutation({
    onSuccess: (data, variables) => {
      invalidate();
      // The server returns null instead of throwing when the row it looked
      // up is gone: `if (!current) return null;`, and again if the UPDATE
      // itself matches no row (apps/api/src/routers/copy-trade-follows.ts).
      // That happens for real when this follow was unfollowed from another
      // tab or device while this panel held a stale snapshot (the follows
      // list has no refetchInterval). Nothing was armed or disarmed, so
      // toasting off `variables` alone would report that non-event as the
      // real thing. `invalidate()` above already clears the stale row.
      if (!data) {
        toast.error("That follow no longer exists. The list has been refreshed.");
        return;
      }
      // Arming and stopping are not "settings updated": they are the two
      // moments the user most needs told apart from editing a size.
      toast.success(followUpdateToast(variables));
    },
    onError: (error) => {
      toast.error(error.message || "Could not update follow");
    },
  });

  const unfollowMutation = trpc.copyTradeFollows.unfollow.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(UNFOLLOW_TOAST);
    },
    onError: (error) => {
      toast.error(error.message || "Could not unfollow");
    },
  });

  const onUpdate: ManageFollowsState["onUpdate"] = (follow, patch) => {
    updateMutation.mutate({
      targetType: follow.targetType,
      targetKey: follow.targetKey,
      ...patch,
    });
  };

  const onUnfollow: ManageFollowsState["onUnfollow"] = (follow) => {
    unfollowMutation.mutate({
      targetType: follow.targetType,
      targetKey: follow.targetKey,
    });
  };

  return {
    follows,
    globalPerpMaxLeverage,
    globalLeverageLoading: leverageSettingsQuery.isLoading,
    globalLeverageError: leverageSettingsQuery.error
      ? { message: leverageSettingsQuery.error.message }
      : null,
    accounts,
    accountsLoading: accountsQuery.isLoading,
    followsLoading: followsQuery.isLoading,
    followsError: followsQuery.error ? { message: followsQuery.error.message } : null,
    mirrorStatus: mirrorStatusQuery.data ?? null,
    mutationPending: updateMutation.isPending || unfollowMutation.isPending,
    onUpdate,
    onUnfollow,
  };
}
