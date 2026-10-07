"use client";

import Link from "next/link";
import { X } from "lucide-react";
import type { RefObject } from "react";

import {
  MOBILE_NAV_ITEMS,
  resolveMobileNavLabel,
  type MobileNavAccount,
  type MobileNavBalance,
  type MobileScreen,
} from "@/components/layout/mobile-nav";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { cn } from "@/lib/utils";
import {
  type MobileAccountTab,
  type MobileTradersTab,
} from "../mobile-shell";
import type { AccountMode } from "../terminal-account-types";

/**
 * Secondary destinations: every page-level route a phone cannot otherwise
 * reach. The menu is the app's full map, not a second copy of the bottom nav,
 * so a route with no other mobile entry point belongs here or it is
 * unreachable. Legal was exactly that: no link to it existed anywhere in the
 * mobile shell.
 */
const SECONDARY_LINKS = [
  { href: "/lb", label: "Leaderboard", emoji: "🏆" },
  { href: "/guide", label: "Guide", emoji: "📖" },
  { href: "/settings", label: "Settings", emoji: "⚙️" },
] as const;

/**
 * A screen-plus-tab target inside the shell. These are state, not routes: a
 * Traders or Account section is that screen with a tab selected. None of them
 * can be a `<Link>`, so the menu hands the target to the controller, which
 * owns the tab setters and the history adapter.
 */
export type MobileMenuSection =
  | { screen: "traders"; tab: MobileTradersTab }
  | { screen: "account"; tab: MobileAccountTab };

export interface MobileMenuSectionItem {
  key: string;
  label: string;
  emoji: string;
  target: MobileMenuSection;
}

/**
 * The Sections block in menu order: the Traders tabs (Feed, Following, Top X,
 * Top Users, Watchlist), then the Account tabs, following the nav order of
 * the destinations they live on. Built from the tab contracts the screens
 * themselves render, so a row here and the strip it lands on can never
 * disagree on a name. Data rather than a row of JSX each, so a change of tab
 * set is a change here and nowhere else.
 */
export const MOBILE_MENU_SECTIONS: ReadonlyArray<MobileMenuSectionItem> = [
  { key: "traders:feed", label: "Feed", emoji: "📰", target: { screen: "traders", tab: "feed" } },
  { key: "traders:following", label: "Following", emoji: "🔁", target: { screen: "traders", tab: "following" } },
  { key: "traders:watchlist", label: "Watchlist", emoji: "⭐", target: { screen: "traders", tab: "watchlist" } },
  { key: "account:positions", label: "Positions", emoji: "📊", target: { screen: "account", tab: "positions" } },
  { key: "account:portfolio", label: "Portfolio", emoji: "💼", target: { screen: "account", tab: "portfolio" } },
];

/**
 * Routes a menu section: select the tab through the setter that screen's own
 * tab strip calls, then switch to the screen the way the bottom nav does. A
 * row here therefore produces exactly the state a tap on the strip would, so
 * deep links and Back behave the same whichever way the user arrived. The
 * controller wires this rather than the menu, so the dispatch is testable on
 * its own and the menu stays presentational.
 */
export function navigateMobileMenuSection(
  section: MobileMenuSection,
  handlers: {
    setTradersTab: (tab: MobileTradersTab) => void;
    setAccountTab: (tab: MobileAccountTab) => void;
    setScreen: (screen: MobileScreen) => void;
  },
): void {
  switch (section.screen) {
    case "traders":
      handlers.setTradersTab(section.tab);
      break;
    case "account":
      handlers.setAccountTab(section.tab);
      break;
  }
  handlers.setScreen(section.screen);
}

/**
 * One menu row. Pure typography: no icon, no chevron, no card. A 48px row on a
 * 52px pitch keeps the 44px tap floor with 4px of air between rows; the three
 * blocks use two type sizes only (17px destinations, 15px sections and pages).
 */
const ROW_CLASS =
  "flex min-h-11 w-full touch-manipulation items-center gap-2.5 rounded-xl px-3 text-left font-medium leading-none text-[#dce8eb] transition-[color,background-color,border-color,transform] duration-150 hover:bg-white/[0.055] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none";

const PRIMARY_ROW_CLASS = cn(ROW_CLASS, "border border-[#17313b] bg-[#071a23] text-sm");
const SECONDARY_ROW_CLASS = cn(ROW_CLASS, "text-[13px]");

export interface MobileV2MenuProps {
  active: MobileScreen;
  paperAccount?: MobileNavAccount;
  liveAccount?: MobileNavAccount;
  accountMode: AccountMode;
  balance?: MobileNavBalance | null;
  onAccountModeChange: (mode: AccountMode) => void;
  onChange: (screen: MobileScreen) => void;
  /** A Sections row: a screen, plus the tab to select on it. */
  onNavigateSection: (section: MobileMenuSection) => void;
  onClose: () => void;
}

/**
 * The mobile hamburger menu: a full-width, full-height, opaque panel that
 * slides over the app on the app background, with a plain X where the
 * hamburger was and three text-only blocks: the four destinations, the
 * sections inside them that the bottom bar cannot express, and the page
 * routes. The menu is the app's full map; the bar is only its four most-used
 * stops. It scrolls on its own when the list outgrows the viewport; it is an
 * overlay beside the shell, never inside the shell's `main`, so it does not
 * add a nested scroller to any destination.
 *
 * The V2 header owns the trigger, while the controller owns every action here
 * (destination switch, section switch, execution mode), so the menu stays
 * presentational and the history adapter stays in one place. Trade is a
 * destination like the other three (the chart screen), not a shortcut to the
 * ticket.
 */
