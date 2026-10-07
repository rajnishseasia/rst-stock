"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A partial-failure notice that keeps the surface usable: whatever data did
 * arrive stays on screen, the reader is told in plain words that some of it is
 * missing, and there is a Retry that actually does something.
 *
 * Wording rules: no internal source names, no request ids, no "error" jargon.
 * A reader cannot act on "x_signal failed"; they can act on "some signals
 * could not be loaded".
 *
 * Retry is 44px tall on touch and collapses to the terminal's compact button
 * from `sm` up, the same stack `EmptyState` uses.
 */
export function DegradedNotice({
  message,
  onRetry,
  retrying = false,
  retryLabel = "Retry",
  className,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={retrying}
      data-degraded-notice="true"
      className={cn(
        "flex flex-col items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-center text-xs leading-5 text-amber-300 sm:flex-row sm:justify-between sm:text-left",
        className,
      )}
    >
      <p className="min-w-0">{message}</p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          onClick={onRetry}
          disabled={retrying}
          className="min-h-11 w-full shrink-0 px-3 sm:min-h-0 sm:w-auto sm:px-2"
        >
          <RefreshCw
            className={cn(
              "h-3.5 w-3.5",
              retrying && "motion-safe:animate-spin",
            )}
            aria-hidden="true"
          />
          {retrying ? "Retrying…" : retryLabel}
        </Button>
      )}
    </div>
  );
}
