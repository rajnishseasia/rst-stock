"use client";

import { useEffect } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, ExternalLink, RefreshCw, Settings, Trophy } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { UserMenu } from "@/components/auth/user-menu";
import { FollowButton } from "@/components/copy-trade/follow-button";
import { followMembershipKeys } from "@/components/copy-trade/follow-membership";
import { useSession } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatSignedNumber } from "@/lib/format";
import { safeExternalPostUrl } from "@/components/feed/signal-feed-utils";
import { assetClassPresentation, assetCoveragePresentation } from "@/components/copy-trade/asset-coverage";
import { describeProfileState } from "@/components/copy-trade/leaderboard-state";

type LeaderboardWindow = "7d" | "30d" | "all";

function parseWindow(value: string | null): LeaderboardWindow {
  return value === "7d" || value === "all" ? value : "30d";
}

function parseHorizon(value: string | null): 1 | 3 | 7 {
  return value === "3" ? 3 : value === "7" ? 7 : 1;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatHitRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return (value * 100).toFixed(0) + "%";
}

function formatCalledAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Timestamp unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

const STATUS_LABELS: Record<string, string> = {
  measured: "Measured",
  direction_unknown: "Direction unclear",
  asset_class_unsupported: "Asset kind unsupported",
  market_data_unavailable: "Market data unavailable",
  horizon_incomplete: "Horizon incomplete",
  not_comparable: "Outside global scan",
};

function directionLabel(direction: string): string {
  if (direction === "bullish") return "Bullish";
  if (direction === "bearish") return "Bearish";
  return "Direction unclear";
}

function measurementLabel(status: string, horizonDays: number): string {
  return status === "measured"
    ? `${horizonDays}D measured`
    : `${horizonDays}D: ${STATUS_LABELS[status] ?? "Unmeasured"}`;
}

function profileMeasurementNote(
  profile: {
    measurementStatus: string;
    measuredCallCount: number;
    directionalCallCount: number;
    needsMarketData: boolean;
    measurementCandidateOmittedCount: number;
  },
  horizonDays: number,
): string | null {
  if (profile.measurementStatus === "not_comparable") {
    return "This caller is outside the newest global scan, so the profile detail is context only and has no comparable score.";
  }
  if (profile.measuredCallCount > 0) return null;
  if (profile.needsMarketData) {
    return `Market data is unavailable for these calls, so no ${horizonDays}D return is scored.`;
  }
  if (profile.directionalCallCount === 0) {
    return "None of these calls state a clear direction, so no forward return can be scored.";
  }
  if (profile.measurementCandidateOmittedCount > 0) {
    return `No retained call has a complete ${horizonDays}D result. Some eligible calls were omitted by the measurement cap.`;
  }
  return `Waiting for a complete ${horizonDays}D result on these calls.`;
}

