"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Eye, EyeOff, ImageIcon } from "lucide-react";
import { format } from "date-fns";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatSignalAge } from "./signal-thesis";
import { safeExternalPostUrl } from "./signal-feed-utils";

/**
 * Strips leading runs of repeated "x" characters that some signal sources
 * prepend to tweet content (e.g. censored @-mentions or retweet prefixes
 * that look like "xxxxxxxx $TSLA ...").
 *
 * The run must be a standalone token (whitespace or end of string after it),
 * so a word that merely starts with x's, like "xxxxtreme", is left alone.
 *
 * Case matters, because an uppercase run can be a real identifier rather than
 * an artifact:
 *   - lowercase "x" needs 4 or more. The observed artifact is lowercase, and
 *     tickers are written uppercase, so there is no realistic collision.
 *   - uppercase "X" needs 6 or more, one past the 5-character ceiling for a
 *     US equity symbol. That keeps "XXX" and "XXXX" intact whether they are
 *     tickers or ordinary text.
 */
export function cleanSignalContent(content: string): string {
  return content.replace(/^(?:(?:x{4,}|X{6,})(?:\s+|$))+/, "");
}

/** Labels for the signal body's secondary actions. */
export const VIEW_MORE_LABEL = "View more";
export const VIEW_LESS_LABEL = "View less";
export const VIEW_ORIGINAL_LABEL = "View original";
export const VIEW_IMAGE_LABEL = "View image";

/** Toggle label for the clamped tweet body. */
export function signalContentToggleLabel(expanded: boolean): string {
  return expanded ? VIEW_LESS_LABEL : VIEW_MORE_LABEL;
}

/**
 * Whether the body needs its secondary action row at all. A short signal with
 * no link and no image renders without a redundant button row.
 */
export function shouldShowSignalActions({
  overflowing,
  expanded,
  imageUrl,
}: {
  overflowing: boolean;
  expanded: boolean;
  imageUrl?: string | null;
}): boolean {
  return !!(overflowing || expanded || imageUrl);
}

/**
 * Class stack for one secondary action. Embedded (terminal / mobile shell)
 * actions carry a 44px minimum touch target below xl and shrink to the dense
 * terminal size at xl.
 */
export function signalActionClassName(embedded: boolean): string {
  return cn(
    "inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    embedded
      ? "min-h-11 text-muted-foreground hover:text-foreground xl:min-h-6 xl:text-2xs"
      : "text-primary",
  );
}

/**
 * Tweet/signal body that clamps to a few lines and reveals the rest behind a
 * "View more" toggle. The toggle only appears when the text actually overflows
 * the clamp, so short signals render without a redundant button. The button
 * stops click propagation because the whole card is itself clickable.
 */
export function SignalContent({
  content,
  imageUrl,
  embedded = false,
}: {
  content: string;
  imageUrl?: string | null;
  embedded?: boolean;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      // Measure against the clamped state, so temporarily ignore expansion.
      const wasExpanded = el.classList.contains("line-clamp-none");
      if (wasExpanded) return; // already expanded; keep the toggle visible
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [content]);

  const actionClassName = signalActionClassName(embedded);

  return (
    <div className="min-w-0">
      <p
        ref={ref}
        className={cn(
          "break-words whitespace-pre-wrap text-sm text-muted-foreground",
          embedded && "xl:text-[13px] xl:leading-5",
          // Embedded rows clamp tighter so more calls fit a viewport; the
          // standalone card keeps the roomier clamp. "View more" still reveals
          // everything either way.
          expanded
            ? "line-clamp-none"
            : embedded
              ? "line-clamp-3 xl:line-clamp-2"
              : "line-clamp-4",
        )}
      >
        {cleanSignalContent(content)}
      </p>
      {shouldShowSignalActions({ overflowing, expanded, imageUrl }) && (
        <div
          className={cn(
            "mt-1 flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1",
            embedded
              ? "xl:mt-0.5 xl:min-h-0 xl:gap-x-3"
              : "sm:min-h-0",
          )}
        >
          {(overflowing || expanded) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className={actionClassName}
            >
              {expanded ? (
                <EyeOff className="size-3.5" aria-hidden />
              ) : (
                <Eye className="size-3.5" aria-hidden />
              )}
              {signalContentToggleLabel(expanded)}
            </button>
          )}
          {imageUrl && (
            <a
              href={imageUrl}
              target="_blank"
              rel="noreferrer"
              className={actionClassName}
              onClick={(event) => event.stopPropagation()}
            >
              <ImageIcon className="size-3.5" aria-hidden />
              {VIEW_IMAGE_LABEL}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Source link rendered beside the signal timestamp instead of below the body.
 * Embedded rows drop the text label and keep the icon: the header line shares
 * its width with the author, badge and age, and the accessible name survives
 * via aria-label.
 */
export function SignalSourceLink({
  url,
  embedded = false,
}: {
  url?: string | null;
  embedded?: boolean;
}) {
  const safeUrl = safeExternalPostUrl(url);
  if (!safeUrl) return null;
  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={embedded ? VIEW_ORIGINAL_LABEL : undefined}
      className={signalActionClassName(embedded)}
      onClick={(event) => event.stopPropagation()}
    >
      <ExternalLink className="size-3.5" aria-hidden />
      {!embedded && VIEW_ORIGINAL_LABEL}
    </a>
  );
}

/**
 * Compact relative timestamp ("2h ago") that reveals the absolute date/time in
 * a tooltip on hover/focus. Uses `formatSignalAge` rather than date-fns'
 * `formatDistanceToNow` so the header line is not spent on "about 2 hours ago"
 * prose; the exact moment stays one hover away. Left uncontrolled so Radix
 * drives open purely from pointer/focus - the same pattern as the working
 * tooltips in trade-form. The click only stops propagation so tapping the time
 * doesn't also select the underlying signal card.
 */
export function SignalTimestamp({
  timestamp,
  embedded = false,
}: {
  timestamp: string | number | Date;
  embedded?: boolean;
}) {
  const date = new Date(timestamp);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "shrink-0 cursor-default text-xs tabular-nums text-muted-foreground/80",
            embedded &&
              "-my-3 inline-flex min-h-11 min-w-11 items-center justify-center xl:my-0 xl:min-h-0 xl:min-w-0 xl:text-2xs",
          )}
        >
          {formatSignalAge(date)}
        </button>
      </TooltipTrigger>
      <TooltipContent>{format(date, "PPpp")}</TooltipContent>
    </Tooltip>
  );
}
