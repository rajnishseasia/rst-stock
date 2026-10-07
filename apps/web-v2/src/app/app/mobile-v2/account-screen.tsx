"use client";

import { isValidElement, type KeyboardEvent, type ReactNode } from "react";

import { MobileVenueStack } from "../mobile-venue-stack";

/** Account-wide destinations shown by the mobile account workspace. */
export type MobileAccountTab =
  | "positions"
  | "closed"
  | "orders"
  | "portfolio"
  | "ai";

/** Backwards-friendly name for callers that use the shorter tab type. */
export type AccountTab = MobileAccountTab;

/**
 * A venue-aware panel bundle. The controller can pass an already-mounted
 * panel (the usual path), or pass the two venue panels and let this boundary
 * compose them with the existing stack. In either form, stocks/options rows
 * and perp rows stay in their own labeled sections.
 */
export interface MobileVenuePanelBundle {
  stocks: ReactNode;
  perps: ReactNode | null;
}

export type MobileAccountPanel = ReactNode | MobileVenuePanelBundle;

/**
 * Connection copy belongs to the controller because it owns the credential and
 * status queries. Keeping it as a node means this screen cannot turn an
 * unresolved or failed read into a fabricated `$0.00` balance. A small object
 * form is also accepted for callers that want this presentational boundary to
 * derive the standard tri-state wording without owning a query.
 */
export interface MobileAccountConnectionSummary {
  /** Optional explicit summary state. */
  state?: "connected" | "checking" | "unavailable" | "error";
  /** Optional venue states: true = connected, false = settled absent, null = unresolved. */
  stocks?: boolean | null;
  perps?: boolean | null;
  /** Failed is meaningful only while at least one venue remains unresolved. */
  venueCheckFailed?: boolean;
  /** Controller-provided copy takes precedence over generated wording. */
  message?: ReactNode;
}

export type MobileAccountConnectionSummaryValue =
  | ReactNode
  | MobileAccountConnectionSummary;

/**
 * Explicit account-value transport states. The controller owns the read and
 * decides which state is truthful; this screen never derives a total from the
 * supplied panels.
 */
export type MobileAccountValueState =
  | "available"
  | "loading"
  | "unavailable"
  | "partial";

import { formatUsd } from "@/lib/format";
import type { MobilePortfolioSummary } from "../mobile-portfolio";

export interface MobileAccountScreenProps {
  /** The visible account destination, controlled by the application shell. */
  activeTab: MobileAccountTab;
  /** Selects a destination; this component does not own navigation state. */
  onTabChange: (tab: MobileAccountTab) => void;
  /** Existing stock/options + perp position surfaces. */
  positions: MobileAccountPanel;
  /** Existing closed round-trip surface (perps-specific). */
  closed: MobileAccountPanel;
  /** Existing open-orders surfaces for each venue. */
  orders: MobileAccountPanel;
  /** Existing portfolio/history surfaces. */
  portfolio: MobileAccountPanel;
  /** Existing account-level AI surface. */
  ai: MobileAccountPanel;
  /** Tri-state connection copy or a node supplied by the controller. */
  connectionSummary?: MobileAccountConnectionSummaryValue;
  /** Controller-formatted account total; never calculated by this screen. */
  accountValue?: ReactNode;
  /** Explicit freshness/completeness state for `accountValue`. */
  accountValueState?: MobileAccountValueState;
  /** Portfolio breakdown across venues for mobile metric cards. */
  portfolioSummary?: MobilePortfolioSummary;
  /** Active traded venue ("stocks" or "perps") to drive venue-aware metric cards. */
  venue?: "stocks" | "perps";
}

const ACCOUNT_TABS: ReadonlyArray<{
  value: MobileAccountTab;
  label: string;
}> = [
  { value: "positions", label: "Positions" },
  { value: "closed", label: "Closed" },
  { value: "orders", label: "Orders" },
  { value: "portfolio", label: "Portfolio" },
  { value: "ai", label: "AI" },
];

const CONNECTION_STATUS_UNAVAILABLE =
  "Could not check your connected venues just now.";

