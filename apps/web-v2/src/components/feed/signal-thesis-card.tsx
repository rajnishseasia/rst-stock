"use client";

/**
 * Plan S1. The caller's thesis, rendered on the chart screen.
 *
 * Before this, the mobile chart screen showed price and nothing else, so a user
 * who tapped a ticker chip in the feed arrived with the reason for the trade
 * left behind: the body was only reachable back in the card, behind the
 * "View more" toggle. The chart was the surface that answered "what is this"
 * while discarding "why am I looking at it".
 *
 * Reuses `SignalContent` and `SignalTimestamp` rather than restating them, so
 * the clamp, the "View more" toggle, the "View original" outbound link and the
 * timestamp tooltip behave identically here and in the feed.
 *
 * Display only. Nothing here constructs, validates or submits an order.
 */

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { DirectionBadge } from "./direction-badge";
import {
  SignalContent,
  SignalSourceLink,
  SignalTimestamp,
} from "./signal-content";
import { type SignalThesis } from "./signal-thesis";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export interface SignalThesisCardProps {
  thesis: SignalThesis;
  /** The signal body. Lives on the selection, not on the thesis, so there is
   *  exactly one copy of it in state. */
  content: string;
  /** Tap the author to open their record (plan S2). Omitted on surfaces that
   *  have nowhere to open it, in which case the name renders as plain text. */
  onOpenCaller?: (authorName: string) => void;
  className?: string;
}

export function SignalThesisCard({
  thesis,
  content,
  onOpenCaller,
  className,
}: SignalThesisCardProps) {
  const authorName = thesis.authorName.trim() || "Unknown";
  const initials = initialsOf(authorName);

  return (
    <section
      aria-label={`Why you are here: ${authorName}'s call`}
      className={cn(
        "rounded-2xl border border-primary/30 bg-primary/5 p-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Avatar size="sm" className="mt-0.5 shrink-0">
          {thesis.authorAvatar && (
            <AvatarImage src={thesis.authorAvatar} alt="" />
          )}
          <AvatarFallback>{initials || "?"}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {onOpenCaller ? (
              <button
                type="button"
                onClick={() => onOpenCaller(authorName)}
                className="min-h-11 min-w-0 max-w-full truncate text-left text-xs font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-0"
              >
                {authorName}
              </button>
            ) : (
              <span className="min-w-0 max-w-full truncate text-xs font-semibold text-foreground">
                {authorName}
              </span>
            )}
            <span
              aria-hidden="true"
              className="size-0.5 shrink-0 rounded-full bg-muted-foreground/40"
            />
            <SignalTimestamp timestamp={thesis.timestamp} />
            <SignalSourceLink url={thesis.url} embedded />
            {/* Only a STATED direction renders. A null direction means the
                caller never said which way, and inventing one here would put a
                fabricated claim under a chart that is one tap from a ticket. */}
            {thesis.direction && <DirectionBadge direction={thesis.direction} />}
          </div>
          <SignalContent
            content={content}
            imageUrl={thesis.imageUrl}
            embedded
          />
        </div>
      </div>
    </section>
  );
}
