"use client";

import { Search } from "lucide-react";
import { isValidElement, type ReactNode } from "react";

export interface MobileMarketsScreenProps {
  /** Kept for controller compatibility; account context belongs to the shell. */
  accountSummary: ReactNode;
  /** The already-wired `MobileMarketBrowse` element. */
  marketBrowse: ReactNode;
  /** Opens the contextual global market search surface. */
  onOpenSearch: () => void;
  /**
   * The already-wired venue switch (Stocks | Perps), when the deployment has
   * perps. Markets renders it in its own first row, beside Search, instead of
   * a pinned bar of its own above the screen: one control row where there
   * were three stacked ones.
   */
  venueSwitch?: ReactNode;
}

function hasRenderableContent(content: ReactNode): boolean {
  return (
    content !== null &&
    content !== undefined &&
    content !== false &&
    content !== true &&
    content !== ""
  );
}

type MobileMarketsPanelState = "content" | "alert" | "status" | "empty";

/**
 * The supplied market panel owns its query states. This small classification
 * only makes an already-present status/alert node discoverable to the shell;
 * it never infers prices or adds a second market-data request.
 */
function panelStateFor(content: ReactNode): MobileMarketsPanelState {
  if (!hasRenderableContent(content)) return "empty";
  if (!isValidElement(content)) return "content";

  const role = (content.props as { role?: unknown }).role;
  return role === "alert" || role === "status" ? role : "content";
}

function unavailablePanel() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-mobile-markets-panel-empty="true"
      className="flex min-h-32 flex-col items-center justify-center border-y border-dashed border-[#29434c] px-4 py-8 text-center text-xs text-[#8ba1a9]"
    >
      <p className="font-medium text-[#dfe8eb]">Market data unavailable.</p>
      <p className="mt-1">Try again in a moment.</p>
    </div>
  );
}

/**
 * The production mobile Markets destination.
 *
 * Markets is intentionally a discovery surface: Browse is supplied by the
 * authenticated controller, so its queries and venue-aware selection
 * callbacks stay in their existing production owner. The supplied panel
 * remains the source of truth for loading, error, and empty messaging. This
 * wrapper only styles those semantic states and shows a neutral unavailable
 * state if the panel slot is absent. In particular, it does not add a signal
 * feed, static movers, or a second market-data query of its own. The
 * watchlist used to be a section switch here; it is a tab of the Traders
 * destination now, so Markets is Browse alone.
 *
 * There is no visible title row: the app bar names the screen and the bottom
 * nav highlights it, so the first row here is already a control (the venue
 * switch beside Search) and the data starts one row later.
 */
export function MobileMarketsScreen({
  marketBrowse,
  onOpenSearch,
  venueSwitch,
}: MobileMarketsScreenProps) {
  const hasVenueSwitch = hasRenderableContent(venueSwitch);
  const hasActivePanel = hasRenderableContent(marketBrowse);
  const activePanelState = panelStateFor(marketBrowse);
  // Browse grows into the shell's free space (min-height stays auto, so a long
  // list still pushes `main` to scroll) and its empty state centers in the
  // slack. Never a bound or a second scroller: `main` is the only one.
  const panelFlow = "flex min-w-0 flex-1 flex-col";

  return (
    <section
      data-testid="mobile-markets-screen"
      aria-labelledby="mobile-markets-screen-title"
      className="flex min-w-0 flex-1 flex-col bg-[#020f16] text-[#dfe8eb]"
    >
      <div className="mx-auto flex min-w-0 w-full max-w-[760px] flex-1 flex-col gap-2 overflow-x-clip px-3 pb-8 pt-2 sm:px-4">
        <header
          data-mobile-markets-header="true"
          className="flex shrink-0 items-center gap-1.5"
        >
          <h1 id="mobile-markets-screen-title" className="sr-only">
            Markets
          </h1>
          {hasVenueSwitch ? (
            // The venue switch takes the row; Search keeps its 44px cell.
            <div
              data-mobile-markets-venue="true"
              className="min-w-0 flex-1"
            >
              {venueSwitch}
            </div>
          ) : (
            <span aria-hidden="true" className="min-w-0 flex-1" />
          )}
          <button
            type="button"
            aria-label="Search markets"
            title="Search markets"
            onClick={onOpenSearch}
            className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-xl border border-[#29434c] bg-[#071a23] text-[#9bb0b8] transition hover:border-[#49606a] hover:bg-[#0b222b] hover:text-white active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-1 focus-visible:ring-offset-[#020f16]"
          >
            <Search className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div
          className={panelFlow}
          data-mobile-markets-panel="browse"
          data-mobile-markets-panel-state={hasActivePanel ? "ready" : "unavailable"}
        >
          <div
            data-mobile-markets-panel-surface="true"
            className={`${panelFlow} [&_[role=alert]]:border-l-2 [&_[role=alert]]:border-[#8d4f4d] [&_[role=alert]]:bg-[#301d20] [&_[role=alert]]:px-3 [&_[role=alert]]:py-3 [&_[role=alert]]:text-[#ffd8d3] [&_[role=status]]:border-l-2 [&_[role=status]]:border-[#3d4d51] [&_[role=status]]:bg-[#0d2730] [&_[role=status]]:px-3 [&_[role=status]]:py-3 [&_[role=status]]:text-[#c8d8da]`}
          >
            <div
              data-mobile-markets-content="browse"
              data-mobile-markets-state={activePanelState}
              className={panelFlow}
            >
              {hasActivePanel ? marketBrowse : unavailablePanel()}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