function isVenuePanelBundle(
  panel: MobileAccountPanel,
): panel is MobileVenuePanelBundle {
  return (
    typeof panel === "object" &&
    panel !== null &&
    !Array.isArray(panel) &&
    "stocks" in panel &&
    "perps" in panel
  );
}

function renderPanel(panel: MobileAccountPanel) {
  return isVenuePanelBundle(panel) ? (
    <MobileVenueStack stocks={panel.stocks} perps={panel.perps} />
  ) : (
    panel
  );
}

function isConnectionSummaryObject(
  value: MobileAccountConnectionSummaryValue,
): value is MobileAccountConnectionSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isValidElement(value)
  );
}

const INVALID_SUMMARY_NODE = Symbol("invalid-summary-node");

type SummaryNodeResult = ReactNode | typeof INVALID_SUMMARY_NODE;

function isIterable(value: object): value is Iterable<unknown> {
  try {
    return (
      typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
    );
  } catch {
    return false;
  }
}

function normalizeSummaryNode(value: unknown): SummaryNodeResult {
  if (value === null || value === undefined || typeof value === "boolean") {
    return value as ReactNode;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value as ReactNode;
  }
  if (isValidElement(value)) return value;

  if (
    typeof value === "object" &&
    value !== null &&
    (Array.isArray(value) || isIterable(value))
  ) {
    const children: ReactNode[] = [];
    try {
      for (const child of value as Iterable<unknown>) {
        const normalizedChild = normalizeSummaryNode(child);
        if (normalizedChild === INVALID_SUMMARY_NODE) {
          return INVALID_SUMMARY_NODE;
        }
        children.push(normalizedChild);
      }
    } catch {
      return INVALID_SUMMARY_NODE;
    }
    return children;
  }

  return INVALID_SUMMARY_NODE;
}

function connectionSummaryContent(
  summary: MobileAccountConnectionSummaryValue | undefined,
): ReactNode {
  if (summary === undefined || summary === null) {
    return summary;
  }

  const normalizedSummary = normalizeSummaryNode(summary);
  if (normalizedSummary !== INVALID_SUMMARY_NODE) {
    return normalizedSummary;
  }
  if (typeof summary !== "object") return CONNECTION_STATUS_UNAVAILABLE;

  if (!isConnectionSummaryObject(summary)) return CONNECTION_STATUS_UNAVAILABLE;
  if (summary.message !== undefined) {
    const normalizedMessage = normalizeSummaryNode(summary.message);
    return normalizedMessage === INVALID_SUMMARY_NODE
      ? CONNECTION_STATUS_UNAVAILABLE
      : normalizedMessage;
  }

  if (summary.state === "checking") return "Checking your connected venues…";
  if (summary.state === "unavailable" || summary.state === "error") {
    return CONNECTION_STATUS_UNAVAILABLE;
  }
  if (summary.state === "connected") return "Connected venues ready.";

  const hasUnresolvedVenue =
    summary.stocks === null || summary.perps === null;
  if (hasUnresolvedVenue) {
    return summary.venueCheckFailed
      ? CONNECTION_STATUS_UNAVAILABLE
      : "Checking your connected venues…";
  }
  if (summary.stocks === true || summary.perps === true) {
    return "Connected venues ready.";
  }
  if (summary.stocks === false && summary.perps === false) {
    return "Connect a broker or set up perpetual futures to view account data.";
  }
  return CONNECTION_STATUS_UNAVAILABLE;
}

function panelForTab(
  tab: MobileAccountTab,
  panels: Pick<
    MobileAccountScreenProps,
    "positions" | "closed" | "orders" | "portfolio" | "ai"
  >,
) {
  switch (tab) {
    case "closed":
      return panels.closed;
    case "orders":
      return panels.orders;
    case "portfolio":
      return panels.portfolio;
    case "ai":
      return panels.ai;
    case "positions":
    default:
      return panels.positions;
  }
}

