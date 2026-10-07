"use client";

import { WifiOff } from "lucide-react";

import { DegradedNotice } from "@/components/ui/degraded-notice";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * What the signal feed shows when it could not (fully) reach the API.
 *
 * Two shapes, chosen by whether anything is already on screen:
 *
 *  - Nothing loaded: the full empty-state treatment (icon, heading, plain
 *    explanation, one action), the same pattern the Account screen uses for
 *    "no broker connected". A bare amber sentence above 300px of blank screen
 *    read as a broken page rather than a known state.
 *  - Signals already loaded: a slim notice above them, so the reader keeps
 *    what came through and can see it is not the whole story.
 *
 * Both retry. The feed also retries on its own poll and the copy says so, but
 * "retrying automatically" on its own leaves the reader with nothing to do.
 */
export function FeedUnavailableState({
  hasSignals,
  onRetry,
  retrying = false,
}: {
  hasSignals: boolean;
  onRetry: () => void;
  retrying?: boolean;
}) {
  if (hasSignals) {
    return (
      <DegradedNotice
        message="Some signals could not be loaded. Showing what came through; the feed keeps retrying on its own."
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }
  return (
    <EmptyState
      fill
      icon={WifiOff}
      title="Signals could not be loaded"
      body="We could not reach the signal feed just now. It retries on its own every few seconds, or you can try again right away."
      actions={[
        { label: retrying ? "Retrying…" : "Try again", onClick: onRetry },
      ]}
      className="py-12"
    />
  );
}
