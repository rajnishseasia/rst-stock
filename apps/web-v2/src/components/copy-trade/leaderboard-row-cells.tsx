"use client";

/**
 * Row-level cell components for the leaderboard tabs.
 * These are self-contained display components with no query state.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TOUCH_HEIGHT_COMPACT } from "@/components/ui/touch-target";
import { cn } from "@/lib/utils";
import { formatChangePct, formatSignedUsd } from "@/lib/format";
import { ChangeBadge } from "@/components/ui/change-badge";
import { FollowButton } from "./follow-button";
import { assetCoveragePresentation } from "./asset-coverage";
import { safeExternalPostUrl } from "@/components/feed/signal-feed-utils";
import type { SelfStandingPresentation } from "./leaderboard-self";
import type {
  XCallerRow,
  UserRow,
  LeaderboardWindow,
  UsersSortBy,
  XHorizon,
  XSortBy,
} from "./use-leaderboard-view";

// ============================================
// Format helpers
// ============================================

/** A fraction in [0,1] rendered as a percent, or "-" when null/non-finite. */
export function formatPercentFromFraction(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(0)}%`;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function formatXCallerMeasurementCoverage(
  row: Pick<
    XCallerRow,
    | "callCount"
    | "measurementCandidateCount"
    | "measuredCallCount"
    | "measurementCandidateOmittedCount"
  >,
): string {
  return `${row.callCount} total, ${row.measurementCandidateCount} eligible, ${row.measuredCallCount} measured, ${row.measurementCandidateOmittedCount} omitted by cap`;
}

/** Build the profile href from the server's canonical follow key. */
export function buildCallerProfileHref(
  target: Pick<XCallerRow["followTarget"], "key">,
  window: LeaderboardWindow,
  horizonDays: XHorizon,
) {
  const key = target.key.trim();
  if (!key) return null;
  const query: Record<string, string> = {};
  if (window !== "30d") query.w = window;
  if (horizonDays !== 1) query.h = String(horizonDays);
  return {
    pathname: "/lb/x/" + encodeURIComponent(key),
    query,
  };
}

/**
 * Route to a platform user's Hyperliquid profile without exposing a raw user id.
 * Uses the readable profile slug (X handle, else the deterministic pseudonym);
 * `followTarget.key` stays the collision-resistant follow key and is only the
 * fallback for a cached row served before slugs existed.
 */
export function buildUserProfileHref(
  row: Pick<UserRow, "profileSlug"> & { followTarget: Pick<UserRow["followTarget"], "key"> },
  tab?: "fills",
) {
  const segment = row.profileSlug?.trim() || row.followTarget.key;
  return {
    pathname: `/lb/users/${encodeURIComponent(segment)}`,
    ...(tab ? { query: { t: tab } } : {}),
  };
}

// ============================================
// Shared primitive cells
// ============================================

/** A right-aligned labelled metric cell. */
export function Metric({ label, children }: { label: string; children: ReactNode }) {
  // min-w (not a fixed w-16) so a long P&L / "123/456 measured" sublabel grows
  // the cell instead of wrapping or clipping on narrow phones.
  return (
    <div className="flex min-w-16 flex-col items-end gap-0.5">
      <span className="text-3xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="whitespace-nowrap text-sm">{children}</div>
    </div>
  );
}

/** A rank pill (#1, #2, ...). Top three get a subtle accent. */
export function RankBadge({ rank }: { rank: number }) {
  return (
    <Badge
      variant={rank <= 3 ? "default" : "outline"}
      className="h-6 w-7 shrink-0 justify-center tabular-nums"
    >
      {rank}
    </Badge>
  );
}

/** A dash with the exact reason a row has no measured result. */
export function UnavailableMetric({ reason }: { reason: string }) {
  // Radix tooltips open on hover/focus only, so on a touch screen the reason was
  // unreachable. Control the open state and also open it on tap; the trigger is a
  // real <button> so it's focusable (keyboard) and tappable (touch).
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={reason}
          onClick={() => setOpen(true)}
          className="inline-flex cursor-help items-center bg-transparent p-0 text-muted-foreground"
        >
          -
        </button>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Plan S5. Accessible name for the outbound source link. Icon-only controls
 * inherit no name from their glyph, and twenty rows each announcing "link" is
 * a list a screen-reader user cannot navigate, so the caller goes in the label.
 */
export function callerSourceLinkLabel(displayName: string): string {
  const name = displayName.trim() || "this caller";
  return `Read ${name}'s latest call on the original site`;
}