function nextTab(
  current: MobileAccountTab,
  key: string,
): MobileAccountTab | null {
  const index = ACCOUNT_TABS.findIndex((tab) => tab.value === current);
  const currentIndex = index >= 0 ? index : 0;
  if (key === "Home") return ACCOUNT_TABS[0].value;
  if (key === "End") return ACCOUNT_TABS[ACCOUNT_TABS.length - 1].value;
  if (key !== "ArrowRight" && key !== "ArrowLeft") {
    return null;
  }
  const direction = key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + direction + ACCOUNT_TABS.length) % ACCOUNT_TABS.length;
  return ACCOUNT_TABS[nextIndex].value;
}

function focusTab(tab: MobileAccountTab) {
  if (typeof document === "undefined") return;
  document.getElementById(`mobile-account-tab-${tab}`)?.focus();
}

function isTabActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

type ConnectionSummaryTone =
  | "checking"
  | "connected"
  | "unavailable"
  | "neutral";

function connectionSummaryTone(
  summary: MobileAccountConnectionSummaryValue | undefined,
): ConnectionSummaryTone {
  const descriptor = summary ?? null;
  if (!isConnectionSummaryObject(descriptor)) return "neutral";
  if (descriptor.state === "checking") return "checking";
  if (descriptor.state === "connected") return "connected";
  if (descriptor.state === "unavailable" || descriptor.state === "error") {
    return "unavailable";
  }
  if (descriptor.stocks === null || descriptor.perps === null) {
    return descriptor.venueCheckFailed ? "unavailable" : "checking";
  }
  if (descriptor.stocks === true || descriptor.perps === true) {
    return "connected";
  }
  if (descriptor.stocks === false && descriptor.perps === false) {
    return "unavailable";
  }
  return "neutral";
}

function connectionSummaryClass(tone: ConnectionSummaryTone): string {
  switch (tone) {
    case "checking":
      return "text-[#afc2c8]";
    case "connected":
      return "text-[#b5d5c6]";
    case "unavailable":
      return "text-[#dfcc7b]";
    default:
      return "text-[#9bb0b8]";
  }
}

function hasRenderableAccountValue(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false && value !== "";
}

function normalizeAccountValueState(
  state: MobileAccountValueState | undefined,
  value: ReactNode,
): MobileAccountValueState {
  if (state === "available") {
    return hasRenderableAccountValue(value) ? "available" : "unavailable";
  }
  if (state === "loading" || state === "partial" || state === "unavailable") {
    return state;
  }
  // A value without an explicit state is not safe to present as current.
  return "unavailable";
}

function accountValueStatusCopy(state: MobileAccountValueState): string {
  switch (state) {
    case "loading":
      return "Checking account value…";
    case "partial":
      return "Partial account value";
    case "unavailable":
      return "Not available right now";
    case "available":
    default:
      return "Not available right now";
  }
}

/**
 * Unified account destination for the functional mobile shell.
 *
 * This component owns only composition and accessible tab behavior. Querying,
 * polling, venue availability, and all row semantics remain with the supplied
 * production panels and the controller that created them.
 */
