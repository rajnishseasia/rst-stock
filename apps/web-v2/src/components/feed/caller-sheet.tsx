"use client";

/**
 * Plan S2. The caller, as an object you can open.
 *
 * Before this the author was a `<span>`. The only thing a reader could do with a
 * caller was find them in a dropdown of 28px checkbox rows, inside a scroller
 * inside a scroller, and hide them. There was no "only this caller", no
 * mute-from-the-row, no follow, and no way to see whether the person whose call
 * you are about to copy has ever been right.
 *
 * This is the differentiator stated plainly: Bullpen's analogue attaches a
 * Follow to an ADDRESS. Ours attaches to a person with a published, measured
 * record, and the record is one tap from the call that made you curious.
 *
 * Display and preferences only. Nothing here constructs, validates or submits an
 * order.
 */

import { createPortal } from "react-dom";
import Link from "next/link";
import { ExternalLink, TrendingUp, X } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangeBadge } from "@/components/ui/change-badge";
import { FollowButton } from "@/components/copy-trade/follow-button";
import { safeExternalPostUrl } from "./signal-feed-utils";
import { useFollowedKeys } from "@/components/copy-trade/use-leaderboard-view";
import {
  isOnlyAuthor,
  muteActionLabel,
  onlyActionLabel,
  type CallerFilter,
} from "./caller-filter";
import { formatSignalAge } from "./signal-thesis";
import {
  describeCallerRecord,
  type CallerRecordInput,
} from "./caller-record";

/** Window and horizon the sheet measures over. Matches the leaderboard's own
 *  defaults so the number here cannot disagree with the number there. */
const SHEET_WINDOW = "30d" as const;
const SHEET_HORIZON = 1;

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export interface CallerSheetProps {
  /** Display name as the feed renders it. */
  authorName: string;
  /**
   * The SERVER's key for this author (`signalAuthorKey`), or null when the row
   * has no attributable author. Null disables the record and the Follow: a
   * follow written under a guessed key is a follow that never fires.
   */
  authorKey: string | null;
  authorAvatar: string | null;
  isSignedIn: boolean;
  filter: CallerFilter;
  onToggleOnly: () => void;
  onToggleMute: () => void;
  onClose: () => void;
}

