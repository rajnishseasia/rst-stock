"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@trade-bot/api";
import type { inferRouterOutputs } from "@trpc/server";
import { followMembershipKeys } from "./follow-membership";

export { followMembershipKeys } from "./follow-membership";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type XCallerRow = RouterOutputs["leaderboard"]["xCallers"]["rows"][number];
export type FollowListItem = RouterOutputs["copyTradeFollows"]["list"][number];
export type XCallerMarketDataHealth =
  RouterOutputs["leaderboard"]["xCallers"]["marketDataHealth"];
export type XCallerSignalScan = RouterOutputs["leaderboard"]["xCallers"]["signalScan"];
export type UserRow = RouterOutputs["leaderboard"]["users"]["rows"][number];
/**
 * The signed-in caller's own standing (plan A11). The board is anonymized, so
 * without this the user cannot locate themselves at all: not by name, and not
 * at rank 40 under a `limit: 25` page.
 */
export type UserSelfStanding = RouterOutputs["leaderboard"]["users"]["me"];
export type UserLeaderboardCapacity = RouterOutputs["leaderboard"]["users"]["capacity"];
export type UserLeaderboardMeasurement = RouterOutputs["leaderboard"]["users"]["measurement"];

export type LeaderboardWindow = "7d" | "30d" | "all";
export type UsersSortBy = "pnl" | "winRate" | "trades";
export type XSortBy = "forwardReturn" | "hitRate" | "calls";
export type XHorizon = 1 | 3 | 7;

/** Reads the follow set keyed "type|key", same as the panel / feed. */
export function useFollowedKeys(isSignedIn: boolean): Set<string> {
  const followsQuery = trpc.copyTradeFollows.list.useQuery(undefined, {
    enabled: isSignedIn,
  });
  return useMemo(() => {
    const set = new Set<string>();
    for (const f of followsQuery.data ?? []) {
      for (const key of followMembershipKeys(f)) {
        set.add(`${f.targetType}|${key}`);
      }
    }
    return set;
  }, [followsQuery.data]);
}

export interface XCallersTabOptions {
  window?: LeaderboardWindow;
  sortBy?: XSortBy;
  horizonDays?: XHorizon;
  onWindowChange?: (w: LeaderboardWindow) => void;
  onSortByChange?: (s: XSortBy) => void;
  onHorizonChange?: (h: XHorizon) => void;
}

export interface UsersTabOptions {
  window?: LeaderboardWindow;
  sortBy?: UsersSortBy;
  onWindowChange?: (w: LeaderboardWindow) => void;
  onSortByChange?: (s: UsersSortBy) => void;
}

export interface XCallersTabState {
  window: LeaderboardWindow;
  setWindow: (w: LeaderboardWindow) => void;
  sortBy: XSortBy;
  setSortBy: (s: XSortBy) => void;
  horizonDays: XHorizon;
  setHorizonDays: (h: XHorizon) => void;
  rows: XCallerRow[];
  rankingFallback: boolean;
  partialMarketData: boolean;
  dataComplete: boolean;
  marketDataHealth: XCallerMarketDataHealth | null;
  signalScan: XCallerSignalScan | null;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  retry: () => void;
  followedKeys: Set<string>;
}

export function useXCallersTab(
  isSignedIn: boolean,
  options?: XCallersTabOptions,
): XCallersTabState {
  const [internalWindow, setInternalWindow] = useState<LeaderboardWindow>("30d");
  const [internalSortBy, setInternalSortBy] = useState<XSortBy>("forwardReturn");
  const [internalHorizonDays, setInternalHorizonDays] = useState<XHorizon>(1);
  const window = options?.window ?? internalWindow;
  const sortBy = options?.sortBy ?? internalSortBy;
  const horizonDays = options?.horizonDays ?? internalHorizonDays;

  const followedKeys = useFollowedKeys(isSignedIn);

  const setWindow = (w: LeaderboardWindow) => {
    if (options?.window === undefined) setInternalWindow(w);
    options?.onWindowChange?.(w);
  };
  const setSortBy = (s: XSortBy) => {
    if (options?.sortBy === undefined) setInternalSortBy(s);
    options?.onSortByChange?.(s);
  };
  const setHorizonDays = (h: XHorizon) => {
    if (options?.horizonDays === undefined) setInternalHorizonDays(h);
    options?.onHorizonChange?.(h);
  };

  const query = trpc.leaderboard.xCallers.useQuery(
    { window, sortBy, horizonDays, limit: 25 },
    {
      enabled: isSignedIn,
      staleTime: 60 * 60_000,
      refetchOnWindowFocus: false,
    },
  );

  const rows: XCallerRow[] = query.data?.rows ?? [];
  const rankingFallback = query.data?.rankingFallback ?? false;
  const partialMarketData = query.data?.partialMarketData ?? false;
  const dataComplete = query.data?.dataComplete ?? true;
  const marketDataHealth = query.data?.marketDataHealth ?? null;
  const signalScan = query.data?.signalScan ?? null;

  return {
    window,
    setWindow,
    sortBy,
    setSortBy,
    horizonDays,
    setHorizonDays,
    rows,
    rankingFallback,
    partialMarketData,
    dataComplete,
    marketDataHealth,
    signalScan,
    isLoading: query.isLoading,
    isError: query.isError,
    errorMessage: query.error?.message ?? null,
    retry: () => { void query.refetch(); },
    followedKeys,
  };
}

export interface UsersTabState {
  window: LeaderboardWindow;
  setWindow: (w: LeaderboardWindow) => void;
  sortBy: UsersSortBy;
  setSortBy: (s: UsersSortBy) => void;
  rows: UserRow[];
  /** The caller's own standing, or null while loading / signed out. */
  me: UserSelfStanding | null;
  degraded: boolean;
  capacity: UserLeaderboardCapacity;
  measurement: UserLeaderboardMeasurement | null;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  retry: () => void;
  followedKeys: Set<string>;
}

export function useUsersTab(
  isSignedIn: boolean,
  options?: UsersTabOptions,
): UsersTabState {
  const [internalWindow, setInternalWindow] = useState<LeaderboardWindow>("all");
  const [internalSortBy, setInternalSortBy] = useState<UsersSortBy>("pnl");
  const window = options?.window ?? internalWindow;
  const sortBy = options?.sortBy ?? internalSortBy;

  const followedKeys = useFollowedKeys(isSignedIn);

  const setWindow = (w: LeaderboardWindow) => {
    if (options?.window === undefined) setInternalWindow(w);
    options?.onWindowChange?.(w);
  };
  const setSortBy = (s: UsersSortBy) => {
    if (options?.sortBy === undefined) setInternalSortBy(s);
    options?.onSortByChange?.(s);
  };

  const query = trpc.leaderboard.users.useQuery(
    { window, sortBy, limit: 25 },
    {
      enabled: isSignedIn,
      staleTime: 60 * 60_000,
      refetchOnWindowFocus: false,
    },
  );

  const rows: UserRow[] = query.data?.rows ?? [];

  return {
    window,
    setWindow,
    sortBy,
    setSortBy,
    rows,
    me: query.data?.me ?? null,
    degraded: query.data?.degraded ?? false,
    capacity: query.data?.capacity ?? null,
    measurement: query.data?.measurement ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    errorMessage: query.error?.message ?? null,
    retry: () => { void query.refetch(); },
    followedKeys,
  };
}
