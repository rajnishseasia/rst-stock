"use client";

import Link from "next/link";
import {
  CandlestickChart,
  FileText,
  Home,
  Menu,
  Settings,
  UserRound,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Screens the mobile (sub-xl) shell can show.
 *
 * Chart is the Trade destination: the home screen, and what the nav's Trade
 * item opens. It is also reachable contextually (tapping an instrument on any
 * other screen), in which case it carries an origin for its in-flow Back.
 * Traders is one destination carrying the signal feed, the Copy surfaces and
 * the watchlist as tabs; the old `feed` and `copy` screens resolve onto it in
 * the URL codec. Search is contextual only: it stays in this union so the
 * controller can route into it, but it is not one of the four bottom-nav
 * destinations.
 */
export type MobileScreen =
  | "markets"
  | "traders"
  | "search"
  | "chart"
  | "account";

export type MobileNavAccountMode = "PAPER" | "LIVE";

/** The account fields the nav menu displays. */
export type MobileNavAccount = {
  id: string;
  accountId: string | null;
  accountType: string | null;
  username: string | null;
};

export type MobileNavItem = {
  key: MobileScreen | "trade";
  screen?: MobileScreen;
  label: string;
  icon: typeof Home;
  ariaLabel?: string;
  activeWhen?: MobileScreen[];
  /**
   * Plan A9. Marks the destination that receives live balance context when the
   * shell supplies one. A discriminator rather than a render function on
   * `label`, because MOBILE_NAV_ITEMS is a module-level const and cannot close
   * over the balance: the value is threaded in as a prop and resolved by
   * `resolveMobileNavLabel`, which stays pure and testable.
   */
  liveValue?: "balance";
};

/** The live balance the shell threads into the nav, from mobile-portfolio.ts. */
export type MobileNavBalance = {
  /** Compact form for the ~68px nav cell. */
  short: string;
  /** Exact amount, folded into the accessible name. */
  long: string;
};

// Single source of truth for the mobile navigation destinations, shared by the
// anchored bottom nav and the top-left hamburger menu so the two never drift.
export const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { key: "markets", screen: "markets", label: "Markets", icon: Home },
  // Feed, Following, Top X, Top Users and Watchlist as one destination with
  // one tab strip, where Feed and Copy used to hold a slot each. Four items,
  // on purpose: the freed slot is left empty rather than filled by default.
  { key: "traders", screen: "traders", label: "Traders", icon: Users },
  // A real screen, not a shortcut to the ticket: it lands on the live chart of
  // the current instrument, whose pinned Long/Short (Buy/Sell) pair opens the
  // ticket with the side pre-selected.
  {
    key: "trade",
    screen: "chart",
    label: "Trade",
    icon: CandlestickChart,
  },
  {
    key: "account",
    screen: "account",
    label: "Account",
    icon: UserRound,
    ariaLabel: "Account",
    liveValue: "balance",
  },
];

/**
 * What a nav destination reads as, given the live values the shell has.
 *
 * The visible destination label stays stable at every viewport. The balance
 * goes into the accessible name, and its compact form (`hint`) is painted
 * under the label in the bottom cell and beside the destination in the
 * hamburger menu, so funding state is ambient on every screen.
 */
export function resolveMobileNavLabel(
  item: MobileNavItem,
  balance?: MobileNavBalance | null,
): { label: string; ariaLabel: string; hint?: string } {
  const ariaLabel = item.ariaLabel ?? item.label;
  if (item.liveValue !== "balance" || !balance) {
    return { label: item.label, ariaLabel };
  }
  return {
    label: item.label,
    ariaLabel: `${ariaLabel}, ${balance.long}`,
    // Painted as a second line in the bottom cell and beside the destination
    // in the hamburger menu; the label itself never swaps out.
    hint: balance.short,
  };
}

/**
 * Routes a mobile nav destination. Search is not a plain screen switch: it has
 * to seed and focus the ticker input, so it goes through the search opener.
 * Shared by the bottom nav and the header hamburger so a tap means the same
 * thing from either.
 */
export function navigateMobileScreen(
  screen: MobileScreen,
  handlers: {
    openSearch: () => void;
    setScreen: (screen: MobileScreen) => void;
  },
): void {
  if (screen === "search") {
    handlers.openSearch();
    return;
  }
  handlers.setScreen(screen);
}

