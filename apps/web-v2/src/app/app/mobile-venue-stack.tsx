/**
 * Plan A7. The mobile Tools stack for Positions and Orders, and the section
 * label the desktop "All" bottom view shares with it.
 *
 * Below xl there is no second rail and no bottom drawer, so the desktop trick of
 * venue-FILTERING a panel (VenueAwareRightPositions) would make the other
 * venue's money unreachable: on Perps the equity rows disappear, and back on
 * Stocks a 5x ETH long does. A phone has one account, so both venues stay in
 * one labeled workspace with normal document flow, exactly like the desktop
 * "All" bottom view without nested scrollers.
 *
 * Stock rows (shares) and perp rows (size, leverage, liquidation, funding) are
 * never merged into one table. That is the same equities-safety guard the
 * desktop view documents, and it is why this composes the two existing panels
 * instead of building a combined one.
 *
 * It lives in its own file so it can be rendered in a test. Inside page.tsx the
 * only way to reach it was to read the file as a string (audit H7), and the
 * venue rule below is exactly the kind of thing a string match cannot check.
 *
 * "use client" is required for the drag-to-resize handle (useState + pointer
 * events). The component can still be SSR'd by renderToStaticMarkup in tests
 * and by Next.js for initial page load.
 */
"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { MOBILE_PORTFOLIO_VENUE_LABELS } from "./mobile-portfolio";

export const MOBILE_VENUE_SCOPES = ["all", "stocks", "perps"] as const;
export type MobileVenueScope = (typeof MOBILE_VENUE_SCOPES)[number];

/** Resolve the next roving-tab scope for a supported navigation key. */
export function getMobileVenueScopeForKey(
  scope: MobileVenueScope,
  key: string,
): MobileVenueScope | null {
  const currentIndex = MOBILE_VENUE_SCOPES.indexOf(scope);
  if (currentIndex < 0) return null;

  if (key === "ArrowRight") {
    return MOBILE_VENUE_SCOPES[
      (currentIndex + 1) % MOBILE_VENUE_SCOPES.length
    ];
  }
  if (key === "ArrowLeft") {
    return MOBILE_VENUE_SCOPES[
      (currentIndex - 1 + MOBILE_VENUE_SCOPES.length) %
        MOBILE_VENUE_SCOPES.length
    ];
  }
  if (key === "Home") return MOBILE_VENUE_SCOPES[0];
  if (key === "End") return MOBILE_VENUE_SCOPES[MOBILE_VENUE_SCOPES.length - 1];

  return null;
}

/** Identify the native activation keys supported by a venue scope tab. */
export function isMobileVenueActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

const MOBILE_VENUE_PANEL_CLASS =
  "min-w-0 max-w-full overflow-x-clip [overflow-wrap:anywhere]";

function MobileVenuePanelBoundary({
  venue,
  children,
}: {
  venue: Exclude<MobileVenueScope, "all">;
  children: ReactNode;
}) {
  return (
    <div data-mobile-venue-panel={venue} className={MOBILE_VENUE_PANEL_CLASS}>
      {children}
    </div>
  );
}

export function BottomSectionLabel({ label, id }: { label: string; id?: string }) {
  return (
    <div
      id={id}
      className="sticky top-0 z-10 shrink-0 border-b bg-muted/40 px-3 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur"
    >
      {label}
    </div>
  );
}

/** Stocks get the larger default share so positions are immediately readable. */
const DEFAULT_STOCKS_FRACTION = 0.62;
const MIN_FRACTION = 0.2;
const MAX_FRACTION = 0.8;

/**
 * Two-pane vertical split with a drag handle between them. Shared by
 * MobileVenueStack (mobile tools screen) and the desktop "All" bottom
 * positions panel so both surfaces let users resize the stocks and perps
 * sections.
 *
 * `topClassName` / `bottomClassName` set the overflow mode of each pane.
 * Pass `overflow-hidden` when the child handles its own scroll (e.g.
 * PositionsPanel with `embedded`); leave the defaults when the outer pane
 * should scroll.
 */