export function CallerSheet({
  authorName,
  authorKey,
  authorAvatar,
  isSignedIn,
  filter,
  onToggleOnly,
  onToggleMute,
  onClose,
}: CallerSheetProps) {
  // Escape closes. The sheet is a modal surface on top of a scrolling feed, and
  // on desktop the feed sits in a terminal pane where there is no obvious
  // "outside" to tap.
  // Shared with the trade sheet: see `use-modal-focus`.
  const sheetRef = useModalFocus({ onClose });

  const followedKeys = useFollowedKeys(isSignedIn);
  const profileQuery = trpc.leaderboard.xCallerProfile.useQuery(
    { authorKey: authorKey ?? "", window: SHEET_WINDOW, horizonDays: SHEET_HORIZON },
    {
      enabled: isSignedIn && !!authorKey,
      // The caller's measured record moves on the leaderboard's cadence, not the
      // feed's. Refetching it while a sheet is open would buy nothing.
      staleTime: 5 * 60_000,
      refetchInterval: false,
      retry: false,
    },
  );

  const record = describeCallerRecord({
    isSignedIn,
    hasKey: !!authorKey,
    isLoading: profileQuery.isLoading,
    // NOT_FOUND is the router saying it looked and found no measured window,
    // which is a fact about the caller. Anything else means we never found out,
    // and must not be rendered as though the caller had been quiet.
    //
    // The sentinel matters: a TRANSPORT failure has an error but no
    // `error.data.code`, so reading the code alone produced null, which is the
    // value for "no error at all", and the caller was reported quiet because
    // the network dropped. An error without a code is still an error.
    errorCode: profileQuery.error
      ? (profileQuery.error.data?.code ?? "UNKNOWN_ERROR")
      : null,
    profile: profileQuery.data as CallerRecordInput["profile"],
    horizonDays: SHEET_HORIZON,
  });

  const narrowed = isOnlyAuthor(filter, authorName);

  const sheet = (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end">
      <div
        aria-hidden="true"
        className="absolute inset-0 touch-none bg-background/60 supports-backdrop-filter:bg-background/40 supports-backdrop-filter:backdrop-blur-sm"
        onClick={onClose}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${authorName}: caller record and filters`}
        className="relative flex max-h-[85dvh] w-full min-w-0 flex-col overflow-hidden rounded-t-2xl border-t bg-background shadow-floating sm:mx-auto sm:max-w-md sm:rounded-2xl sm:border"
      >
        <header className="flex shrink-0 items-start gap-3 border-b p-4">
          <Avatar size="lg" className="shrink-0">
            {authorAvatar && <AvatarImage src={authorAvatar} alt="" />}
            <AvatarFallback>{initialsOf(authorName) || "?"}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="truncate text-sm font-semibold">{authorName}</h2>
            <p className="text-xs text-muted-foreground">{record.summary}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close caller"
            onClick={onClose}
            className="h-11 w-11 shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          <section aria-label="Measured record" className="space-y-2">
            {record.kind === "loading" ? (
              <div className="grid grid-cols-3 gap-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : record.kind === "measured" ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {record.metrics.map((metric) => (
                    <div
                      key={metric.label}
                      className="rounded-xl border bg-card/60 p-2 text-center"
                    >
                      <div className="text-3xs uppercase tracking-wide text-muted-foreground">
                        {metric.label}
                      </div>
                      {metric.tone === "neutral" ? (
                        <div className="font-data text-sm font-semibold tabular-nums">
                          {metric.value}
                        </div>
                      ) : (
                        <div className="flex justify-center">
                          <ChangeBadge
                            className="font-data font-semibold"
                            text={metric.value}
                            tone={metric.tone}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-2xs leading-tight text-muted-foreground">
                  {record.caveat}
                </p>
              </>
            ) : (
              <p className="rounded-xl border bg-card/50 px-3 py-4 text-center text-xs text-muted-foreground">
                {record.note}
              </p>
            )}
          </section>

          {profileQuery.data && profileQuery.data.calls.length > 0 && (
            <section aria-label="Recent calls" className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recent calls
              </h3>
              <ul className="space-y-2">
                {profileQuery.data.calls.slice(0, 5).map((call) => (
                  <li
                    key={call.id}
                    className="rounded-xl border bg-card/50 p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="h-5 shrink-0 font-data">
                        {call.symbol}
                      </Badge>
                      <span className="text-2xs text-muted-foreground">
                        {formatSignalAge(call.calledAt)}
                      </span>
                      {/* A site-root URL is not evidence for THIS call: the
                          paste.trade poller stamps every row with the same board
                          root, so linking it offers a homepage as the source of
                          an individual call. Same predicate the leaderboard's
                          `latestCallSourceUrl` uses, for the same reason. */}
                      {safeExternalPostUrl(call.url) && (
                        <a
                          href={safeExternalPostUrl(call.url) ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Read the ${call.symbol} call on the original site`}
                          className="ml-auto inline-flex min-h-11 shrink-0 items-center text-muted-foreground hover:text-foreground sm:min-h-0"
                        >
                          <ExternalLink className="size-3.5" aria-hidden />
                        </a>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-3 break-words text-xs text-muted-foreground">
                      {call.content}
                    </p>
                  </li>
                ))}
              </ul>
              {authorKey && (
                <Link
                  href={`/lb/x/${encodeURIComponent(authorKey)}`}
                  className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <TrendingUp className="size-3.5" aria-hidden />
                  See the full call history
                </Link>
              )}
            </section>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t p-4">
          <Button
            type="button"
            variant={narrowed ? "default" : "outline"}
            className="h-11 flex-1 text-sm"
            aria-pressed={narrowed}
            onClick={onToggleOnly}
          >
            {onlyActionLabel(filter, authorName)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1 text-sm"
            onClick={onToggleMute}
          >
            {muteActionLabel(filter, authorName)}
          </Button>
          {/* No key, no Follow. A follow row written under a guessed key matches
              no feed item and never fires, which looks identical to a working
              follow that simply has not triggered yet. */}
          {authorKey && (
            <FollowButton
              target={{ type: "x_author", key: authorKey, label: authorName }}
              isFollowing={followedKeys.has(`x_author|${authorKey}`)}
            />
          )}
        </footer>
      </section>
    </div>
  );

  // Portalled to the body. The feed renders inside a Card that is
  // `overflow-hidden` in embedded mode and, on the terminal, inside a resizable
  // pane; a `fixed` element still gets clipped by an ancestor's overflow, and it
  // is positioned against any ancestor that carries a transform rather than
  // against the viewport. A modal cannot depend on the layout of the pane that
  // happened to open it.
  return typeof document === "undefined"
    ? sheet
    : createPortal(sheet, document.body);
}
