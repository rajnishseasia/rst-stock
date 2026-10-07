"use client";

import { ChevronRight, Menu, Search } from "lucide-react";
import Image from "next/image";
import type { Key, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { MobileAccountValueReason } from "../mobile-portfolio";

/**
 * The three honest states a mobile header can show for account value.
 *
 * The header deliberately does not turn an unresolved read into `$0.00`:
 * absence of a value is different from a confirmed zero balance.
 */
export type MobileV2AccountValueState =
  | "available"
  | "loading"
  | "unavailable";

/** Values accepted by the presentational header from query adapters. */
export type MobileV2AccountValueStateInput =
  | MobileV2AccountValueState
  | "pending"
  | "checking"
  | "unresolved"
  | "ready"
  | "resolved"
  | "success"
  | "error"
  | "failed"
  | "unknown"
  | string
  | null
  | undefined;

export interface MobileV2HeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onOpenMenu: () => void;
  onOpenSearch: () => void;
  accountValue?: ReactNode;
  /**
   * Compact spelling of `accountValue` for the app-bar chip (for example
   * "$12.4K" for "portfolio $12,400.00"). The exact value stays in the chip's
   * accessible text; only what is painted changes.
   */
  accountValueCompact?: ReactNode;
  accountValueState?: MobileV2AccountValueStateInput;
  /** Why the value is unavailable, when it is. Chooses the chip's wording. */
  accountValueReason?: MobileAccountValueReason | null;
  /**
   * Opens the Account destination. When the value is unavailable because no
   * venue is connected, the chip becomes a Connect action that routes here,
   * so the header names the next step instead of a dead error string. When a
   * value is available, the chip routes here too.
   */
  onOpenAccount?: () => void;
}

export interface MobileV2FrameProps {
  /** The single mobile app header. Pass a `MobileV2Header` element here. */
  header: ReactNode;
  /** Persistent notice rendered in normal flow immediately after the header. */
  notice?: ReactNode;
  /** The only region that scrolls; it stays bounded by the flex shell. */
  content: ReactNode;
  /** Remounts only the scroller when the primary destination changes. */
  contentKey?: Key;
  /**
   * Optional persistent primary action pinned between the content and the
   * navigation (the chart screen's Long/Short pair). In flow, never fixed, so
   * it can never cover the last content row.
   */
  actionBar?: ReactNode;
  /** In-flow bottom navigation, including its own controls. */
  navigation: ReactNode;
  /** A modal/sheet rendered above the shell when one is open. */
  overlay?: ReactNode;
}

function hasAccountValue(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false && value !== "";
}

function normalizeAccountValueState(
  state: MobileV2AccountValueStateInput,
  value: ReactNode,
): MobileV2AccountValueState {
  const hasValue = hasAccountValue(value);

  if (
    state === "loading" ||
    state === "pending" ||
    state === "checking" ||
    state === "unresolved" ||
    state === "fetching"
  ) {
    return "loading";
  }

  if (
    state === "available" ||
    state === "ready" ||
    state === "resolved" ||
    state === "success"
  ) {
    return hasValue ? "available" : "unavailable";
  }

  if (
    state === "unavailable" ||
    state === "error" ||
    state === "failed" ||
    state === "unknown" ||
    state === "stale" ||
    state === "offline"
  ) {
    return "unavailable";
  }

  // Values are only safe to display after the adapter explicitly confirms a
  // fresh, available read. Unknown adapter states must not turn cached data
  // into an apparently current account value.
  return "unavailable";
}

/**
 * The chip's spoken sentence. For an unavailable value this is a plain
 * sentence about the user's situation, not a status code: "No broker
 * connected" tells them what to do, "Account value unavailable" only told
 * them something was wrong.
 */
function accountValueSentence(
  state: MobileV2AccountValueState,
  reason: MobileAccountValueReason | null | undefined,
): string {
  if (state === "loading") return "Checking account value…";
  if (reason === "not-connected") return "No broker connected";
  if (reason === "venue-check-failed") return "A venue could not be checked";
  return "Not available right now";
}

/**
 * What the chip paints in the app bar for a non-value state. Short enough to
 * share one 44px row with the brand and the Search action; the full sentence
 * above stays in the accessible text.
 */