export function ResizableSplitPanel({
  topLabel,
  top,
  bottomLabel,
  bottom,
  defaultTopFraction = DEFAULT_STOCKS_FRACTION,
  topClassName = "overflow-y-auto overscroll-contain",
  bottomClassName = "overflow-y-auto overscroll-contain",
}: {
  topLabel: string;
  top: ReactNode;
  bottomLabel: string;
  bottom: ReactNode;
  defaultTopFraction?: number;
  topClassName?: string;
  bottomClassName?: string;
}) {
  const [topFraction, setTopFraction] = useState(defaultTopFraction);
  const splitId = useId();
  const topLabelId = `${splitId}-top-label`;
  const bottomLabelId = `${splitId}-bottom-label`;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startFraction: number } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startFraction: topFraction };
    },
    [topFraction],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current || !containerRef.current) return;
    const totalH = containerRef.current.offsetHeight;
    if (totalH <= 0) return;
    const dy = e.clientY - dragRef.current.startY;
    const next = Math.max(
      MIN_FRACTION,
      Math.min(MAX_FRACTION, dragRef.current.startFraction + dy / totalH),
    );
    setTopFraction(next);
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = e.shiftKey ? 0.1 : 0.05;
      let next = topFraction;
      if (e.key === "ArrowUp") {
        next = topFraction - step;
      } else if (e.key === "ArrowDown") {
        next = topFraction + step;
      } else if (e.key === "Home") {
        next = MIN_FRACTION;
      } else if (e.key === "End") {
        next = MAX_FRACTION;
      } else {
        return;
      }
      e.preventDefault();
      setTopFraction(Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, next)));
    },
    [topFraction],
  );

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden">
      <BottomSectionLabel id={topLabelId} label={topLabel} />
      {/* flex-grow proportional to the fraction; flex-shrink 0 so the handle
          controls the size, not content overflow. */}
      <section
        role="region"
        aria-labelledby={topLabelId}
        className={`min-h-0 border-b ${topClassName}`}
        style={{ flexGrow: topFraction, flexShrink: 0, flexBasis: 0 }}
      >
        {top}
      </section>

      {/* Drag handle: pointer-capture so the drag tracks even if the pointer
          moves outside the handle itself (important on fast swipes). A native
          button keeps it focusable and arrow-key operable for keyboard and
          screen-reader users, matching the bottom-drawer resize handle in
          terminal-chart-panel.tsx. */}
      <button
        type="button"
        role="separator"
        aria-label={`Drag to resize ${topLabel} and ${bottomLabel} panels`}
        aria-orientation="horizontal"
        aria-valuemin={Math.round(MIN_FRACTION * 100)}
        aria-valuemax={Math.round(MAX_FRACTION * 100)}
        aria-valuenow={Math.round(topFraction * 100)}
        className="flex min-h-11 shrink-0 touch-none select-none cursor-row-resize items-center justify-center border-y border-border/40 bg-muted/20 py-1 hover:bg-muted/50 active:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-0"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
      </button>

      <BottomSectionLabel id={bottomLabelId} label={bottomLabel} />
      <section
        role="region"
        aria-labelledby={bottomLabelId}
        className={`min-h-0 ${bottomClassName}`}
        style={{
          flexGrow: 1 - topFraction,
          flexShrink: 0,
          flexBasis: 0,
        }}
      >
        {bottom}
      </section>
    </div>
  );
}

/**
 * `perps` is null when perps are not wired for this deployment or not
 * provisioned for this user (`showMobilePerpsSection`). Then the stocks panel
 * fills the surface UNLABELED: a lone "Stocks & options" header, or worse an
 * empty "Perps" section under it, would advertise a venue this user has no
 * access to and cost half a phone screen to say so. An equities-only user sees
 * exactly what they saw before A7.
 *
 * When both venues are available, the mobile account workspace uses one normal
 * document flow with a compact asset-scope tablist. The old proportional split
 * and drag handle made a phone show two nested scroll regions, clipped the
 * stock panel's controls, and made the second venue dependent on an arbitrary
 * 62/38 viewport allocation. `ResizableSplitPanel` remains available for the
 * desktop bottom overview; mobile deliberately does not use it.
 */
