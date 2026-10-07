"use client";

import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  DEFAULT_MOBILE_LEADERBOARD_TAB,
  MOBILE_TRADERS_TABS,
  isCopyTradersTab,
  isMobileTradersTab,
  type MobileTradersTab,
} from "../mobile-shell";
import { MobileCopyPanel, type MobileCopyDeploymentState } from "./copy-panel";

export {
  MOBILE_TRADERS_TABS,
  type MobileTradersTab,
} from "../mobile-shell";

export interface MobileTradersScreenProps {
  /** Controlled selected tab. State belongs to the authenticated controller. */
  activeTab: MobileTradersTab;
  /** Reports tab changes to the controller; this screen owns no tab state. */
  onTabChange: (tab: MobileTradersTab) => void;
  /** The mounted MobileFeedPanel: venue scope, transport status, live feed. */
  feed: ReactNode;
  /** The production CopyTradePanel, including its real Follow controls. */
  copyFeed: ReactNode;
  /** The production X-callers leaderboard body. */
  xCallers: ReactNode;
  /** The production users leaderboard body. */
  users: ReactNode;
  /** The already-wired WatchlistPanel. */
  watchlist: ReactNode;
  /** A controller-supplied link/button to the real copy risk settings flow. */
  riskSettingsAction?: ReactNode | (() => void);
  /** Deployment status/copy supplied by the controller, when available. */
  deploymentState?: MobileCopyDeploymentState;
  /**
   * The already-wired venue switch (Stocks | Perps), when the deployment has
   * perps. Traders no longer sits under a pinned venue bar, so the control is
   * handed down to the ONE tab whose content the venue scopes: Following,
   * whose copy feed is queried with the venue-derived asset class. The Feed
   * tab carries its own All / Stocks / Perps scope, the two leaderboards rank
   * people rather than markets, and the watchlist lists both venues at once,
   * so none of them pays a row for a control that would change nothing there.
   */
  venueSwitch?: ReactNode;
}

function selectedTab(tab: MobileTradersTab): MobileTradersTab {
  return isMobileTradersTab(tab) ? tab : MOBILE_TRADERS_TABS[0].value;
}

function nextTab(
  current: MobileTradersTab,
  key: string,
): MobileTradersTab | null {
  const index = MOBILE_TRADERS_TABS.findIndex((tab) => tab.value === current);
  const currentIndex = index >= 0 ? index : 0;
  if (key === "Home") return MOBILE_TRADERS_TABS[0].value;
  if (key === "End") {
    return MOBILE_TRADERS_TABS[MOBILE_TRADERS_TABS.length - 1].value;
  }
  if (key !== "ArrowRight" && key !== "ArrowLeft") return null;
  const direction = key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + direction + MOBILE_TRADERS_TABS.length) %
    MOBILE_TRADERS_TABS.length;
  return MOBILE_TRADERS_TABS[nextIndex].value;
}

function focusTab(tab: MobileTradersTab) {
  if (typeof document === "undefined") return;
  document.getElementById(`mobile-traders-tab-${tab}`)?.focus();
}

function isTabActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

/**
 * How the active panel sits in the screen's flex column.
 *
 * Feed grows into the shell's free space (`flex-1`, min-height still auto) so
 * its empty state can center in the slack while a long feed still pushes
 * `main` to scroll. The Copy surfaces are content-height blocks. The
 * watchlist keeps a BLOCK chain on purpose: WatchlistPanel carries the
 * bounded `h-full min-h-0` contract with a scroller inside, and a flex column
 * above it would resolve that height and switch the scroller on. In a block
 * chain the percentage has nothing to resolve against, so the panel sizes to
 * its content and `main` stays the only scroller (the same rule Markets
 * followed while the watchlist lived there).
 */
export function mobileTradersPanelFlow(tab: MobileTradersTab): string {
  if (tab === "feed") return "flex min-w-0 flex-1 flex-col";
  if (tab === "watchlist") {
    return "min-w-0 [&_[role=alert]]:border-l-2 [&_[role=alert]]:border-[#8d4f4d] [&_[role=alert]]:bg-[#301d20] [&_[role=alert]]:px-3 [&_[role=alert]]:py-3 [&_[role=alert]]:text-[#ffd8d3] [&_[role=status]]:border-l-2 [&_[role=status]]:border-[#3d4d51] [&_[role=status]]:bg-[#0d2730] [&_[role=status]]:px-3 [&_[role=status]]:py-3 [&_[role=status]]:text-[#c8d8da]";
  }
  return "min-w-0";
}

const TAB_CLASS =
  "relative inline-flex min-h-11 flex-1 shrink-0 touch-manipulation items-center justify-center whitespace-nowrap px-2.5 text-[13px] leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none";

