/**
 * Pure layout/interaction math for the terminal chart panel's resizable
 * bottom drawer (audit H7: extracted from terminal-chart-panel.tsx, which was
 * closing in on the god-component line length, so this arithmetic and the
 * global-drag wiring are unit-testable without a DOM). Behavior moved
 * verbatim; the component still owns all DOM measurement, refs, and state.
 */

export const MIN_CHART_HEIGHT = 260;
export const MOBILE_MIN_CHART_HEIGHT = 300;
export const MIN_BOTTOM_DRAWER_HEIGHT = 140;
export const MOBILE_TRADE_PANEL_HEIGHT = 420;
export const TABLET_TRADE_PANEL_HEIGHT = 340;
/**
 * The drawer's share of the desktop split when the user has not chosen one.
 *
 * At 0.22 a 900px-tall terminal opened the drawer at 156px, of which 40px is
 * its own header: two position rows, on the panel that is supposed to answer
 * what you are holding. 0.30 opens it at about 215px, which is the difference
 * between a peek and a usable list, and still leaves the chart the clear
 * majority of the split.
 */
export const DEFAULT_BOTTOM_DRAWER_FRACTION = 0.3;
/**
 * Floor for that proportional default (NOT for dragging: MIN_BOTTOM_DRAWER_HEIGHT
 * still governs how small the user may make it). A short viewport would
 * otherwise open the drawer at a height that shows the header and nothing else.
 * Applied before the bounds clamp, so it can never push the chart below
 * MIN_CHART_HEIGHT.
 */
export const DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT = 200;
export const INITIAL_BOTTOM_DRAWER_HEIGHT = 220;
export const CHART_CHROME_HEIGHT = 184;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function parseStoredTradeHeight(
  raw: string | null | undefined,
): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function finiteNumber(
  value: string | number | null | undefined,
): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface TradeHeightBounds {
  min: number;
  max: number;
  autoDefault: number;
}

/**
 * Bounds for the resizable bottom drawer from already-measured DOM numbers.
 * Compact viewports (<1024px) size the drawer to a fixed mobile/tablet height
 * instead of a fraction of the available space, since there is no chart/drawer
 * split to protect there.
 */
export function computeTradeHeightBounds({
  viewportWidth,
  panelHeight,
  chromeHeight,
}: {
  viewportWidth: number;
  panelHeight: number;
  chromeHeight: number;
}): TradeHeightBounds {
  const isCompact = viewportWidth < 1024;
  if (isCompact) {
    const compactTradeHeight =
      viewportWidth < 640 ? MOBILE_TRADE_PANEL_HEIGHT : TABLET_TRADE_PANEL_HEIGHT;
    return {
      min: compactTradeHeight,
      max: Math.max(compactTradeHeight, panelHeight),
      autoDefault: compactTradeHeight,
    };
  }

  const availableHeight = panelHeight - chromeHeight;
  const min = MIN_BOTTOM_DRAWER_HEIGHT;
  const max = Math.max(min, availableHeight - MIN_CHART_HEIGHT);
  const autoDefault = clamp(
    Math.max(
      Math.round(availableHeight * DEFAULT_BOTTOM_DRAWER_FRACTION),
      DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT,
    ),
    min,
    max,
  );

  return { min, max, autoDefault };
}

/** A drawer with no slack to give up should not offer to resize. */
export function canResizeDrawer(min: number, max: number): boolean {
  return max > min;
}

/**
 * The chrome-height measurement falls back to the static estimate when the
 * DOM measurement comes back empty (e.g. before layout has settled), rather
 * than treating 0 as "no chrome at all".
 */
export function resolveChromeHeight(measuredChromeHeight: number): number {
  return measuredChromeHeight || CHART_CHROME_HEIGHT;
}

/** Height while dragging the resize handle: the panel's bottom edge minus the pointer's Y, clamped to bounds. */
export function computeDragResizedHeight({
  panelBottom,
  pointerClientY,
  min,
  max,
}: {
  panelBottom: number;
  pointerClientY: number;
  min: number;
  max: number;
}): number {
  return clamp(panelBottom - pointerClientY, min, max);
}

/** Height after one keyboard resize step; null means the key is a no-op. */
export function computeKeyboardResizedHeight({
  key,
  shiftKey,
  currentHeight,
  min,
  max,
}: {
  key: string;
  shiftKey: boolean;
  currentHeight: number;
  min: number;
  max: number;
}): number | null {
  const step = shiftKey ? 48 : 24;
  if (key === "ArrowUp") return clamp(currentHeight + step, min, max);
  if (key === "ArrowDown") return clamp(currentHeight - step, min, max);
  if (key === "Home") return min;
  if (key === "End") return max;
  return null;
}

/** Tailwind classes for the chart-overlay toggle buttons' active/inactive state. */
export function overlayToggleButtonClassName(active: boolean): string {
  return active
    ? "border-primary/45 bg-primary/15 text-primary ring-1 ring-inset ring-primary/35 hover:bg-primary/20 hover:text-primary"
    : "border-transparent text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground";
}

/**
 * The real `EventTarget` shape (matches `window` exactly, so the production
 * call site needs no cast) that a test can also satisfy with a plain object
 * that records addEventListener/removeEventListener calls.
 */
export interface PointerDragTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | { passive?: boolean },
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

/**
 * Listens on `target` (the real `window` in production) rather than only the
 * resize handle itself, so a fast drag that outruns the thin handle still
 * keeps resizing instead of getting stuck (the bug `fix: stabilize mobile
 * chart flow and terminal resizing` fixed). Injecting the target lets a test
 * verify the wiring without a DOM: pass a fake object recording
 * addEventListener/removeEventListener calls.
 */
export function attachGlobalPointerDrag(
  target: PointerDragTarget,
  handlers: {
    onMove: (clientY: number) => void;
    onEnd: () => void;
  },
): () => void {
  const handlePointerMove = (event: Event) => {
    event.preventDefault();
    handlers.onMove((event as PointerEvent).clientY);
  };
  const handlePointerEnd = () => handlers.onEnd();

  target.addEventListener("pointermove", handlePointerMove, { passive: false });
  target.addEventListener("pointerup", handlePointerEnd);
  target.addEventListener("pointercancel", handlePointerEnd);

  return () => {
    target.removeEventListener("pointermove", handlePointerMove);
    target.removeEventListener("pointerup", handlePointerEnd);
    target.removeEventListener("pointercancel", handlePointerEnd);
  };
}