export function MobileVenueStack({
  stocks,
  perps,
}: {
  stocks: ReactNode;
  perps: ReactNode | null;
}) {
  const [scope, setScope] = useState<MobileVenueScope>("all");
  const scopeId = useId();
  const scopeTabsRef = useRef<
    Record<MobileVenueScope, HTMLButtonElement | null>
  >({ all: null, stocks: null, perps: null });

  if (perps === null) {
    return (
      <MobileVenuePanelBoundary venue="stocks">
        {stocks}
      </MobileVenuePanelBoundary>
    );
  }

  const stocksLabelId = `${scopeId}-stocks-label`;
  const perpsLabelId = `${scopeId}-perps-label`;
  const stocksPanelId = `${scopeId}-stocks-panel`;
  const perpsPanelId = `${scopeId}-perps-panel`;
  const showStocks = scope === "all" || scope === "stocks";
  const showPerps = scope === "all" || scope === "perps";
  const handleScopeKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    value: MobileVenueScope,
  ) => {
    if (isMobileVenueActivationKey(event.key)) {
      event.preventDefault();
      setScope(value);
      return;
    }

    const nextScope = getMobileVenueScopeForKey(value, event.key);
    if (nextScope === null) return;

    event.preventDefault();
    setScope(nextScope);
    scopeTabsRef.current[nextScope]?.focus();
  };

  return (
    <div
      data-mobile-venue-stack="true"
      data-mobile-venue-scope={scope}
      data-mobile-venue-workspace="true"
      className="min-w-0 w-full max-w-full overflow-x-clip"
    >
      <div
        role="tablist"
        aria-label="Asset scope"
        aria-orientation="horizontal"
        // A flat strip on a hairline, the same system as the Account strip
        // above it: the selected scope is brighter text over a gold rule,
        // not a gold-filled pill (DESIGN.md: gold is a seasoning).
        className="flex min-w-0 max-w-full border-b border-[#1a3b46]"
      >
        {([
          ["all", "All"],
          ["stocks", "Stocks"],
          ["perps", "Perps"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${scopeId}-${value}-tab`}
            aria-selected={scope === value}
            aria-controls={
              value === "all"
                ? `${stocksPanelId} ${perpsPanelId}`
                : value === "stocks"
                  ? stocksPanelId
                  : perpsPanelId
            }
            tabIndex={scope === value ? 0 : -1}
            onClick={() => setScope(value)}
            onKeyDown={(event) => handleScopeKeyDown(event, value)}
            ref={(element) => {
              scopeTabsRef.current[value] = element;
            }}
            data-state={scope === value ? "active" : "inactive"}
            className={
              scope === value
                ? "relative min-h-11 min-w-0 flex-1 px-2 text-xs font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
                : "relative min-h-11 min-w-0 flex-1 px-2 text-xs font-medium text-[#8da5ad] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
            }
          >
            {label}
            {scope === value ? (
              <span
                aria-hidden="true"
                data-mobile-venue-scope-rule="true"
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#e7c65d]"
              />
            ) : null}
          </button>
        ))}
      </div>

      <div
        data-mobile-venue-content="true"
        className="flex min-w-0 max-w-full flex-col gap-2 overflow-x-clip py-1 sm:gap-3 sm:py-2"
      >
        {showStocks ? (
          <div
            data-mobile-venue-section="stocks"
            className="min-w-0 max-w-full border-b border-[#17313c]/70 px-2 pb-3 pt-2 last:border-b-0 sm:px-3 sm:pb-4 sm:pt-3"
          >
            <div
              id={stocksLabelId}
              className="mb-1.5 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7e99a4]"
            >
              {MOBILE_PORTFOLIO_VENUE_LABELS.stocks}
            </div>
            <section
              id={stocksPanelId}
              role="region"
              aria-labelledby={stocksLabelId}
              className="min-w-0 max-w-full overflow-x-clip [overflow-wrap:anywhere]"
            >
              <MobileVenuePanelBoundary venue="stocks">
                {stocks}
              </MobileVenuePanelBoundary>
            </section>
          </div>
        ) : null}

        {showPerps ? (
          <div
            data-mobile-venue-section="perps"
            className="min-w-0 max-w-full border-b border-[#17313c]/70 px-2 pb-3 pt-2 last:border-b-0 sm:px-3 sm:pb-4 sm:pt-3"
          >
            <div
              id={perpsLabelId}
              className="mb-1.5 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7e99a4]"
            >
              {MOBILE_PORTFOLIO_VENUE_LABELS.perps}
            </div>
            <section
              id={perpsPanelId}
              role="region"
              aria-labelledby={perpsLabelId}
              className="min-w-0 max-w-full overflow-x-clip [overflow-wrap:anywhere]"
            >
              <MobileVenuePanelBoundary venue="perps">
                {perps}
              </MobileVenuePanelBoundary>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
