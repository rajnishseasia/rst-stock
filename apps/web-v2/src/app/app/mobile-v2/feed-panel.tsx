"use client";

import type { ReactNode } from "react";

/** The venue scope applied by the production signal-feed controller. */
export type MobileFeedVenueFilter = "all" | "stocks" | "perps";

/**
 * The feed's top-level transport state. SignalFeed owns the query and its
 * detailed loading/empty/pagination states; this value only gives the mobile
 * panel a concise, accessible announcement for the outer shell.
 */
export type MobileFeedStatus = "loading" | "live" | "ready" | "degraded";

export interface MobileFeedPanelProps {
  /** A mounted VenueAwareSignalFeed, including all production callbacks. */
  signalFeed: ReactNode;
  /** Controlled All/Stocks/Perps scope, owned by the application controller. */
  venueFilter: MobileFeedVenueFilter;
  /** Whether this deployment has the Perps venue wired and available. */
  perpsAvailable?: boolean;
  /** Updates the controller's existing signal-feed scope. */
  onVenueFilterChange: (filter: MobileFeedVenueFilter) => void;
  /** Outer transport state, not a second feed query. */
  status?: MobileFeedStatus;
}

const VENUE_FILTERS: ReadonlyArray<{
  value: MobileFeedVenueFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "stocks", label: "Stocks" },
  { value: "perps", label: "Perps" },
];

/** Filter controls exposed by the feed for the current deployment. */
export function visibleMobileFeedVenueFilters(
  perpsAvailable: boolean,
): ReadonlyArray<{ value: MobileFeedVenueFilter; label: string }> {
  return perpsAvailable
    ? VENUE_FILTERS
    : VENUE_FILTERS.filter((filter) => filter.value !== "perps");
}

/** Resolve a persisted or otherwise stale scope against deployment capability. */
export function normalizeMobileFeedVenueFilter(
  venueFilter: MobileFeedVenueFilter,
  perpsAvailable: boolean,
): MobileFeedVenueFilter {
  return !perpsAvailable && venueFilter === "perps" ? "all" : venueFilter;
}

function statusMessage(status: MobileFeedStatus): string | null {
  if (status === "loading") return "Loading live signals…";
  if (status === "degraded") {
    return "Signal feed is degraded. Retrying automatically.";
  }
  return null;
}

function statusLabel(status: MobileFeedStatus): string {
  if (status === "loading") return "Syncing";
  if (status === "degraded") return "Degraded";
  if (status === "ready") return "Ready";
  return "Live";
}

function statusIndicatorClass(status: MobileFeedStatus): string {
  if (status === "loading") {
    return "bg-[#8da5ad] motion-safe:animate-pulse motion-reduce:animate-none";
  }
  if (status === "degraded") return "bg-[#d8b35a]";
  if (status === "ready") return "bg-[#8da5ad]";
  return "bg-[#e7c65d] shadow-[0_0_0_3px_rgba(231,198,93,0.12)]";
}

function statusLabelClass(status: MobileFeedStatus): string {
  if (status === "degraded") return "text-[#d8b35a]";
  if (status === "ready" || status === "loading") return "text-[#a9bbc1]";
  return "text-[#e7c65d]";
}

/**
 * The Feed tab of the mobile Traders destination.
 *
 * This is intentionally a presentational boundary. The controller supplies a
 * real VenueAwareSignalFeed element, and that element remains the sole owner
 * of signals.list, polling, pagination, author filters, quote windows, and
 * stock/perp selection callbacks.
 *
 * It used to be a destination of its own, with its own screen wrapper and
 * heading; the Traders screen owns those now, so this panel starts at the
 * venue scope beside the transport status, and the signals start directly
 * under it. It grows (`flex-1`) so the feed's empty state can center in the
 * shell's slack, and is never bounded: a long feed overflows into the shell's
 * `main`, which stays the only scroller.
 */
export function MobileFeedPanel({
  signalFeed,
  venueFilter,
  perpsAvailable = false,
  onVenueFilterChange,
  status,
}: MobileFeedPanelProps) {
  const announcement = status ? statusMessage(status) : null;
  const visibleFilters = visibleMobileFeedVenueFilters(perpsAvailable);
  const normalizedVenueFilter = normalizeMobileFeedVenueFilter(
    venueFilter,
    perpsAvailable,
  );

  return (
    <div
      data-testid="mobile-feed-panel"
      data-mobile-feed-status={status}
      className="flex min-w-0 flex-1 flex-col"
    >
      <div
        data-mobile-feed-header="true"
        className="flex shrink-0 items-center gap-2 pb-2"
      >
        <div
          role="group"
          aria-label="Filter signals by venue"
          data-mobile-feed-scope={normalizedVenueFilter}
          // A flat strip on a hairline, the same system as the Traders strip
          // above it: the selected scope is brighter text over a gold rule,
          // not a gold-filled segment (DESIGN.md: gold is a seasoning).
          className={`grid min-w-0 flex-1 ${visibleFilters.length === 2 ? "grid-cols-2" : "grid-cols-3"} border-b border-[#1a3b46]`}
        >
          {visibleFilters.map(({ value, label }) => {
            const selected = normalizedVenueFilter === value;
            return (
              <button
                key={value}
                type="button"
                aria-label={label}
                aria-pressed={selected}
                data-state={selected ? "active" : "inactive"}
                onClick={() => onVenueFilterChange(value)}
                className={
                  selected
                    ? "relative min-h-11 min-w-0 px-2 text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
                    : "relative min-h-11 min-w-0 px-2 text-sm font-medium text-[#8da5ad] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
                }
              >
                {label}
                {selected ? (
                  <span
                    aria-hidden="true"
                    data-mobile-feed-scope-rule="true"
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#e7c65d]"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        {status ? (
          <div
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-[#665b28]/70 bg-[#272414]/60 px-2.5"
            aria-label={`${statusLabel(status)} feed status`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${statusIndicatorClass(status)}`}
            />
            <span
              data-mobile-feed-live-indicator="true"
              className={`font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${statusLabelClass(status)}`}
            >
              {statusLabel(status)}
            </span>
          </div>
        ) : null}
      </div>

      {announcement ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="mobile-feed-status"
          className={`mb-2 rounded-xl border px-3 py-2 text-xs ${
            status === "degraded"
              ? "border-[#8a672d]/70 bg-[#2b2414] text-[#d8b35a]"
              : "border-[#25414b] bg-[#071a23] text-[#a9bbc1]"
          }`}
        >
          {announcement}
        </p>
      ) : null}

      <div
        data-testid="mobile-feed-content"
        aria-busy={status === "loading"}
        className="flex min-w-0 flex-1 flex-col"
      >
        {signalFeed}
      </div>
    </div>
  );
}