export default function XCallerProfilePage() {
  const params = useParams<{ authorKey: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session } = useSession();
  const isSignedIn = Boolean(session?.user);
  const authorKey = params.authorKey ?? "";
  const window = parseWindow(searchParams.get("w") ?? searchParams.get("window"));
  const horizonDays = parseHorizon(searchParams.get("h") ?? searchParams.get("horizon"));
  const leaderboardHref = "/lb" as Route;

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("w");
    next.delete("window");
    next.delete("sort");
    next.delete("h");
    next.delete("horizon");
    if (window !== "30d") next.set("w", window);
    if (horizonDays !== 1) next.set("h", String(horizonDays));
    if (next.toString() !== searchParams.toString()) {
      const query = next.toString();
      const profilePath = `/lb/x/${encodeURIComponent(authorKey)}`;
      router.replace(
        (query ? `${profilePath}?${query}` : profilePath) as Route,
        { scroll: false },
      );
    }
  }, [authorKey, horizonDays, router, searchParams, window]);

  const profileQuery = trpc.leaderboard.xCallerProfile.useQuery(
    {
      authorKey,
      window,
      horizonDays,
    },
    {
      enabled: isSignedIn,
    },
  );
  const followsQuery = trpc.copyTradeFollows.list.useQuery(undefined, {
    enabled: isSignedIn,
  });
  const profile = profileQuery.data;
  const profileState = describeProfileState({
    isSignedIn,
    isLoading: profileQuery.isLoading,
    errorCode: profileQuery.error
      ? (profileQuery.error.data?.code ?? "UNKNOWN_ERROR")
      : null,
    hasProfile: Boolean(profile),
    callCount: profile?.callCount ?? 0,
  });
  const assetCoverage = profile
    ? assetCoveragePresentation(profile.assetCoverage)
    : assetCoveragePresentation("stocks");
  const measurementNote = profile
    ? profileMeasurementNote(profile, horizonDays)
    : null;
  const comparable = profile?.measurementStatus !== "not_comparable";
  const isFollowing = (followsQuery.data ?? []).some(
    (follow) =>
      follow.targetType === "x_author" &&
      followMembershipKeys(follow).includes(profile?.followTarget.key ?? ""),
  );

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 flex justify-center border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 w-full max-w-[1400px] items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" className="gap-2" asChild>
              <Link href={leaderboardHref}>
                <ArrowLeft className="h-4 w-4" />
                Top Traders
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-primary" />
              <span className="text-sm font-semibold">Caller profile</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link href="/settings" aria-label="Settings">
                <Settings className="h-4 w-4" />
              </Link>
            </Button>
            <UserMenu />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        {profileState.kind === "signed_out" ? (
          <div role="status" className="py-16 text-center text-sm text-muted-foreground">
            {profileState.message}
          </div>
        ) : profileState.kind === "loading" ? (
          <ProfileSkeleton />
        ) : profileState.kind === "error" ? (
          <ProfileErrorState message={profileState.message} onRetry={() => void profileQuery.refetch()} />
        ) : profileState.kind === "not_found" ? (
          <ProfileNotFoundState leaderboardHref={leaderboardHref} />
        ) : profileState.kind === "empty" ? (
          <ProfileEmptyState leaderboardHref={leaderboardHref} />
        ) : !profile ? (
          <ProfileErrorState message="Could not load this caller profile. Try again." onRetry={() => void profileQuery.refetch()} />
        ) : (
          <div className="space-y-5">
            {profile.measurementStatus === "not_comparable" && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                This caller&apos;s detail is outside the newest {profile.signalScan?.cap ?? 5_000}-signal global scan. The metrics are unmeasured and not comparable to the leaderboard.
              </p>
            )}
            {profile.rankingFallback && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                Market data is unavailable, so forward-return metrics are unmeasured for this profile.
              </p>
            )}
            {measurementNote && profile.measurementStatus !== "not_comparable" && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                {measurementNote}
              </p>
            )}
            {profile.signalScan?.truncated && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                Rankings are partial: {profile.signalScan.retainedCount} signals were retained under the {profile.signalScan.cap}-signal scan cap, and older signals are excluded from this {window === "all" ? "all-history" : window} view.
              </p>
            )}
            {profile.partialMarketData && !profile.rankingFallback && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                Some market candidates were unavailable or intentionally omitted. The measured cards use only the available forward-return data.
              </p>
            )}
            {profile.marketDataHealth.capped && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                Market requests were capped at {profile.marketDataHealth.marketCap} distinct markets. {profile.marketDataHealth.omittedMarketCount} markets were intentionally omitted, separate from provider-unavailable markets.
              </p>
            )}
            {profile.marketDataHealth.unresolvedCandidateCount > 0 && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                {profile.marketDataHealth.unresolvedCandidateCount} retained candidates could not be resolved to a canonical market. They are separate from provider outages and intentional request caps.
              </p>
            )}
            {profile.marketDataHealth.deadlineMarketCount > 0 && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                {profile.marketDataHealth.deadlineMarketCount} started market requests were aborted at the leaderboard fetch deadline and are unavailable for this result.
              </p>
            )}
            {profile.marketDataHealth.skippedMarketCount > 0 && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                {profile.marketDataHealth.skippedMarketCount} market requests were skipped because the leaderboard fetch budget was exhausted; no provider request was started for those markets.
              </p>
            )}
            {profile.marketDataHealth.unavailableMarketCount > profile.marketDataHealth.deadlineMarketCount && (
              <p role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                Some provider markets were unavailable. The measured cards use only the available forward-return data.
              </p>
            )}
            <section className="flex min-w-0 flex-col gap-4 border-b pb-5 sm:flex-row sm:items-center">
              <Avatar size="lg" className="shrink-0">
                {profile.avatar && (
                  <AvatarImage src={profile.avatar} alt={profile.displayName} />
                )}
                <AvatarFallback>{initialsOf(profile.displayName) || "?"}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1 className="min-w-0 break-words text-xl font-semibold">{profile.displayName}</h1>
                  <Badge
                    variant="outline"
                    className={cn("shrink-0", assetCoverage.className)}
                    title={assetCoverage.title}
                  >
                    {assetCoverage.label}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Direction-adjusted ticker returns over {horizonDays}D, using caller signals from the {window === "all" ? "all-history" : window + " window"} scan. This is not account P&amp;L.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {profile.assetCallCounts.stocks} stock calls, {profile.assetCallCounts.perps} perp calls in this window.
                </p>
              </div>
              <FollowButton
                target={profile.followTarget}
                isFollowing={isFollowing}
              />
            </section>

            <section className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-6" aria-label="Caller profile metrics">
              <SummaryMetric
                label="Forward return"
                value={formatSignedNumber(comparable ? profile.avgForwardReturnPct : null, "%")}
                tone={comparable ? profile.avgForwardReturnPct : null}
              />
              <SummaryMetric
                label="Hit rate"
                value={formatHitRate(comparable ? profile.hitRate : null)}
              />
              <SummaryMetric label="Calls total" value={String(profile.callCount)} />
              <SummaryMetric
                label="Eligible"
                value={comparable ? String(profile.measurementCandidateCount) : "Not comparable"}
              />
              <SummaryMetric
                label="Measured"
                value={comparable ? profile.measuredCallCount + "/" + profile.measurementCallsRetainedCount : "Not comparable"}
              />
              <SummaryMetric
                label="Omitted by cap"
                value={comparable ? String(profile.measurementCandidateOmittedCount) : "Not comparable"}
              />
            </section>

            <div>
              <h2 className="text-base font-semibold">
                {profile.measurementStatus === "not_comparable"
                  ? "Author-scoped call detail"
                  : "Calls behind this score"}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {profile.measurementStatus === "not_comparable"
                  ? "These calls are shown for context only and are not used to produce a comparable leaderboard score."
                  : `These are the ${profile.measurementCallsRetainedCount} eligible calls retained for this score. Measured cards contribute to the aggregate; ${profile.measurementCandidateOmittedCount} eligible calls were omitted by the ${profile.measurementCallCap}-call cap. Returns are ticker moves adjusted for the detected direction, not the caller&apos;s option, leverage, entry price, or account P&amp;L.`}
              </p>
            </div>

            <section className="space-y-2" aria-label="Caller call history">
              {profile.calls.map((call) => {
                const measured = call.measurementStatus === "measured";
                const positive = (call.forwardReturnPct ?? 0) > 0;
                const negative = (call.forwardReturnPct ?? 0) < 0;
                const assetClass = assetClassPresentation(call.assetClass);
                const sourceUrl = safeExternalPostUrl(call.url);
                return (
                  <article key={call.id} className="rounded-md border p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="outline" className="shrink-0 font-data">
                        {call.symbol}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn("shrink-0", assetClass.className)}
                        title={assetClass.title}
                      >
                        {assetClass.label}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0",
                          call.direction === "bullish" && "border-green-500/30 text-green-500",
                          call.direction === "bearish" && "border-red-500/30 text-red-500",
                        )}
                      >
                        {directionLabel(call.direction)}
                      </Badge>
                      <time dateTime={call.calledAt} className="text-xs text-muted-foreground">
                        {formatCalledAt(call.calledAt)}
                      </time>
                      <div className="flex min-w-0 flex-[1_1_100%] flex-wrap items-center justify-between gap-2 sm:ml-auto sm:flex-[0_1_auto] sm:justify-end">
                        <Badge variant={measured ? "outline" : "secondary"}>
                          {measurementLabel(call.measurementStatus, horizonDays)}
                        </Badge>
                        {measured && (
                          <span
                            className={cn(
                              "font-data text-sm font-semibold tabular-nums",
                              positive && "text-green-500",
                              negative && "text-red-500",
                              !positive && !negative && "text-muted-foreground",
                            )}
                          >
                            {formatSignedNumber(call.forwardReturnPct, "%")}
                          </span>
                        )}
                      </div>
                    </div>
                    {!measured && (
                      <p className="mt-2 text-xs text-amber-500">
                        {STATUS_LABELS[call.measurementStatus] ?? "This call is not measured"}. {measurementLabel(call.measurementStatus, horizonDays)}.
                      </p>
                    )}
                    <p className="mt-2 break-words text-sm leading-relaxed text-foreground/90">
                      {call.content}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 max-w-full break-words">{call.source || "Source unavailable"}</span>
                      {sourceUrl ? (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          aria-label={`Read ${call.symbol} call on the original site`}
                          className="inline-flex min-h-11 shrink-0 items-center gap-1 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-0"
                        >
                          View source
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="shrink-0">Source link unavailable</span>
                      )}
                    </div>
                  </article>
                );
              })}
              {profile.calls.length === 0 && (
                <p role="status" className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                  No eligible directional call cards were retained for this score. The summary above explains why the metrics are unmeasured.
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

function SummaryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number | null;
}) {
  return (
    <div className="bg-background p-3">
      <p className="break-words text-3xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 break-words font-data text-lg font-semibold tabular-nums",
          tone !== undefined && tone !== null && tone > 0 && "text-green-500",
          tone !== undefined && tone !== null && tone < 0 && "text-red-500",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function ProfileErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-md border border-destructive/30 p-6 text-center text-sm text-destructive">
      <AlertTriangle className="size-5" aria-hidden="true" />
      <p>{message}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

function ProfileNotFoundState({ leaderboardHref }: { leaderboardHref: Route }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 rounded-md border p-6 text-center text-sm text-muted-foreground">
      <p>Caller profile not found. The link may be stale or this identity may no longer be available.</p>
      <Button variant="outline" asChild>
        <Link href={leaderboardHref}>Back to leaderboard</Link>
      </Button>
    </div>
  );
}

function ProfileEmptyState({ leaderboardHref }: { leaderboardHref: Route }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 rounded-md border p-6 text-center text-sm text-muted-foreground">
      <p>No calls are available for this profile in this window yet.</p>
      <Button variant="outline" asChild>
        <Link href={leaderboardHref}>Back to leaderboard</Link>
      </Button>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}