export function MobileAccountScreen({
  activeTab,
  onTabChange,
  positions,
  closed,
  orders,
  portfolio,
  ai,
  connectionSummary,
  accountValue,
  accountValueState,
  portfolioSummary,
  venue = "stocks",
}: MobileAccountScreenProps) {
  const isPerpsVenue = venue === "perps";
  const selectedTab = ACCOUNT_TABS.some((tab) => tab.value === activeTab)
    ? activeTab
    : "positions";
  const activePanel = panelForTab(selectedTab, {
    positions,
    closed,
    orders,
    portfolio,
    ai,
  });
  const summary = connectionSummaryContent(connectionSummary);
  const summaryTone = connectionSummaryTone(connectionSummary);
  const hasAccountValueContract =
    accountValueState !== undefined || hasRenderableAccountValue(accountValue);
  const normalizedAccountValueState = normalizeAccountValueState(
    accountValueState,
    accountValue,
  );
  const hasConnectionSummary =
    summary !== null && summary !== undefined && summary !== false;
  const hasAccountSummary = hasAccountValueContract || hasConnectionSummary;

  const stocksRow = portfolioSummary?.rows.find((r) => r.venue === "stocks");
  const perpsRow = portfolioSummary?.rows.find((r) => r.venue === "perps");
  const stocksVal = stocksRow?.value ?? null;
  const perpsVal = perpsRow?.value ?? null;
  const totalVal = portfolioSummary?.total ?? null;

  const selectTab = (tab: MobileAccountTab) => {
    onTabChange(tab);
    focusTab(tab);
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    tab: MobileAccountTab,
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

  return (
    <section
      data-testid="mobile-account-screen"
      data-mobile-account-workspace="true"
      data-mobile-account-active-tab={selectedTab}
      aria-labelledby="mobile-account-screen-title"
      className="min-w-0 bg-[#020f16] text-[#f4f7f8]"
    >
      <div className="mx-auto min-w-0 w-full max-w-[760px] overflow-x-clip px-3 pb-8 pt-2 sm:px-4">
        {/* The hero is the money, in two columns: the large account value on
            the left and the venue connection status right-aligned beside it,
            instead of a title, a description and three stacked rows. The h1
            stays for the landmark; the app bar subtitle names the screen. */}
        <header
          data-mobile-account-hero="true"
          className="min-w-0 shrink-0 border-b border-[#1b3a45] pb-3"
        >
          <h1 id="mobile-account-screen-title" className="sr-only">
            Account
          </h1>

          {hasAccountSummary ? (
            <div
              data-mobile-account-summary="true"
              className="flex min-w-0 max-w-full items-end justify-between gap-3"
            >
              {hasAccountValueContract ? (
                <div
                  data-mobile-account-value-context="true"
                  data-mobile-account-value-state={normalizedAccountValueState}
                  role="status"
                  aria-live="polite"
                  aria-busy={normalizedAccountValueState === "loading"}
                  className="min-w-0 max-w-[70%] shrink-0"
                >
                  <span className="block font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#78949e]">
                    Account value
                  </span>
                  {normalizedAccountValueState === "available" ? (
                    <div
                      data-mobile-account-value="true"
                      className="mt-0.5 min-w-0 max-w-full font-data text-2xl font-semibold leading-none tabular-nums text-[#f4f7f8] [overflow-wrap:anywhere]"
                    >
                      {accountValue}
                    </div>
                  ) : (
                    <div
                      data-mobile-account-value-status="true"
                      className="mt-0.5 min-w-0 max-w-full text-xs font-medium leading-5 text-[#a5b8be] [overflow-wrap:anywhere]"
                    >
                      {accountValueStatusCopy(normalizedAccountValueState)}
                    </div>
                  )}
                </div>
              ) : null}

              {hasConnectionSummary ? (
                <div
                  data-testid="mobile-account-connection-summary"
                  data-mobile-account-connection-state={summaryTone}
                  aria-live="polite"
                  aria-busy={summaryTone === "checking"}
                  className={`flex min-w-0 max-w-full flex-1 items-start justify-end gap-1.5 text-right text-2xs leading-4 ${connectionSummaryClass(summaryTone)}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-[5px] size-1.5 shrink-0 rounded-full ${
                      summaryTone === "connected"
                        ? "bg-[#66c69c]"
                        : summaryTone === "unavailable"
                          ? "bg-[#e7c65d]"
                          : "bg-[#8fb4c0]"
                    }`}
                  />
                  <div className="min-w-0 max-w-full [overflow-wrap:anywhere]">
                    {summary}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Metric cards breakdown for mobile view: 2 metrics on stocks, 3 metrics on perps */}
          {portfolioSummary && normalizedAccountValueState === "available" ? (
            <div className={`mt-3 grid gap-2 ${isPerpsVenue ? "grid-cols-3" : "grid-cols-2"}`}>
              <div className="rounded-lg border border-[#1b3a45] bg-[#071922] p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#78949e]">Stocks Portfolio</div>
                <div className="mt-0.5 font-data text-sm font-semibold tabular-nums text-[#f4f7f8]">
                  {stocksVal != null ? formatUsd(stocksVal) : typeof accountValue === "string" ? accountValue : "-"}
                </div>
              </div>
              {isPerpsVenue && (
                <div className="rounded-lg border border-[#1b3a45] bg-[#071922] p-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#78949e]">Perps Balance</div>
                  <div className="mt-0.5 font-data text-sm font-semibold tabular-nums text-[#f4f7f8]">
                    {perpsVal != null ? formatUsd(perpsVal) : "$0.00"}
                  </div>
                </div>
              )}
              <div className="rounded-lg border border-[#1b3a45] bg-[#071922] p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#78949e]">Total Balance</div>
                <div className="mt-0.5 font-data text-sm font-semibold tabular-nums text-[#f4f7f8]">
                  {totalVal != null ? formatUsd(totalVal) : typeof accountValue === "string" ? accountValue : "-"}
                </div>
              </div>
            </div>
          ) : null}
        </header>

        <div
          role="tablist"
          aria-label="Account destinations"
          aria-orientation="horizontal"
          data-mobile-account-destinations="true"
          className="mt-1 min-w-0 shrink-0 touch-pan-x overflow-x-auto overscroll-x-contain border-b border-[#1a3b46] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div
            data-mobile-account-tab-strip="true"
            className="flex min-w-max items-stretch"
          >
            {ACCOUNT_TABS.map(({ value, label }) => {
              const selected = selectedTab === value;
              return (
                <button
                  key={value}
                  id={`mobile-account-tab-${value}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={selected ? `mobile-account-panel-${value}` : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(value)}
                  onKeyDown={(event) => handleTabKeyDown(event, value)}
                  // `flex-auto` (basis: content) rather than a fixed width.
                  // Five 4.75rem tabs plus gaps were 404px, so on a 390px
                  // phone the AI tab was cut off behind a scrollbar this rail
                  // hides on purpose. The strip's `min-w-max` still keeps the
                  // rail from wrapping and hands narrower screens a scroll.
                  // The selected tab is brighter text over a gold hairline
                  // rule, the same treatment as the Traders strip, never a
                  // gold-filled pill (DESIGN.md: gold is a seasoning).
                  data-state={selected ? "active" : "inactive"}
                  className={
                    selected
                      ? "relative min-h-11 min-w-0 flex-auto shrink-0 whitespace-nowrap px-2 text-[11px] font-semibold text-white transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
                      : "relative min-h-11 min-w-0 flex-auto shrink-0 whitespace-nowrap px-2 text-[11px] font-medium text-[#8da5ad] transition-colors duration-150 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
                  }
                >
                  {label}
                  {selected ? (
                    <span
                      aria-hidden="true"
                      data-mobile-account-tab-rule="true"
                      className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#e7c65d]"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <section
          id={`mobile-account-panel-${selectedTab}`}
          role="tabpanel"
          aria-labelledby={`mobile-account-tab-${selectedTab}`}
          tabIndex={0}
          data-mobile-account-active-panel="true"
          className="min-w-0 max-w-full pt-2"
        >
          <div
            data-mobile-account-panel-surface="true"
            className="min-w-0 w-full max-w-full overflow-x-clip [overflow-wrap:anywhere] [&>*]:min-w-0 [&>*]:max-w-full [&_[data-slot=card-header]]:min-w-0 [&_[data-slot=card-header]>div]:min-w-0 [&_[data-slot=card-header]>div]:flex-wrap [&_[data-slot=card-header]>div>div:first-child]:min-w-0 [&_[data-slot=card-header]>div>div:first-child]:flex-1 [&_[data-slot=card-header]>div>div:last-child]:min-w-0 [&_[data-slot=card-header]>div>div:last-child]:max-w-full [&_[data-slot=card-header]>div>div:last-child]:flex-wrap [&_[data-slot=card-content]]:min-w-0"
          >
            {renderPanel(activePanel)}
          </div>
        </section>
      </div>
    </section>
  );
}