/** Whether a nav item should read as the current destination. */
export function isMobileNavItemActive(
  item: MobileNavItem,
  active: MobileScreen,
): boolean {
  if (!item.screen) return false;
  return item.screen === active || !!item.activeWhen?.includes(active);
}

export function MobileBottomNav({
  active,
  onChange,
  balance,
}: {
  active: MobileScreen;
  onChange: (screen: MobileScreen) => void;
  /** Plan A9. Live account balance, included in the Account accessible name. */
  balance?: MobileNavBalance | null;
}) {
  return (
    <nav
      aria-label="Mobile app navigation"
      // Anchored in-flow at the bottom of the fixed mobile shell (not
      // position:fixed), so it's always visible and never overlaps the last
      // content row. The surrounding MobileV2Frame owns the home-indicator
      // inset; keeping spacing here to fixed padding prevents double insets
      // when the two components are composed.
      // 8px of padding around 48px cells: 64px plus the home-indicator
      // inset, against the 81px the taller grid used to cost every screen.
      // Four cells share the row five did; fewer items must not buy a
      // taller bar.
      className="w-full min-w-0 shrink-0 border-t border-[#1a323b] bg-[#04141b]/97 px-2 pb-1 pt-1 shadow-[0_-8px_22px_rgba(0,0,0,0.16)] backdrop-blur-xl xl:hidden"
    >
      <div
        data-mobile-v2-nav-list="true"
        className="grid min-h-14 w-full min-w-0 grid-cols-4 gap-1"
      >
        {MOBILE_NAV_ITEMS.map((item) => {
          const { key, screen, icon: Icon } = item;
          const isActive = isMobileNavItemActive(item, active);
          const { label, ariaLabel, hint } = resolveMobileNavLabel(item, balance);

          return (
            <button
              key={key}
              type="button"
              aria-current={isActive ? "page" : undefined}
              aria-label={ariaLabel}
              data-mobile-v2-nav-item={key}
              data-mobile-v2-nav-state={isActive ? "active" : key === "trade" ? "primary" : "idle"}
              onClick={() => screen && onChange(screen)}
              className={cn(
                "relative grid h-12 min-h-11 min-w-0 touch-manipulation place-items-center content-center gap-0.5 rounded-xl border border-transparent px-1 text-3xs font-medium leading-none text-[#718a94] transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] active:bg-[#102d36] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] focus-visible:ring-offset-1 focus-visible:ring-offset-[#04141b] motion-reduce:transition-none motion-reduce:active:scale-100",
                // The current destination is brighter text under the gold
                // hairline rule below, not a filled pill: gold seasons the
                // nav, it does not fill it (DESIGN.md). Trade keeps its warm
                // primary tint as the bar's one call to action.
                //
                // Trade is tested BEFORE isActive on purpose. Ordered the other
                // way the tint is unreachable on the one screen it matters
                // most: Trade is now the landing destination, so a cold open
                // starts there and the bar's one call to action would render
                // flat every time it was actually selected. Selected Trade is
                // the tint plus white text under the rule, not the tint traded
                // away for it.
                key === "trade"
                  ? cn(
                      "bg-[#201e12] shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] hover:bg-[#2b2717] active:bg-[#352e16]",
                      isActive ? "text-white" : "text-[#e7c65d]",
                    )
                  : isActive
                    ? "text-white"
                    : "hover:bg-[#0b222b] hover:text-white",
              )}
            >
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute top-0 h-0.5 w-7 rounded-full bg-[#e7c65d] shadow-[0_0_8px_rgba(231,198,93,0.2)]"
                />
              ) : null}
              <Icon className="size-5" aria-hidden="true" />
              <span className="w-full min-w-0 whitespace-nowrap px-0.5 text-center leading-none tabular-nums">
                {label}
              </span>
              {hint ? (
                // The live balance, painted in the cell itself. The exact
                // amount is already in the accessible name above, so the
                // painted compact form is decorative to assistive tech.
                <span
                  data-mobile-v2-nav-value="true"
                  aria-hidden="true"
                  className="w-full min-w-0 whitespace-nowrap px-0.5 text-center font-data text-3xs font-semibold leading-none tabular-nums text-[#e7c65d]"
                >
                  {hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// Top-left hamburger (mobile only) mirroring the bottom-nav destinations - an
// additional way to jump between screens from the header.
export function MobileNavMenu({
  active,
  onChange,
  paperAccount,
  liveAccount,
  accountMode,
  onAccountModeChange,
  balance,
}: {
  active: MobileScreen;
  onChange: (screen: MobileScreen) => void;
  paperAccount?: MobileNavAccount;
  liveAccount?: MobileNavAccount;
  accountMode: MobileNavAccountMode;
  onAccountModeChange: (mode: MobileNavAccountMode) => void;
  /** Plan A9. Shown BESIDE the destination name here, not in place of it. */
  balance?: MobileNavBalance | null;
}) {
  const hasBothAccounts = !!paperAccount && !!liveAccount;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation menu"
          className="min-h-11 min-w-11 shrink-0 touch-manipulation rounded-full text-[#a7b9c0] transition-[background-color,color,box-shadow,transform] duration-150 ease-out hover:bg-[#0b222b] hover:text-white active:scale-[0.96] active:bg-[#102d36] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#020f16] motion-reduce:transition-none motion-reduce:active:scale-100 xl:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain rounded-2xl border border-[#294651] bg-[#071922] p-2 text-[#e4edef] shadow-[0_24px_70px_rgba(0,0,0,0.55)] ring-1 ring-[#5d8f97]/10 motion-reduce:animate-none motion-reduce:duration-0"
      >
        <DropdownMenuLabel className="px-3 py-2 text-3xs font-semibold uppercase tracking-[0.15em] text-[#819ba5]">
          Navigate
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-[#1b3640]" />
        {MOBILE_NAV_ITEMS.map((item) => {
          const { key, screen, icon: Icon } = item;
          const isActive = isMobileNavItemActive(item, active);
          const { ariaLabel, hint } = resolveMobileNavLabel(item, balance);

          return (
            <DropdownMenuItem
              key={key}
              aria-label={ariaLabel}
              onSelect={() => screen && onChange(screen)}
              className={cn(
                "min-h-11 min-w-0 rounded-xl border border-transparent px-3 text-sm text-[#e4edef] transition-[background-color,border-color,color] duration-150 ease-out focus:bg-[#0d2a34] focus:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none",
                isActive && "border-[#8d7834]/50 bg-[#12303b] text-white",
                key === "trade" && "border-[#8d7834]/40 bg-[#201e12] text-[#e7c65d] hover:bg-[#2b2717]",
              )}
            >
              <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
              <span className="min-w-0">{item.label}</span>
              {hint && (
                <span className="ml-auto max-w-[45%] shrink-0 whitespace-normal break-words text-right text-xs tabular-nums opacity-60">
                  {hint}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator className="bg-[#1b3640]" />
        <DropdownMenuItem asChild>
          <Link
            href="/settings"
            className="flex min-h-11 min-w-0 items-center rounded-xl px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
          >
            <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>
        {hasBothAccounts && (
          <>
            <DropdownMenuSeparator className="bg-[#1b3640]" />
            <DropdownMenuLabel className="px-3 py-2 text-3xs font-semibold uppercase tracking-[0.15em] text-[#819ba5]">
              Alpaca Settings
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => onAccountModeChange("PAPER")}
              className={cn(
                "min-h-11 min-w-0 rounded-xl border border-transparent px-3 text-sm text-[#e4edef] transition-[background-color,border-color,color] duration-150 ease-out focus:bg-[#0d2a34] focus:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none",
                accountMode === "PAPER" && "bg-[#292516] text-[#f0d56c]",
              )}
            >
              <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
              <span>Paper</span>
              {accountMode === "PAPER" && <span className="ml-auto text-xs opacity-60">active</span>}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onAccountModeChange("LIVE")}
              className={cn(
                "min-h-11 min-w-0 rounded-xl border border-transparent px-3 text-sm text-[#e4edef] transition-[background-color,border-color,color] duration-150 ease-out focus:bg-[#0d2a34] focus:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none",
                accountMode === "LIVE" && "bg-[#28171d] text-[#ff8795]",
              )}
            >
              <Zap className="mr-2 h-4 w-4" aria-hidden="true" />
              <span>Live</span>
              {accountMode === "LIVE" && <span className="ml-auto text-xs opacity-60">active</span>}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