/**
 * The mobile Traders destination: Feed, Following, Top X, Top Users and
 * Watchlist under one tab strip.
 *
 * These were three surfaces (a Feed nav slot, a Copy nav slot, and a
 * Watchlist section inside Markets), each paying for its own screen chrome.
 * Here the strip is the screen's only control row; the app bar names the
 * screen and the bottom nav highlights it, so there is no visible title row.
 * The venue switch is not part of this row: it belongs to the one tab whose
 * content it scopes, and travels down to that panel instead. Exactly one
 * panel is mounted at a time (the others are absent, not hidden), so the feed
 * poll, the copy poll, the leaderboard queries and the watchlist query never
 * run for a surface nobody is looking at.
 *
 * Top X and Top Users ARE the `/lb` leaderboard: the screen mounts the two
 * ranked bodies `/lb` renders, so the leaderboard is a destination tab here
 * and not a menu link. The copy panel names it as such, and Following carries
 * the in-shell entry to it; `/lb` stays a working route and a menu row for
 * the full page.
 *
 * The strip is one row. It scrolls sideways inside its own container if the
 * labels ever outgrow the viewport (there is no wrap to a second row), and
 * every tab keeps a 44px target. The active tab is brighter text over a
 * hairline gold rule, not a filled pill: gold seasons here, it does not fill.
 */
export function MobileTradersScreen({
  activeTab,
  onTabChange,
  feed,
  copyFeed,
  xCallers,
  users,
  watchlist,
  riskSettingsAction,
  deploymentState,
  venueSwitch,
}: MobileTradersScreenProps) {
  const active = selectedTab(activeTab);
  const panelId = `mobile-traders-panel-${active}`;

  const selectTab = (tab: MobileTradersTab) => {
    onTabChange(tab);
    focusTab(tab);
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    tab: MobileTradersTab,
  ) => {
    if (isTabActivationKey(event.key)) {
      event.preventDefault();
      selectTab(tab);
      return;
    }
    const tabToSelect = nextTab(tab, event.key);
    if (!tabToSelect) return;
    event.preventDefault();
    selectTab(tabToSelect);
  };

  let panel: ReactNode;
  if (active === "feed") {
    panel = feed;
  } else if (active === "watchlist") {
    panel = watchlist;
  } else if (isCopyTradersTab(active)) {
    panel = (
      <MobileCopyPanel
        activeTab={active}
        copyFeed={copyFeed}
        xCallers={xCallers}
        users={users}
        riskSettingsAction={riskSettingsAction}
        deploymentState={deploymentState}
        venueSwitch={venueSwitch}
        // The leaderboard entry is a tab switch, not a route: this screen owns
        // the strip, so opening a board from Following lands on that board's
        // own tab and keeps the shell, the bottom nav and the screen state.
        onOpenLeaderboard={() => selectTab(DEFAULT_MOBILE_LEADERBOARD_TAB)}
      />
    );
  }

  return (
    <section
      data-testid="mobile-traders-screen"
      data-mobile-traders-active-tab={active}
      aria-labelledby="mobile-traders-screen-title"
      // `flex-1` down this chain grows the screen to the shell's full scroll
      // height so a panel that opts in (the feed) can center its empty state.
      // Nothing is bounded (no h-full, no min-h-0): tall content overflows
      // into the shell's `main`, which stays the only scroller.
      className="flex min-w-0 flex-1 flex-col bg-[#020f16] text-[#dfe8eb]"
    >
      <div className="flex min-w-0 w-full flex-1 flex-col gap-2 overflow-x-clip px-3 pb-8 pt-2 sm:px-4">
        <h1 id="mobile-traders-screen-title" className="sr-only">
          Traders
        </h1>

        <div
          role="tablist"
          aria-label="Traders sections"
          aria-orientation="horizontal"
          data-mobile-traders-tablist="true"
          className="flex min-w-0 shrink-0 touch-pan-x overflow-x-auto overscroll-x-contain border-b border-[#1a3b46] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {MOBILE_TRADERS_TABS.map(({ value, label }) => {
            const isActive = active === value;
            return (
              <button
                key={value}
                id={`mobile-traders-tab-${value}`}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={isActive}
                aria-controls={isActive ? panelId : undefined}
                tabIndex={isActive ? 0 : -1}
                data-mobile-traders-tab={value}
                data-state={isActive ? "active" : "inactive"}
                onClick={() => selectTab(value)}
                onKeyDown={(event) => handleTabKeyDown(event, value)}
                className={cn(
                  TAB_CLASS,
                  isActive
                    ? "font-semibold text-white"
                    : "font-medium text-[#8da5ad] hover:text-white",
                )}
              >
                {label}
                {isActive ? (
                  <span
                    aria-hidden="true"
                    data-mobile-traders-tab-rule="true"
                    className="absolute inset-x-2.5 bottom-0 h-0.5 rounded-full bg-[#e7c65d]"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={`mobile-traders-tab-${active}`}
          tabIndex={0}
          data-mobile-traders-panel={active}
          className={cn(
            mobileTradersPanelFlow(active),
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d]/60",
          )}
        >
          {panel}
        </div>
      </div>
    </section>
  );
}