/**
 * Out to the call as it was actually posted.
 *
 * The caller's name next to this goes INWARD, to our reconstruction of their
 * record. This goes to the primary source behind that reconstruction, which is
 * the whole reason a signal-derived leaderboard beats a wallet-derived one: an
 * address never published anything to link to.
 *
 * Renders nothing without a URL. The server only emits one when the newest
 * retained call carried a post-specific link, so this never lands on a board
 * homepage pretending to be evidence.
 */
export function CallerSourceLink({
  url,
  displayName,
}: {
  url: string | null | undefined;
  displayName: string;
}) {
  const safeUrl = safeExternalPostUrl(url);
  if (!safeUrl) return null;
  const label = callerSourceLinkLabel(displayName);
  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      aria-label={label}
      title={label}
      className={cn(
        TOUCH_HEIGHT_COMPACT,
        "inline-flex shrink-0 items-center justify-center rounded-md px-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

// ============================================
// XCallerRow
// ============================================

export function XCallerRowCard({
  rank,
  row,
  window,
  horizonDays,
  isFollowing,
}: {
  rank: number;
  row: XCallerRow;
  window: LeaderboardWindow;
  horizonDays: XHorizon;
  sortBy?: XSortBy;
  isFollowing: boolean;
}) {
  const assetCoverage = assetCoveragePresentation(row.assetCoverage);
  const hasMeasuredResult =
    row.measuredCallCount > 0 &&
    row.avgForwardReturnPct !== null &&
    row.hitRate !== null;
  const unavailableReason = [
    row.needsMarketData ? "Market data unavailable" : null,
    row.measurementCandidateOmittedCount > 0
      ? `${row.measurementCandidateOmittedCount} eligible calls omitted by the ${row.measurementCallCap}-call measurement cap`
      : null,
  ]
    .filter(Boolean)
    .join("; ") ||
    (row.directionalCallCount === 0
      ? "Direction unclear for these calls"
      : `Waiting for a complete forward result at the ${horizonDays}D horizon`);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5 transition-colors hover:bg-muted/50">
      <RankBadge rank={rank} />
      <Avatar size="default">
        {row.avatar && <AvatarImage src={row.avatar} alt={row.displayName} />}
        <AvatarFallback>{initialsOf(row.displayName) || "?"}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-center gap-2">
        <Link
          href={
            buildCallerProfileHref(row.followTarget, window, horizonDays) ??
            "/lb"
          }
          className="min-w-0 max-w-full flex-[1_1_8rem] break-words text-sm font-medium hover:text-primary hover:underline"
          title={"View " + row.displayName + " call history"}
        >
          {row.displayName}
        </Link>
        <Badge
          variant="outline"
          className={cn(
            "h-4 px-1.5 text-3xs uppercase tracking-wide",
            assetCoverage.className,
          )}
          title={assetCoverage.title}
        >
          {assetCoverage.label}
        </Badge>
        {/* Plan S5. The row's one outbound link (see CallerSourceLink). */}
        <CallerSourceLink
          url={row.latestCallUrl}
          displayName={row.displayName}
        />
      </div>

      <FollowButton target={row.followTarget} isFollowing={isFollowing} />

      <div className="flex w-full items-center justify-end gap-3 sm:w-auto sm:gap-4">
        <Metric label="Fwd return">
          {hasMeasuredResult ? (
            <ChangeBadge
              className="font-data font-semibold"
              {...formatChangePct(row.avgForwardReturnPct)}
            />
          ) : (
            <UnavailableMetric reason={unavailableReason} />
          )}
        </Metric>
        <Metric label="Hit rate">
          {hasMeasuredResult ? (
            <span className="tabular-nums font-medium">
              {formatPercentFromFraction(row.hitRate)}
            </span>
          ) : (
            <UnavailableMetric reason={unavailableReason} />
          )}
        </Metric>
        <Metric label="Calls">
          <span
            className="flex flex-col items-end tabular-nums"
            title={formatXCallerMeasurementCoverage(row)}
          >
            <span className="font-medium">{row.callCount} total</span>
            <span className="text-3xs leading-none text-muted-foreground">
              {row.measurementCandidateCount} eligible / {row.measurementCallsRetainedCount} retained
            </span>
            <span className="text-3xs leading-none text-muted-foreground">
              {row.measuredCallCount} measured
            </span>
            <span
              className={cn(
                "text-3xs leading-none",
                row.measurementCandidateOmittedCount > 0
                  ? "text-amber-500"
                  : "text-muted-foreground",
              )}
            >
              {row.measurementCandidateOmittedCount} omitted by cap
            </span>
          </span>
        </Metric>
      </div>
    </div>
  );
}

// ============================================
// UserRow
// ============================================

export function UserRowCard({
  rank,
  row,
  isFollowing,
  isSelf = false,
}: {
  rank: number;
  row: UserRow;
  isFollowing: boolean;
  window?: LeaderboardWindow;
  sortBy?: UsersSortBy;
  /**
   * Plan A11. The signed-in caller's own row. Accented, labelled YOU, and
   * WITHOUT a Follow control: copying your own trades is not a thing, and the
   * button would post a follow against your own traderKey.
   */
  isSelf?: boolean;
}) {
  const isUp = row.realizedPnl > 0;
  const isDown = row.realizedPnl < 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border p-2.5 transition-colors",
        isSelf
          ? "border-primary/50 bg-primary/5"
          : "hover:bg-muted/50",
      )}
    >
      <RankBadge rank={rank} />
      <Avatar size="default">
        {row.avatar && <AvatarImage src={row.avatar} alt={row.displayName} />}
        <AvatarFallback>{initialsOf(row.displayName) || "?"}</AvatarFallback>
      </Avatar>
      <Link
        href={buildUserProfileHref(row)}
        className="min-w-0 flex-1 break-words text-sm font-medium transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        title={`View ${row.displayName}'s Hyperliquid profile`}
      >
        {row.displayName}
        {row.twitterHandle && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">@{row.twitterHandle}</span>
        )}
        {isSelf && (
          <Badge className="ml-2 h-4 px-1 text-3xs uppercase tracking-wide">
            You
          </Badge>
        )}
      </Link>

      {row.hasHyperliquid && (
        <Link
          href={buildUserProfileHref(row, "fills")}
          aria-label={`View ${row.displayName}'s perp trades`}
          title={`View ${row.displayName}'s perp trades`}
          className={cn(
            TOUCH_HEIGHT_COMPACT,
            "inline-flex shrink-0 items-center justify-center rounded-md px-2 text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:hidden",
          )}
        >
          Perp trades
        </Link>
      )}

      {!isSelf && row.hasHyperliquid && (
        <FollowButton target={row.followTarget} isFollowing={isFollowing} />
      )}

      <div className="flex w-full items-center justify-end gap-3 sm:w-auto sm:gap-4">
        <Metric label="P&L">
          <span
            className={cn(
              "font-data tabular-nums font-semibold",
              isUp && "text-green-500",
              isDown && "text-red-500",
              !isUp && !isDown && "text-muted-foreground",
            )}
          >
            {formatSignedUsd(row.realizedPnl)}
          </span>
          {(row.alpacaPnl !== 0 || row.hasHyperliquid || row.hyperliquidPnl !== 0) && (
            <span className="mt-0.5 flex gap-1.5 text-3xs text-muted-foreground">
              <span>Stocks {formatSignedUsd(row.alpacaPnl)}</span>
              {(row.hasHyperliquid || row.hyperliquidPnl !== 0) && (
                <span>HL {formatSignedUsd(row.hyperliquidPnl)}</span>
              )}
            </span>
          )}
        </Metric>
        <Metric label="Win rate">
          <span className="tabular-nums font-medium">
            {formatPercentFromFraction(row.winRate)}
          </span>
        </Metric>
        <Metric label="Trades">
          <span className="tabular-nums font-medium">{row.tradeCount}</span>
        </Metric>
      </div>
    </div>
  );
}

/**
 * Plan A11. The caller's own standing, pinned above the ranking whatever their
 * rank, including no rank at all. Rendered from a pure presentation decision
 * (`describeSelfStanding`) so the honest-copy rules live somewhere testable.
 */
export function SelfStandingRow({
  presentation,
  window = "all",
  sortBy = "pnl",
}: {
  presentation: SelfStandingPresentation;
  window?: LeaderboardWindow;
  sortBy?: UsersSortBy;
}) {
  if (presentation.kind === "hidden") return null;

  if (presentation.kind === "ranked") {
    return (
      <UserRowCard
        rank={presentation.rank}
        row={presentation.row}
        isFollowing={false}
        isSelf
        window={window}
        sortBy={sortBy}
      />
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/50 bg-primary/5 p-2.5">
      <Badge className="h-6 shrink-0 px-1.5 text-3xs uppercase tracking-wide">
        You
      </Badge>
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        {presentation.note}
      </p>
    </div>
  );
}
