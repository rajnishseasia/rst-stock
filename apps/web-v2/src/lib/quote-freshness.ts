export type QuoteFreshnessTone = "live" | "refreshing" | "stale" | "error" | "idle";

export type QuoteFreshnessState = {
  label: string;
  tone: QuoteFreshnessTone;
  isStale: boolean;
};

const DEFAULT_STALE_AFTER_MS = 90_000;

function formatAge(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function getQuoteFreshness({
  updatedAt,
  now = Date.now(),
  isFetching = false,
  hasError = false,
  enabled = true,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: {
  updatedAt?: number;
  now?: number;
  isFetching?: boolean;
  hasError?: boolean;
  enabled?: boolean;
  staleAfterMs?: number;
}): QuoteFreshnessState {
  if (!enabled) {
    return { label: "Quotes paused", tone: "idle", isStale: false };
  }

  if (hasError) {
    return { label: "Quote error", tone: "error", isStale: true };
  }

  if (!updatedAt) {
    return {
      label: isFetching ? "Refreshing quote..." : "Waiting for quote",
      tone: isFetching ? "refreshing" : "idle",
      isStale: false,
    };
  }

  const ageMs = now - updatedAt;
  const isStale = ageMs > staleAfterMs;
  const age = formatAge(ageMs);

  if (isFetching) {
    return { label: `Refreshing - last ${age}`, tone: "refreshing", isStale };
  }

  return {
    label: `${isStale ? "Stale" : "Updated"} ${age}`,
    tone: isStale ? "stale" : "live",
    isStale,
  };
}
