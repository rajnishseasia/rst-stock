"use client";

/**
 * Plan S3, the People half of the mobile Search screen.
 *
 * Their Wallets tab shows what an address holds. This shows what a person said,
 * how often, and how their directional calls have actually resolved, with a
 * Follow on the same row and their full call history one tap away.
 *
 * One query, and it only runs while this tab is mounted. The parent renders the
 * tabs one at a time (never hidden), so nothing here polls off-screen (audit M3).
 *
 * Display and follow preferences only. Nothing here constructs, validates or
 * submits an order.
 */

import { useMemo } from "react";
import Link from "next/link";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { FollowButton } from "@/components/copy-trade/follow-button";
import { useFollowedKeys } from "@/components/copy-trade/use-leaderboard-view";
import { assetCoveragePresentation } from "@/components/copy-trade/asset-coverage";
import { CallerSourceLink } from "@/components/copy-trade/leaderboard-row-cells";
// DISPLAY ONLY. The server's caller identity key is derived from the RAW author
// name and is mirrored in raw SQL (normalizedSignalAuthorCondition), so renaming
// server-side would desync the key from the query and break profile lookups and
// stored follows. The feed and chart markers already normalize at render time;
// this keeps the People list consistent with them.
import { normalizeAuthorName } from "@/lib/signal-display";
import {
  PEOPLE_SEARCH_ROWS,
  PEOPLE_SEARCH_UNIVERSE,
  describeCallerSummary,
  describePeopleSearch,
  matchCallers,
} from "./people-search";

/** Window and horizon this tab measures over, matching the leaderboard's own
 *  X-caller defaults so the same person cannot show two different records. */
const PEOPLE_WINDOW = "30d" as const;
const PEOPLE_HORIZON = 1;

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function MobilePeopleBrowse({
  query,
  isSignedIn,
}: {
  query: string;
  isSignedIn: boolean;
}) {
  const followedKeys = useFollowedKeys(isSignedIn);
  const callersQuery = trpc.leaderboard.xCallers.useQuery(
    {
      window: PEOPLE_WINDOW,
      horizonDays: PEOPLE_HORIZON,
      // By VOLUME, not by forward return: this is a directory being searched by
      // name, so the universe should be "who has been posting", not "who scored
      // best". Ranking by return would hide an active caller with a flat record
      // behind 99 lucky ones.
      sortBy: "calls",
      limit: PEOPLE_SEARCH_UNIVERSE,
    },
    {
      enabled: isSignedIn,
      // The server caches this for 15 minutes. Re-fetching it on a timer while
      // someone types a name would buy nothing and cost a leaderboard scan.
      staleTime: 5 * 60_000,
      refetchInterval: false,
      retry: false,
    },
  );

  const universe = callersQuery.data?.rows ?? [];
  const matches = useMemo(
    () => matchCallers(universe, query).slice(0, PEOPLE_SEARCH_ROWS),
    [universe, query],
  );

  const state = describePeopleSearch({
    isSignedIn,
    isLoading: callersQuery.isLoading,
    hasError: !!callersQuery.error,
    query,
    universeSize: universe.length,
    matchCount: matches.length,
  });

  if (state.kind === "notice") {
    return callersQuery.isLoading ? (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
      </div>
    ) : (
      <p className="rounded-2xl border bg-card/50 px-3 py-6 text-center text-xs text-muted-foreground">
        {state.message}
      </p>
    );
  }

  return (
    <section aria-label="Callers" className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Callers
        </h3>
        <span className="text-3xs text-muted-foreground">
          {matches.length}
        </span>
      </div>
      <ul className="divide-y divide-border/40 rounded-2xl border bg-card/50">
        {matches.map((caller) => {
          const coverage = assetCoveragePresentation(caller.assetCoverage);
          return (
            <li
              key={caller.followTarget.key}
              className="flex min-h-14 items-center gap-2 px-3 py-2"
            >
              <Avatar size="default" className="shrink-0">
                {caller.avatar && (
                  <AvatarImage src={caller.avatar} alt="" />
                )}
                <AvatarFallback>
                  {initialsOf(normalizeAuthorName(caller.displayName)) || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* The name goes INWARD, to their full measured history. The
                      icon beside it goes OUT, to the post itself (plan S5). */}
                  <Link
                    href={`/lb/x/${encodeURIComponent(caller.followTarget.key)}`}
                    className="min-w-0 truncate text-sm font-semibold hover:text-primary hover:underline"
                  >
                    {normalizeAuthorName(caller.displayName)}
                  </Link>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1 py-0.5 text-3xs font-semibold uppercase tracking-wide",
                      coverage.className,
                    )}
                    title={coverage.title}
                  >
                    {coverage.label}
                  </span>
                  <CallerSourceLink
                    url={caller.latestCallUrl}
                    displayName={normalizeAuthorName(caller.displayName)}
                  />
                </div>
                <span className="truncate text-2xs text-muted-foreground">
                  {describeCallerSummary({
                    callCount: caller.callCount,
                    measuredCallCount: caller.measuredCallCount,
                    hitRate: caller.hitRate,
                    horizonDays: PEOPLE_HORIZON,
                  })}
                </span>
              </div>
              <FollowButton
                target={caller.followTarget}
                isFollowing={followedKeys.has(
                  `x_author|${caller.followTarget.key}`,
                )}
              />
            </li>
          );
        })}
      </ul>
      <p className="px-1 pt-1 text-3xs leading-tight text-muted-foreground">
        Hit rate is how often the ticker moved the way the call did, over{" "}
        {PEOPLE_HORIZON}D. Not the caller&apos;s realized P&amp;L.
      </p>
    </section>
  );
}