export function MobileV2Menu(props: MobileV2MenuProps) {
  const menuRef = useModalFocus({ onClose: props.onClose, isOpen: true });
  return <MobileV2MenuPanel {...props} menuRef={menuRef} />;
}

/**
 * The menu without its focus hook, so the markup and handlers can be asserted
 * as a plain element tree (the same split the trade sheet uses).
 */
export function MobileV2MenuPanel({
  active,
  paperAccount,
  liveAccount,
  accountMode,
  balance,
  onAccountModeChange,
  onChange,
  onNavigateSection,
  onClose,
  menuRef,
}: MobileV2MenuProps & { menuRef: RefObject<HTMLElement | null> }) {
  const hasBothAccounts = !!paperAccount && !!liveAccount;

  return (
    <div
      data-mobile-v2-menu="true"
      className="fixed inset-0 z-[70] isolate xl:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Mobile navigation"
      aria-labelledby="mobile-navigation-title"
    >
      <button
        type="button"
        aria-label="Close navigation menu"
        data-mobile-menu-backdrop="true"
        className="absolute inset-0 h-full w-full touch-manipulation bg-[#01080d]/70 backdrop-blur-[2px] transition-colors motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none motion-reduce:transition-none motion-reduce:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d]"
        onClick={onClose}
      />
      <section
        ref={menuRef}
        tabIndex={-1}
        role="navigation"
        aria-label="Mobile navigation drawer"
        data-mobile-menu-surface="true"
        data-mobile-menu-drawer="left"
        className="relative left-0 top-0 flex h-full min-h-[100dvh] max-h-[100dvh] w-[min(88vw,420px)] flex-col overflow-y-auto overscroll-contain border-r border-[#1b3944] bg-[#020f16] px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(0.6rem+env(safe-area-inset-top))] shadow-[24px_0_70px_rgba(0,0,0,0.45)] motion-safe:animate-in motion-safe:slide-in-from-left-4 motion-safe:fade-in-0 motion-safe:duration-200 motion-reduce:animate-none motion-reduce:transition-none motion-reduce:duration-0"
      >
        <h2 id="mobile-navigation-title" className="sr-only">
          Navigation
        </h2>

        <div
          data-mobile-menu-header="true"
          className="flex min-h-11 shrink-0 items-center justify-between"
        >
          <div>
            <p className="font-display text-base font-bold text-white">Ready Set Trade</p>
            <p className="text-3xs font-semibold uppercase tracking-[0.18em] text-[#6f8993]">Menu</p>
          </div>
          <button
            type="button"
            aria-label="Close navigation menu"
            className="grid min-h-11 min-w-11 shrink-0 touch-manipulation place-items-center rounded-full text-white transition-[background-color,transform] duration-150 hover:bg-white/[0.06] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#020f16] motion-reduce:transition-none motion-reduce:active:scale-100"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav
          aria-label="Mobile destinations"
          data-mobile-menu-destinations="true"
          className="mt-4 grid grid-cols-2 gap-2"
        >
          {MOBILE_NAV_ITEMS.map((item) => {
            const resolved = resolveMobileNavLabel(item, balance);
            const selected = item.screen === active;
            return (
              <button
                key={item.key}
                type="button"
                aria-label={resolved.ariaLabel}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  if (item.screen) onChange(item.screen);
                  onClose();
                }}
                className={cn(PRIMARY_ROW_CLASS, selected && "border-[#786529] bg-[#272414] text-[#f0d56c]")}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {resolved.hint && (
                  <span
                    aria-hidden="true"
                    className="shrink-0 font-data text-sm tabular-nums text-[#8fa9b2]"
                  >
                    {resolved.hint}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <p className="mb-1 mt-5 px-2 text-3xs font-semibold uppercase tracking-[0.16em] text-[#68828c]">Quick access</p>
        <nav
          aria-label="Mobile sections"
          data-mobile-menu-sections="true"
          className="grid grid-cols-2 gap-1"
        >
          {MOBILE_MENU_SECTIONS.map(({ key, label, emoji, target }) => (
            <button
              key={key}
              type="button"
              data-mobile-menu-section={key}
              onClick={() => {
                onNavigateSection(target);
                onClose();
              }}
              className={SECONDARY_ROW_CLASS}
            >
              <span aria-hidden="true" className="text-base">{emoji}</span>
              {label}
            </button>
          ))}
        </nav>

        <p className="mb-1 mt-5 px-2 text-3xs font-semibold uppercase tracking-[0.16em] text-[#68828c]">More</p>
        <div className="grid grid-cols-2 gap-1">
          {SECONDARY_LINKS.map(({ href, label, emoji }) => (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={SECONDARY_ROW_CLASS}
            >
              <span aria-hidden="true" className="text-base">{emoji}</span>
              {label}
            </Link>
          ))}

          {hasBothAccounts && (
            <div
              data-mobile-menu-account-mode="true"
              role="group"
              aria-label="Execution mode"
              className="col-span-2 grid grid-cols-2 gap-1 border-t border-[#17313b] pt-2"
            >
              {(["PAPER", "LIVE"] as const).map((mode) => {
                const selected = accountMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onAccountModeChange(mode)}
                    className={cn(
                      SECONDARY_ROW_CLASS,
                      selected && mode === "PAPER" && "text-[#f0d56c]",
                      selected && mode === "LIVE" && "text-[#ff9da7]",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      {mode === "PAPER" ? "Paper" : "Live"}
                    </span>
                    {selected && (
                      <span className="shrink-0 text-xs text-[#8fa9b2]">
                        Active
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <Link href="/legal" onClick={onClose} className="mt-auto px-3 pt-5 text-xs text-[#6f8993] hover:text-white">Legal &amp; privacy</Link>
      </section>
    </div>
  );
}
