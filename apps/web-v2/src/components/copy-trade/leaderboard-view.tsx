"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { TOUCH_HEIGHT_COMPACT } from "@/components/ui/touch-target";
import { trpc } from "@/lib/trpc";
import {
  useXCallersTab,
  useUsersTab,
  type LeaderboardWindow,
  type UsersSortBy,
  type XSortBy,
  type XHorizon,
  type XCallersTabOptions,
  type UsersTabOptions,
} from "./use-leaderboard-view";
import { XCallerRowCard, UserRowCard, SelfStandingRow } from "./leaderboard-row-cells";
import { describeSelfStanding, selfRowKey } from "./leaderboard-self";
import { describeLeaderboardState } from "./leaderboard-state";
import Link from "next/link";

const WINDOW_OPTIONS: Array<{ value: LeaderboardWindow; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const USERS_SORT_OPTIONS: Array<{ value: UsersSortBy; label: string }> = [
  { value: "pnl", label: "P&L" },
  { value: "winRate", label: "Win rate" },
  { value: "trades", label: "Trades" },
];

const X_SORT_OPTIONS: Array<{ value: XSortBy; label: string }> = [
  { value: "forwardReturn", label: "Forward return" },
  { value: "hitRate", label: "Hit rate" },
  { value: "calls", label: "Calls" },
];

const X_HORIZON_OPTIONS: Array<{ value: XHorizon; label: string }> = [
  { value: 1, label: "1D" },
  { value: 3, label: "3D" },
  { value: 7, label: "7D" },
];

/** Honest captions - surfaced as the contract requires (no audited-truth framing). */
const USERS_CAPTION =
  "Approximate - realized P&L from shared trades (FIFO) plus live Hyperliquid unrealized P&L; excludes account size and unfilled orders.";
const CALLERS_CAPTION =
  "Canonical stock and Hyperliquid perp calls are measured for direction-adjusted signal forward return - not the caller's option, leverage, or account P&L.";

export interface LeaderboardViewProps {
  isSignedIn: boolean;
  /** Active tab. When provided the component is URL-controlled; defaults to "x". */
  tab?: "x" | "users";
  onTabChange?: (tab: "x" | "users") => void;
  /** Options forwarded to the Callers tab hook (controlled state + callbacks). */
  xOptions?: XCallersTabOptions;
  /** Options forwarded to the Users tab hook (controlled state + callbacks). */
  usersOptions?: UsersTabOptions;
}

/**
 * "Top Traders" leaderboard - the standalone /lb page body. Two tabs
 * (Callers / Users), each backed by its own ranked query with window + sortBy
 * controls. Every row's Follow control reuses the SAME copyTradeFollows follow
 * set + the row's followTarget, so following from the leaderboard stays in sync
 * with the feed / Following filter.
 *
 * When used on the /lb page, pass tab/onTabChange + xOptions/usersOptions
 * to keep tab, window, sort, and horizon synced to the URL.
 */
export function LeaderboardView({
  isSignedIn,
  tab: controlledTab,
  onTabChange,
  xOptions,
  usersOptions,
}: LeaderboardViewProps) {
  // Internal state for when the tab is NOT externally controlled (e.g., in the
  // copy-trade panel). When `controlledTab` is provided the URL drives the value.
  const [internalTab, setInternalTab] = useState<"x" | "users">("x");
  const isControlled = controlledTab !== undefined;
  const activeTab = isControlled ? controlledTab : internalTab;

  const handleTabChange = (v: string) => {
    const next = v as "x" | "users";
    if (!isControlled) setInternalTab(next);
    onTabChange?.(next);
  };

  return (
    <Tabs
      value={activeTab}
      onValueChange={handleTabChange}
      className="flex flex-col gap-3"
    >
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="x">Callers</TabsTrigger>
        <TabsTrigger value="users">Users</TabsTrigger>
      </TabsList>

      <TabsContent value="x" className="flex flex-col">
        <XCallersTab isSignedIn={isSignedIn} options={xOptions} />
      </TabsContent>
      <TabsContent value="users" className="flex flex-col">
        <UsersTab isSignedIn={isSignedIn} options={usersOptions} />
      </TabsContent>
    </Tabs>
  );
}

// ============================================
// Callers tab
// ============================================

/**
 * The caller ranking body. Exported so the mobile shell (plan A10) can mount a
 * single board directly instead of nesting `LeaderboardView`'s own Tabs inside
 * the Copy screen's tab row.
 */
export function XCallersTab({
  isSignedIn,
  options,
}: {
  isSignedIn: boolean;
  options?: XCallersTabOptions;
}) {
  const {
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
    isLoading,
    isError,
    errorMessage,
    retry,
    followedKeys,
  } = useXCallersTab(isSignedIn, options);

  const measurementDegraded =
    rankingFallback ||
    partialMarketData ||
    !dataComplete ||
    marketDataHealth?.complete === false ||
    signalScan?.truncated === true;
  const displayState = describeLeaderboardState({
    isSignedIn,
    isLoading,
    isError,
    errorMessage,
    rowCount: rows.length,
    degraded: measurementDegraded,
  });

  return (
    <div className="flex flex-col gap-2 pt-2">
      <Controls
        window={window}
        onWindowChange={setWindow}
        sortOptions={X_SORT_OPTIONS}
        sortBy={sortBy}
        onSortChange={setSortBy}
      />

      <div className="flex items-center gap-1">
        <span className="text-2xs text-muted-foreground">Forward horizon</span>
        <div className="flex items-center gap-1">
          {X_HORIZON_OPTIONS.map((option) => (
            <Segment
              key={option.value}
              active={horizonDays === option.value}
              onClick={() => setHorizonDays(option.value)}
            >
              {option.label}
            </Segment>
          ))}
        </div>
      </div>

      <p className="text-2xs text-muted-foreground">{CALLERS_CAPTION}</p>

      {rankingFallback && (
        <p role="status" aria-live="polite" className="rounded-md bg-muted/50 px-2 py-1 text-2xs text-muted-foreground">
          Market data unavailable - ranked by call count only. Forward-return metrics need market data.
        </p>
      )}

      {partialMarketData && !rankingFallback && (
        <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
          Some market candidates were unavailable or intentionally omitted. Rankings use the available forward-return data.
        </p>
      )}

      {marketDataHealth && marketDataHealth.unresolvedCandidateCount > 0 && (
        <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
          {marketDataHealth.unresolvedCandidateCount} retained candidates could not be resolved to a canonical market. This is separate from provider outages and intentional request caps.
        </p>
      )}

      {marketDataHealth && marketDataHealth.deadlineMarketCount > 0 && (
        <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
          {marketDataHealth.deadlineMarketCount} started market requests were aborted at the leaderboard fetch deadline and are unavailable for this result.
        </p>
      )}

      {marketDataHealth && marketDataHealth.skippedMarketCount > 0 && (
        <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
          {marketDataHealth.skippedMarketCount} market requests were skipped because the leaderboard fetch budget was exhausted; no provider request was started for those markets.
        </p>
      )}

      {marketDataHealth?.capped && (
        <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
          Market requests are capped at {marketDataHealth.marketCap} distinct markets; {marketDataHealth.omittedMarketCount} markets were intentionally omitted. This is separate from provider outages.
        </p>
      )}

      {signalScan?.truncated && (
        <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
          Rankings are partial: {signalScan?.retainedCount ?? 5_000} signals were retained under the {signalScan?.cap ?? 5_000}-signal scan cap, and older signals are excluded.
        </p>
      )}

      {!dataComplete &&
        !rankingFallback &&
        !partialMarketData &&
        !signalScan?.truncated &&
        marketDataHealth?.complete !== false && (
          <p role="status" aria-live="polite" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
            Measurement coverage is partial for this result. Unmeasured calls are excluded from the forward-return metrics.
          </p>
        )}

      <div>
        {displayState.kind === "signed_out" ? (
          <EmptyState>{displayState.message}</EmptyState>
        ) : displayState.kind === "loading" ? (
          <RowSkeletons />
        ) : displayState.kind === "error" ? (
          <RetryState message={displayState.message} onRetry={retry} />
        ) : displayState.kind === "degraded" ? (
          <DegradedState message={displayState.message} onRetry={retry} />
        ) : displayState.kind === "empty" ? (
          <EmptyState>No calls in this window yet.</EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row, i) => (
              <XCallerRowCard
                key={`${row.followTarget.type}|${row.followTarget.key}`}
                rank={i + 1}
                row={row}
                window={window}
                horizonDays={horizonDays}
                sortBy={sortBy}
                isFollowing={followedKeys.has(
                  `${row.followTarget.type}|${row.followTarget.key}`,
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Users tab
// ============================================

/** The user ranking body. Exported for the same reason as `XCallersTab`. */
export function UsersTab({
  isSignedIn,
  options,
}: {
  isSignedIn: boolean;
  options?: UsersTabOptions;
}) {
  const {
    window,
    setWindow,
    sortBy,
    setSortBy,
    rows,
    me,
    degraded,
    capacity,
    measurement,
    isLoading,
    isError,
    errorMessage,
    retry,
    followedKeys,
  } = useUsersTab(isSignedIn, options);

  // Read Twitter-linked status fresh from the DB so the "Connect X" prompt
  // disappears immediately after linking, even while the leaderboard cache
  // (which drives me.row.twitterLinked) is still warm with the old snapshot.
  const socialIdentityQuery = trpc.userSettings.socialIdentity.useQuery(undefined, {
    enabled: isSignedIn,
    // No staleTime: always refetch on mount so the "Connect X" banner clears
    // immediately after the user links their account in Settings.
  });
  // Fall back to the cached row value if the identity query hasn't resolved yet.
  const twitterLinked =
    socialIdentityQuery.data?.twitterLinked ?? me?.row?.twitterLinked ?? false;

  // If any public Twitter identity field is missing, trigger a silent re-sync
  // so the leaderboard shows the complete profile without a Settings visit.
  const utils = trpc.useUtils();
  const refreshTwitterMutation = trpc.userSettings.refreshTwitterProfile.useMutation({
    onSuccess: async (result) => {
      if (result.ok) {
        // Refetch both the identity query (clears the "Connect X" prompt) and
        // the leaderboard users query (updates the `me` row's display name and
        // avatar without waiting for the 60s cache to expire).
        await Promise.all([
          socialIdentityQuery.refetch(),
          utils.leaderboard.users.invalidate(),
        ]);
      }
    },
  });
  useEffect(() => {
    const data = socialIdentityQuery.data;
    if (
      data?.twitterLinked &&
      data.twitterProfileComplete === false &&
      !refreshTwitterMutation.isPending &&
      !refreshTwitterMutation.isSuccess
    ) {
      refreshTwitterMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    socialIdentityQuery.data?.twitterLinked,
    socialIdentityQuery.data?.twitterProfileComplete,
  ]);

  const measurementIncomplete = measurement?.complete === false;

  // Plan A11. Pinned above the ranking, whatever the rank: the board is
  // anonymized and pages at 25, so this is the only way a user sees where they
  // stand. Rendered even when the ranking below is empty.
  const selfStanding = describeSelfStanding({
    isSignedIn,
    isLoading,
    me,
    degraded: degraded || isError || measurementIncomplete,
    measurement,
  });
  const ownKey = selfRowKey(me);

  return (
    <div className="flex flex-col gap-2 pt-2">
      <Controls
        window={window}
        onWindowChange={setWindow}
        sortOptions={USERS_SORT_OPTIONS}
        sortBy={sortBy}
        onSortChange={setSortBy}
      />

      <p className="text-2xs text-muted-foreground">
        {USERS_CAPTION} Measured over {measurement?.horizonLabel ?? "the selected window"}.
      </p>

      {measurement &&
        (measurement.staleWalletCount > 0 || measurement.unavailableWalletCount > 0) && (
          <p role="status" className="rounded-md bg-amber-500/10 px-2 py-1 text-2xs text-amber-300">
            {measurement.staleWalletCount > 0
              ? `${measurement.staleWalletCount} wallet${measurement.staleWalletCount === 1 ? " uses" : "s use"} a recent cached P&L snapshot. `
              : ""}
            {measurement.unavailableWalletCount > 0
              ? `${measurement.unavailableWalletCount} wallet${measurement.unavailableWalletCount === 1 ? " is" : "s are"} omitted until market data is available.`
              : ""}
          </p>
        )}

      <SelfStandingRow presentation={selfStanding} window={window} sortBy={sortBy} />

      {isSignedIn && me?.row && !twitterLinked && (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          You appear as <span className="font-medium text-foreground">{me.row.displayName}</span>.{" "}
          <Link href="/settings?t=profile" className="font-medium text-primary hover:underline">
            Connect X to show your profile instead
          </Link>
          .
        </p>
      )}

      <div>
        {!isSignedIn ? (
          <EmptyState>Sign in to see the user leaderboard.</EmptyState>
        ) : isLoading ? (
          <RowSkeletons />
        ) : isError ? (
          <RetryState message={errorMessage} onRetry={retry} />
        ) : degraded ? (
          <DegradedState
            message={capacity ? `${capacity.reason.replaceAll("_", " ")} while ranking` : "Leaderboard is temporarily unavailable"}
            onRetry={retry}
          />
        ) : measurementIncomplete ? (
          <DegradedState
            message="The user leaderboard is incomplete, so the displayed ranking is not available."
            onRetry={retry}
          />
        ) : rows.length === 0 ? (
          <EmptyState>No closed trades in this window yet.</EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows
              .map((row, i) => ({ row, rank: i + 1 }))
              .filter(({ row }) => row.followTarget.key !== ownKey)
              .map(({ row, rank }) => (
                <UserRowCard
                  key={`${row.followTarget.type}|${row.followTarget.key}`}
                  rank={rank}
                  row={row}
                  window={window}
                  sortBy={sortBy}
                  isFollowing={followedKeys.has(
                    `${row.followTarget.type}|${row.followTarget.key}`,
                  )}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Shared bits
// ============================================

/** Window selector + sortBy selector, styled as compact segmented controls. */
function Controls<S extends string>({
  window,
  onWindowChange,
  sortOptions,
  sortBy,
  onSortChange,
}: {
  window: LeaderboardWindow;
  onWindowChange: (w: LeaderboardWindow) => void;
  sortOptions: Array<{ value: S; label: string }>;
  sortBy: S;
  onSortChange: (s: S) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <span className="text-2xs text-muted-foreground">Window</span>
        <div className="flex items-center gap-1">
          {WINDOW_OPTIONS.map((opt) => (
            <Segment
              key={opt.value}
              active={window === opt.value}
              onClick={() => onWindowChange(opt.value)}
            >
              {opt.label}
            </Segment>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-2xs text-muted-foreground">Sort</span>
        <div className="flex items-center gap-1">
          {sortOptions.map((opt) => (
            <Segment
              key={opt.value}
              active={sortBy === opt.value}
              onClick={() => onSortChange(opt.value)}
            >
              {opt.label}
            </Segment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A single segmented-control button (mirrors the panel's SourceTab styling). */
function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // 44px on touch, the compact 28px pill from sm up. Same shape as the
        // panel's "Top Traders" button (copy-trade-panel.tsx) so the two rows
        // of leaderboard controls stay visually consistent.
        TOUCH_HEIGHT_COMPACT,
        "inline-flex items-center rounded-md border px-3 text-xs font-medium transition-colors sm:px-2.5",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RowSkeletons() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="py-10 text-center text-sm text-muted-foreground">{children}</div>
  );
}

function RetryState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      <AlertTriangle className="size-4 text-amber-400" aria-hidden="true" />
      <p>{message ?? "Leaderboard is temporarily unavailable"}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

function DegradedState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      <AlertTriangle className="size-4 text-amber-400" aria-hidden="true" />
      <p>{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Refresh
      </Button>
    </div>
  );
}