function accountValueCompactLabel(
  state: MobileV2AccountValueState,
  reason: MobileAccountValueReason | null | undefined,
): string {
  if (state === "loading") return "Checking";
  if (reason === "not-connected") return "No broker";
  if (reason === "venue-check-failed") return "Check failed";
  return "Unavailable";
}

const HEADER_ICON_BUTTON_CLASS =
  "grid min-h-11 min-w-11 shrink-0 touch-manipulation place-items-center rounded-full text-[#a7b9c0] transition-[background-color,color,box-shadow,transform] duration-150 ease-out hover:bg-[#0b222b] hover:text-white active:scale-[0.96] active:bg-[#102d36] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#020f16] motion-reduce:transition-none motion-reduce:active:scale-100";

/**
 * Shared mobile application header: one 44px row.
 *
 * Menu, brand, the account chip and Search share the row; the chip replaced
 * the full-width "Account value" strip that used to cost every screen a second
 * row. Search is intentionally one global action in the header. Screens should
 * route to it through `onOpenSearch` instead of introducing another search
 * query or a second app chrome row.
 */
export function MobileV2Header({
  title,
  subtitle,
  onOpenMenu,
  onOpenSearch,
  accountValue,
  accountValueCompact,
  accountValueState,
  accountValueReason,
  onOpenAccount,
}: MobileV2HeaderProps) {
  const normalizedState = normalizeAccountValueState(
    accountValueState,
    accountValue,
  );
  const reason = normalizedState === "unavailable" ? accountValueReason : null;
  // Connect is offered only when connecting is the actual next step. A failed
  // venue check gets a sentence, not a prompt to connect an account the user
  // may already have.
  const offersConnect = reason === "not-connected" && !!onOpenAccount;
  const isAvailable = normalizedState === "available";
  const sentence = isAvailable
    ? null
    : accountValueSentence(normalizedState, reason);

  let chip: ReactNode;
  if (offersConnect) {
    chip = (
      <button
        type="button"
        onClick={onOpenAccount}
        data-mobile-v2-account-action="true"
        className="inline-flex min-h-11 min-w-0 touch-manipulation items-center gap-0.5 rounded-full py-1 transition-[transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#020f16] motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <span className="inline-flex min-h-7 items-center gap-0.5 rounded-full border border-[#665c28] bg-[#272414] py-0.5 pl-2.5 pr-1.5 text-3xs font-semibold uppercase tracking-[0.12em] text-[#e7c65d]">
          Connect
          <ChevronRight className="size-3" aria-hidden="true" />
        </span>
        <span
          data-mobile-v2-account-value="true"
          className="sr-only min-w-0 whitespace-normal break-words font-medium"
        >
          {sentence}
        </span>
      </button>
    );
  } else {
    const valueClass = cn(
      "min-w-0 whitespace-normal break-words text-right text-xs leading-tight",
      // The data font is for numbers. A sentence about the account's state
      // set in mono tabular figures reads as an error code.
      isAvailable
        ? "font-data font-semibold tabular-nums text-[#dfe8eb]"
        : "font-medium text-[#a9bbc1]",
    );
    const body = (
      <>
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isAvailable && "bg-[#48d597] shadow-[0_0_0_3px_rgba(72,213,151,0.14)]",
            normalizedState === "loading" &&
              "bg-[#8da5ad] motion-safe:animate-pulse motion-reduce:animate-none",
            normalizedState === "unavailable" && "bg-[#d8b35a]",
          )}
        />
        <span data-mobile-v2-account-value="true" className={valueClass}>
          {isAvailable ? (
            hasAccountValue(accountValueCompact) ? (
              <>
                <span aria-hidden="true">{accountValueCompact}</span>
                <span className="sr-only">{accountValue}</span>
              </>
            ) : (
              accountValue
            )
          ) : (
            <>
              <span aria-hidden="true">
                {accountValueCompactLabel(normalizedState, reason)}
              </span>
              <span className="sr-only">{sentence}</span>
            </>
          )}
        </span>
      </>
    );
    const chipClass =
      "inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-full border border-[#1f3a45] bg-[#071a23] px-2.5 py-1 shadow-[inset_0_1px_0_rgba(108,173,180,0.08)]";
    chip =
      isAvailable && onOpenAccount ? (
        // The chip is the money on every screen, so it is also the shortest
        // path to the Account destination that explains it.
        <button
          type="button"
          onClick={onOpenAccount}
          data-mobile-v2-account-link="true"
          className={cn(
            chipClass,
            "min-h-11 touch-manipulation transition-[transform,border-color] duration-150 hover:border-[#2c5260] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#020f16] motion-reduce:transition-none motion-reduce:active:scale-100",
          )}
        >
          {body}
        </button>
      ) : (
        <span className={chipClass}>{body}</span>
      );
  }

  return (
    <header
      data-mobile-v2-header="true"
      className="min-w-0 shrink-0 overflow-hidden border-b border-[#142b34] bg-[#020f16]/95 px-3 pb-1.5 pt-[calc(0.4rem+env(safe-area-inset-top))] shadow-[inset_0_1px_0_rgba(108,173,180,0.08)] backdrop-blur-xl xl:hidden"
    >
      <div
        data-mobile-v2-header-row="true"
        className="flex min-h-11 min-w-0 items-center gap-1.5"
      >
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-2 pl-0.5">
          {/* The bull emblem, the same asset and size the desktop terminal
              header and the landing nav use. The mobile shell paints one dark
              surface (#020f16) in both colour schemes, so only the dark-surface
              variant applies here; there is no light mobile surface to serve.
              Decorative: the wordmark beside it is the accessible name. */}
          <Image
            data-mobile-v2-brand-mark="true"
            src="/brand/emblem-dark.png"
            alt=""
            width={32}
            height={32}
            priority
            draggable={false}
            className="size-8 shrink-0 select-none"
          />
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-bold leading-tight tracking-tight text-white">
              {title}
            </p>
            {subtitle ? (
              <p className="truncate text-3xs font-semibold uppercase leading-none tracking-[0.15em] text-[#708a94]">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>

        <div
          data-mobile-v2-account-context="true"
          data-account-value-state={normalizedState}
          data-account-value-reason={reason ?? undefined}
          role="status"
          aria-live="polite"
          aria-busy={normalizedState === "loading"}
          className="flex min-w-0 shrink-0 items-center"
        >
          {chip}
        </div>

        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Search"
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <Search className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/**
 * Bounded mobile shell used by every destination.
 *
 * Header, content, action bar and navigation are siblings in one flex column.
 * There is no venue slot: the venue control is routed to the destinations
 * that read it and hosted inside a control row those screens already paint
 * (see `mobile-venue-scope.ts`), never pinned above every screen.
 *
 * The content region owns the only scroll position, while the
 * navigation slot remains in normal flow and reserves the home-indicator
 * inset. This prevents the last row from disappearing beneath a fixed bottom
 * bar.
 */
export function MobileV2Frame({
  header,
  notice,
  content,
  contentKey,
  actionBar,
  navigation,
  overlay,
}: MobileV2FrameProps) {
  return (
    <div
      data-mobile-v2-frame="true"
      className="relative isolate flex h-[100dvh] min-h-[100dvh] min-w-0 flex-col overflow-hidden bg-[#020f16] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-[#dfe8eb] xl:hidden"
    >
      <a
        href="#mobile-v2-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-[calc(0.5rem+env(safe-area-inset-top))] focus:z-50 focus:w-fit focus:rounded-lg focus:bg-[#e7c65d] focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#1c1a0f] focus:outline-none focus:ring-2 focus:ring-[#e7c65d]"
      >
        Skip to main content
      </a>

      {header}

      {notice}

      {/* A flex column, so a destination can opt into growing to the full
          scroll height (`flex-1`) and center an empty state in the slack. A
          destination that does not opt in is a plain flex item: content
          height, full width, exactly as a block child was. Nothing here
          bounds a child: taller content still overflows into this, the one
          and only scroller. */}
      <main
        key={contentKey}
        id="mobile-v2-main"
        tabIndex={-1}
        data-mobile-v2-content="true"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-[#020f16]"
      >
        {content}
      </main>

      {actionBar ? (
        <div
          data-mobile-v2-action-slot="true"
          className="min-w-0 shrink-0 xl:hidden"
        >
          {actionBar}
        </div>
      ) : null}

      <div
        data-mobile-v2-navigation-slot="true"
        className="min-w-0 shrink-0 overflow-hidden bg-[#04141b]/97 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_28px_rgba(0,0,0,0.16)] backdrop-blur-xl xl:hidden"
      >
        {navigation}
      </div>

      {overlay}
    </div>
  );
}
