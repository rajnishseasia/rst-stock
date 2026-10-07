/**
 * Behavioral cover for the terminal chart panel.
 *
 * This replaces a `readFileSync` + `toContain` test that asserted the
 * component's source mentioned certain strings. That style is banned by the
 * audit rule in CLAUDE.md (the source-string allowlist must shrink, never
 * grow): it passes when the string is present even if the behavior it names
 * is broken, and it fails on a harmless rename or reformat.
 *
 * TerminalChartPanel is a hooks-heavy client component (useState/useEffect/
 * useRef throughout), so it is rendered for real with `renderToStaticMarkup`
 * and its tRPC queries / chart child are mocked, the same pattern used by
 * perps-onboarding-card.test.tsx. Two pieces of interaction the panel wires up
 * cannot be observed from static markup at all, because React never
 * serializes event-handler props into HTML and this repo has no DOM test
 * environment:
 *
 *   - the chart-overlay toggle buttons' click handlers and click isolation
 *     (`event.stopPropagation()`), and
 *   - the bottom-drawer resize handle's pointer/keyboard wiring, and the
 *     `window`-level pointermove listener that keeps a fast drag from
 *     outrunning the thin handle (see `git log -p` on this component for
 *     `fix: stabilize mobile chart flow and terminal resizing`, the commit
 *     that added it).
 *
 * Both were extracted into small presentational components with no hooks
 * (`ChartOverlayToggleGroup`, `ChartResizeHandle`) plus pure functions
 * (`terminal-chart-panel-layout.ts`), exactly the CLAUDE.md-sanctioned move
 * for a component too stateful to test directly (see smart-exit.ts /
 * review-metrics.ts / account-targeting.ts for the same pattern in this
 * repo). A leaf component with no hooks can be called directly as a plain
 * function to get its element tree back (see `@/testing/element-tree`), so a
 * test can invoke the exact handler the component wired to a given button
 * without a DOM.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { click, findByAriaLabel, flattenElements } from "@/testing/element-tree";
import {
  formatCompactUsd,
  formatPriceUsd,
  formatSignedNumber,
  formatSignedUsd,
} from "@/lib/format";
import {
  formatPerpFundingPct,
  formatPerpUsd,
} from "@/components/perps/perp-format";
import { ChartOverlayToggleGroup } from "./chart-overlay-toggle-group";
import { ChartResizeHandle } from "./chart-resize-handle";
import {
  attachGlobalPointerDrag,
  canResizeDrawer,
  clamp,
  computeDragResizedHeight,
  computeKeyboardResizedHeight,
  computeTradeHeightBounds,
  finiteNumber,
  overlayToggleButtonClassName,
  parseStoredTradeHeight,
  resolveChromeHeight,
  CHART_CHROME_HEIGHT,
  DEFAULT_BOTTOM_DRAWER_FRACTION,
  DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT,
  INITIAL_BOTTOM_DRAWER_HEIGHT,
  MIN_BOTTOM_DRAWER_HEIGHT,
  MIN_CHART_HEIGHT,
  MOBILE_MIN_CHART_HEIGHT,
  MOBILE_TRADE_PANEL_HEIGHT,
  TABLET_TRADE_PANEL_HEIGHT,
} from "./terminal-chart-panel-layout";
import type { TerminalChartPanelProps } from "./terminal-chart-panel";

// ============================================
// tRPC + chart-library mocks
// ============================================

interface QuoteFixture {
  symbol: string;
  last: string;
  change: string;
  changePercent: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
  volume: string;
}

interface PositionFixture {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
}

interface PerpSnapshotFixture {
  markPx: string;
  prevDayPx: string;
  bid: string;
  ask: string;
  oraclePx: string;
  dayNtlVlm: string;
  funding: string;
  /** Coin units, exactly as HL reports it; the strip values it at the mark. */
  openInterest: string;
}

let currentQuote: QuoteFixture | undefined;
let currentPositions: PositionFixture[] = [];
let currentPerpSnapshot: PerpSnapshotFixture | undefined;

const quoteCalls: Array<{ input: unknown; options: Record<string, unknown> }> = [];
const positionsCalls: Array<{ input: unknown; options: Record<string, unknown> }> = [];
const perpSnapshotCalls: Array<{ input: unknown; options: Record<string, unknown> }> = [];

mock.module("@/lib/trpc", () => ({
  trpc: {
    quotes: {
      getChartQuote: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          quoteCalls.push({ input, options });
          return { data: currentQuote, isLoading: false, error: null };
        },
      },
    },
    positions: {
      list: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          positionsCalls.push({ input, options });
          return { data: currentPositions, isLoading: false, error: null };
        },
      },
    },
    hyperliquid: {
      assetSnapshot: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          perpSnapshotCalls.push({ input, options });
          return { data: currentPerpSnapshot, isLoading: false, error: null };
        },
      },
    },
  },
}));

let lastAdvancedChartProps: Record<string, unknown> | null = null;

mock.module("@/components/charts/advanced-chart", () => ({
  AdvancedChart: (props: Record<string, unknown>) => {
    lastAdvancedChartProps = props;
    return createElement("div", { "data-testid": "advanced-chart-stub" });
  },
}));

// The real DropdownMenu (Radix) only mounts its content once opened, and
// nothing here can click it open without a DOM. Stubbing it to always render
// its children lets the "More" menu's actual rows (Day Range, Volume, ...) be
// asserted on like any other markup, rather than skipped entirely.
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => children ?? null,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) => children ?? null,
  DropdownMenuContent: ({ children }: { children?: unknown }) =>
    createElement("div", { "data-slot": "dropdown-menu-content" }, children as never),
  DropdownMenuGroup: ({ children }: { children?: unknown }) =>
    createElement("div", { "data-slot": "dropdown-menu-group" }, children as never),
  DropdownMenuItem: ({
    children,
    className,
    onSelect,
  }: {
    children?: unknown;
    className?: string;
    onSelect?: () => void;
  }) =>
    createElement(
      "div",
      { "data-slot": "dropdown-menu-item", className, onClick: onSelect },
      children as never,
    ),
  DropdownMenuSeparator: () => createElement("hr", { "data-slot": "dropdown-menu-separator" }),
}));

const { TerminalChartPanel, TerminalStat } = await import("./terminal-chart-panel");

function renderPanel(
  props: Partial<TerminalChartPanelProps> & { symbol: string },
  fixtures: {
    quote?: QuoteFixture;
    positions?: PositionFixture[];
    perpSnapshot?: PerpSnapshotFixture;
  } = {},
): string {
  currentQuote = fixtures.quote;
  currentPositions = fixtures.positions ?? [];
  currentPerpSnapshot = fixtures.perpSnapshot;
  quoteCalls.length = 0;
  positionsCalls.length = 0;
  perpSnapshotCalls.length = 0;
  lastAdvancedChartProps = null;

  return renderToStaticMarkup(
    createElement(TerminalChartPanel, { onSymbolCommit: () => {}, ...props }),
  );
}

const QUOTE: QuoteFixture = {
  symbol: "AAPL",
  last: "185.20",
  change: "1.10",
  changePercent: "0.60",
  bid: "185.10",
  ask: "185.30",
  high: "186.00",
  low: "184.00",
  volume: "1,234,567",
};

const POSITION: PositionFixture = {
  symbol: "AAPL",
  qty: 10,
  avgEntryPrice: 150,
  unrealizedPL: 352.1,
  unrealizedPLPercent: 23.47,
};

const PERP_SNAPSHOT: PerpSnapshotFixture = {
  markPx: "50000",
  prevDayPx: "49000",
  bid: "49990",
  ask: "50010",
  oraclePx: "50005.5",
  dayNtlVlm: "12345678",
  funding: "0.0000125",
  openInterest: "1234.5",
};

// ============================================
// Header: stock quote / position readouts
// ============================================

describe("TerminalChartPanel header (stocks)", () => {
  test("queries the chart quote and account position for the active, uppercased symbol", () => {
    renderPanel({ symbol: "aapl", credentialId: "acct-1" });

    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0].input).toEqual({ symbol: "AAPL" });
    expect(quoteCalls[0].options.enabled).toBe(true);

    expect(positionsCalls).toHaveLength(1);
    expect(positionsCalls[0].input).toEqual({ credentialId: "acct-1" });
    expect(positionsCalls[0].options.enabled).toBe(true);
  });

  test("shows the live Alpaca snapshot and position P&L computed from the query data", () => {
    const markup = renderPanel(
      { symbol: "AAPL", credentialId: "acct-1" },
      { quote: QUOTE, positions: [POSITION] },
    );

    expect(markup).toContain(formatPriceUsd(QUOTE.last));
    expect(markup).toContain(formatSignedNumber(QUOTE.changePercent, "%"));
    expect(markup).toContain(`${formatPriceUsd(QUOTE.bid)} / ${formatPriceUsd(QUOTE.ask)}`);
    expect(markup).toContain(`${POSITION.qty} @ ${formatPriceUsd(POSITION.avgEntryPrice)}`);
    expect(markup).toContain(
      `${formatSignedUsd(POSITION.unrealizedPL)} (${formatSignedNumber(POSITION.unrealizedPLPercent, "%")})`,
    );

    for (const label of ["Price", "Day Change", "Bid / Ask", "Position", "Position P&amp;L"]) {
      expect(markup).toContain(
        `text-3xs uppercase tracking-wide text-muted-foreground">${label}<`,
      );
    }
  });

  test("falls back to Flat / dash when the account has no open position in this symbol", () => {
    const markup = renderPanel(
      { symbol: "AAPL", credentialId: "acct-1" },
      { quote: QUOTE, positions: [] },
    );

    expect(markup).toContain(">Flat<");
    expect(markup).toContain(">-<");
    expect(markup).not.toContain(`${POSITION.qty} @`);
  });

  test("surfaces Day Range, Volume, and the same Position rows in the overflow menu", () => {
    const markup = renderPanel(
      { symbol: "AAPL", credentialId: "acct-1" },
      { quote: QUOTE, positions: [POSITION] },
    );

    expect(markup).toContain(">Day Range<");
    expect(markup).toContain(`${formatPriceUsd(QUOTE.low)} - ${formatPriceUsd(QUOTE.high)}`);
    expect(markup).toContain(">Volume<");
    expect(markup).toContain(QUOTE.volume);
  });
});

describe("TerminalChartPanel header (perps)", () => {
  test("routes to the Hyperliquid snapshot and disables the stock endpoints", () => {
    renderPanel({ symbol: "btc", venue: "perps", credentialId: "acct-1" });

    expect(quoteCalls[0].options.enabled).toBe(false);
    expect(positionsCalls[0].options.enabled).toBe(false);
    expect(perpSnapshotCalls).toHaveLength(1);
    expect(perpSnapshotCalls[0].input).toEqual({ coin: "btc" });
    expect(perpSnapshotCalls[0].options.enabled).toBe(true);
  });

  test("shows Oracle and 24h volume through the perp formatters", () => {
    const markup = renderPanel(
      { symbol: "btc", venue: "perps" },
      { perpSnapshot: PERP_SNAPSHOT },
    );

    expect(markup).toContain(formatPerpUsd(PERP_SNAPSHOT.oraclePx));
    expect(markup).toContain(formatCompactUsd(PERP_SNAPSHOT.dayNtlVlm));
  });

  test("puts funding and open interest in the strip, not only the More menu", () => {
    // The two numbers a perp trader scans before the index price: what the
    // carry costs and how crowded the book is. Funding used to be reachable
    // only by opening the overflow menu, and open interest was nowhere.
    const markup = renderPanel(
      { symbol: "btc", venue: "perps" },
      { perpSnapshot: PERP_SNAPSHOT },
    );

    // The interval is part of the label. Hyperliquid funds hourly while other
    // venues quote an 8h rate, so a bare "Funding" invites a reader to compare
    // this against a number eight times its size.
    expect(markup).toContain(">Funding (1h)<");
    expect(markup).not.toContain(">Funding<");
    expect(markup).toContain(">Open Interest<");
    expect(markup).toContain(formatPerpFundingPct(PERP_SNAPSHOT.funding));
  });

  test("values open interest in USD at the mark rather than in coin units", () => {
    // 1,234.5 BTC at $50,000 is $61.7M. HL reports coin units, which are not
    // comparable across coins that differ by orders of magnitude in price.
    const markup = renderPanel(
      { symbol: "btc", venue: "perps" },
      { perpSnapshot: PERP_SNAPSHOT },
    );

    expect(markup).toContain(
      formatCompactUsd(
        Number(PERP_SNAPSHOT.openInterest) * Number(PERP_SNAPSHOT.markPx),
      ),
    );
    expect(markup).not.toContain(">1,234.5<");
  });

  test("gives funding and open interest the earliest optional breakpoints", () => {
    // The strip reveals stats left to right as the chart column widens, so the
    // order in the markup IS the priority. Funding and open interest must come
    // before Bid / Ask (the perps chart already carries a live L2 rail) and
    // before Oracle, or a trader on a default-width workspace never sees them.
    const markup = renderPanel(
      { symbol: "btc", venue: "perps" },
      { perpSnapshot: PERP_SNAPSHOT },
    );
    const at = (label: string) => markup.indexOf(`>${label}<`);

    expect(at("Funding (1h)")).toBeGreaterThan(-1);
    expect(at("Open Interest")).toBeGreaterThan(-1);
    expect(at("Funding (1h)")).toBeLessThan(at("24h Vol"));
    expect(at("24h Vol")).toBeLessThan(at("Open Interest"));
    expect(at("Open Interest")).toBeLessThan(at("Bid / Ask"));
    expect(at("Bid / Ask")).toBeLessThan(at("Oracle"));
  });

  test("keeps every perp stat honest when the snapshot has not resolved", () => {
    const markup = renderPanel({ symbol: "btc", venue: "perps" }, {});

    expect(markup).toContain(">Funding (1h)<");
    expect(markup).not.toContain(">Funding<");
    expect(markup).toContain(">Open Interest<");
    // No invented zeros: an unresolved snapshot reads as absent, not as flat
    // funding on an empty book.
    expect(markup).not.toContain("+0.00%");
    expect(markup).not.toContain(">$0.00<");
  });
});

// ============================================
// Bottom drawer
// ============================================

describe("TerminalChartPanel bottom drawer", () => {
  test("labels the drawer 'Chart bottom drawer' by default and drops the old Trade Ticket copy", () => {
    const markup = renderPanel(
      { symbol: "AAPL", bottomDrawer: createElement("div", null, "Ticket contents") },
      { quote: QUOTE },
    );

    expect(markup).toContain('aria-label="Chart bottom drawer"');
    expect(markup).not.toContain("Trade Ticket");
  });

  test("uses a caller-supplied bottomDrawerLabel instead of the default", () => {
    const markup = renderPanel(
      {
        symbol: "AAPL",
        bottomDrawer: createElement("div", null, "Ticket contents"),
        bottomDrawerLabel: "Positions drawer",
      },
      { quote: QUOTE },
    );

    expect(markup).toContain('aria-label="Positions drawer"');
    expect(markup).not.toContain('aria-label="Chart bottom drawer"');
  });

  test("shows the live formatted last price and day change in the default drawer header", () => {
    const markup = renderPanel(
      { symbol: "AAPL", bottomDrawer: createElement("div", null, "Ticket contents") },
      { quote: QUOTE },
    );

    expect(markup).toContain(formatPriceUsd(QUOTE.last));
    expect(markup).toContain(formatSignedNumber(QUOTE.changePercent, "%"));
  });
});

// ============================================
// Header chrome / layout
// ============================================

describe("TerminalChartPanel header chrome", () => {
  test("stacks the header as one horizontal strip that stays above the chart, not a clipped grid", () => {
    const markup = renderPanel(
      { symbol: "AAPL", credentialId: "acct-1" },
      { quote: QUOTE, positions: [POSITION] },
    );

    // Above (and never clipping) the chart underneath, so search suggestions
    // are not cut off.
    expect(markup).toContain("relative z-20");
    expect(markup).toContain("overflow-visible");
    expect(markup).not.toContain("items-center gap-2 overflow-hidden border-b bg-background/95");
    // Metrics sit in one row, not a wrapping grid.
    expect(markup).toContain("flex min-w-max shrink-0 items-center gap-2");
    expect(markup).not.toContain("repeat(auto-fit, minmax(144px, 1fr))");
    expect(markup).toContain('class="ml-auto flex shrink-0 items-center gap-2"');
  });

  test("renders the symbol search as a real InputGroup control sized for the command bar", () => {
    const markup = renderPanel({ symbol: "AAPL", credentialId: "acct-1" });

    expect(markup).toContain('data-slot="input-group"');
    expect(markup).toContain("h-10 w-[180px]");
    expect(markup).toContain("@[920px]/chartbar:w-[250px]");
    expect(markup).toContain('placeholder="Search ticker..."');
    expect(markup).toContain('aria-label="Chart symbol"');
    expect(markup).toContain('aria-label="Trade symbol"');
  });

  test("does not show the stale per-account chrome this header used to carry", () => {
    const markup = renderPanel({ symbol: "AAPL", credentialId: "acct-1" });
    expect(markup).not.toContain("No account selected");
  });

  test("marks its own buttons type=button so none of them submit the wrapping symbol form", () => {
    const markup = renderPanel(
      { symbol: "AAPL", credentialId: "acct-1" },
      { quote: QUOTE, positions: [POSITION] },
    );
    const count = (markup.match(/type="button"/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("gives the chart canvas the shared MIN_CHART_HEIGHT floor and wires the active symbol/venue/overlays through", () => {
    renderPanel({ symbol: "aapl", credentialId: "acct-1", venue: "stocks" });

    expect(lastAdvancedChartProps?.className).toContain(`min-h-[${MIN_CHART_HEIGHT}px]`);
    expect(lastAdvancedChartProps?.symbol).toBe("AAPL");
    expect(lastAdvancedChartProps?.venue).toBe("stocks");
    expect(lastAdvancedChartProps?.showExecutions).toBe(true);
    expect(lastAdvancedChartProps?.showSignals).toBe(true);
  });
});

// ============================================
// TerminalStat (exported for direct testing; no hooks of its own that block it)
// ============================================

describe("TerminalStat", () => {
  function renderStat(props: Parameters<typeof TerminalStat>[0]): string {
    return renderToStaticMarkup(createElement(TerminalStat, props));
  }

  test("gives the primary stat extra width and drops its left border; a normal stat gets neither", () => {
    const primary = renderStat({ label: "Price", value: "$1.00", priority: "primary" });
    const normal = renderStat({ label: "Price", value: "$1.00" });

    expect(primary).toContain("min-w-28 first:border-l-0");
    expect(normal).not.toContain("min-w-28 first:border-l-0");
    expect(normal).toContain("min-w-24 shrink-0");
  });

  test("forwards a caller className so a stat can hide until its container breakpoint", () => {
    const markup = renderStat({
      label: "Bid / Ask",
      value: "$1 / $2",
      className: "hidden @[760px]/chartbar:block",
    });
    expect(markup).toContain("hidden @[760px]/chartbar:block");
  });

  test("colors a plain (non-badge) value by tone", () => {
    expect(renderStat({ label: "X", value: "+1", tone: "positive" })).toContain("text-green-400");
    expect(renderStat({ label: "X", value: "-1", tone: "negative" })).toContain("text-red-400");
  });

  test("renders a badge value through the shared ChangeBadge tint, not the plain-text tone classes", () => {
    const markup = renderStat({
      label: "Day Change",
      value: "+0.60%",
      tone: "positive",
      badge: true,
    });
    expect(markup).toContain("+0.60%");
    expect(markup).toContain("bg-gain-tint");
    expect(markup).not.toContain("text-green-400");
  });
});

// ============================================
// ChartOverlayToggleGroup (extracted; no hooks, so callable directly)
// ============================================

describe("ChartOverlayToggleGroup", () => {
  test("aria-pressed and active styling track each toggle's own state independently", () => {
    const tree = ChartOverlayToggleGroup({
      showExecutions: true,
      showSignals: false,
      onToggleExecutions: () => {},
      onToggleSignals: () => {},
    });

    const myOrders = findByAriaLabel(tree, "Toggle my orders overlay");
    const signals = findByAriaLabel(tree, "Toggle signals overlay");

    expect(myOrders?.props["aria-pressed"]).toBe(true);
    expect(signals?.props["aria-pressed"]).toBe(false);
    expect(myOrders?.props.className).toContain(overlayToggleButtonClassName(true));
    expect(signals?.props.className).toContain(overlayToggleButtonClassName(false));
    expect(overlayToggleButtonClassName(true)).not.toBe(overlayToggleButtonClassName(false));
  });

  test("clicking a toggle calls only its own handler", () => {
    let executionsToggled = 0;
    let signalsToggled = 0;
    const tree = ChartOverlayToggleGroup({
      showExecutions: true,
      showSignals: true,
      onToggleExecutions: () => {
        executionsToggled += 1;
      },
      onToggleSignals: () => {
        signalsToggled += 1;
      },
    });

    click(findByAriaLabel(tree, "Toggle my orders overlay"));
    expect(executionsToggled).toBe(1);
    expect(signalsToggled).toBe(0);

    click(findByAriaLabel(tree, "Toggle signals overlay"));
    expect(signalsToggled).toBe(1);
  });

  test("isolates its own clicks and pointerdowns from whatever it is nested inside", () => {
    const tree = ChartOverlayToggleGroup({
      showExecutions: true,
      showSignals: true,
      onToggleExecutions: () => {},
      onToggleSignals: () => {},
    });

    const group = findByAriaLabel(tree, "Chart overlays");
    expect(group?.props.role).toBe("group");

    let clickBubbled = true;
    (group?.props.onClick as (event: { stopPropagation: () => void }) => void)?.({
      stopPropagation: () => {
        clickBubbled = false;
      },
    });
    expect(clickBubbled).toBe(false);

    let pointerDownBubbled = true;
    (group?.props.onPointerDown as (event: { stopPropagation: () => void }) => void)?.({
      stopPropagation: () => {
        pointerDownBubbled = false;
      },
    });
    expect(pointerDownBubbled).toBe(false);
  });

  test("marks both toggles type=button so they never submit a surrounding form", () => {
    const tree = ChartOverlayToggleGroup({
      showExecutions: true,
      showSignals: true,
      onToggleExecutions: () => {},
      onToggleSignals: () => {},
    });
    const buttonTypeCount = flattenElements(tree).filter(
      (element) => element.props.type === "button",
    ).length;
    expect(buttonTypeCount).toBe(2);
  });
});

// ============================================
// ChartResizeHandle (extracted; no hooks, so callable directly)
// ============================================

describe("ChartResizeHandle", () => {
  function noopHandlers() {
    return {
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onPointerCancel: () => {},
      onKeyDown: () => {},
    };
  }

  test("wires each prop handler to its own matching pointer/keyboard event, not a different one", () => {
    const props = { canResize: true, isDragging: false, min: 140, max: 400, value: 220, ...noopHandlers() };
    const handle = findByAriaLabel(
      ChartResizeHandle(props),
      "Resize chart bottom drawer",
    );

    expect(handle?.props.onPointerDown).toBe(props.onPointerDown);
    expect(handle?.props.onPointerMove).toBe(props.onPointerMove);
    expect(handle?.props.onPointerUp).toBe(props.onPointerUp);
    expect(handle?.props.onPointerCancel).toBe(props.onPointerCancel);
    expect(handle?.props.onKeyDown).toBe(props.onKeyDown);
    expect(handle?.props.role).toBe("separator");
    expect(handle?.props["aria-orientation"]).toBe("horizontal");
  });

  test("reports min/max/value through ARIA, value rounded", () => {
    const handle = findByAriaLabel(
      ChartResizeHandle({ canResize: true, isDragging: false, min: 140, max: 400, value: 219.6, ...noopHandlers() }),
      "Resize chart bottom drawer",
    );
    expect(handle?.props["aria-valuemin"]).toBe(140);
    expect(handle?.props["aria-valuemax"]).toBe(400);
    expect(handle?.props["aria-valuenow"]).toBe(220);
  });

  test("disables and explains itself when there is no room left to resize", () => {
    const disabled = findByAriaLabel(
      ChartResizeHandle({ canResize: false, isDragging: false, min: 140, max: 140, value: 140, ...noopHandlers() }),
      "Resize chart bottom drawer",
    );
    expect(disabled?.props["aria-disabled"]).toBe(true);
    expect(disabled?.props.title).toBe(
      "Chart and bottom drawer are already at their minimum sizes",
    );
    expect(disabled?.props.className).toContain("cursor-not-allowed opacity-70");

    const enabled = findByAriaLabel(
      ChartResizeHandle({ canResize: true, isDragging: false, min: 140, max: 400, value: 200, ...noopHandlers() }),
      "Resize chart bottom drawer",
    );
    expect(enabled?.props["aria-disabled"]).toBeUndefined();
    expect(enabled?.props.title).toBe("Drag to resize chart and bottom drawer");
    expect(enabled?.props.className).toContain("cursor-row-resize");
  });

  test("adds the active-drag class only while dragging", () => {
    const dragging = findByAriaLabel(
      ChartResizeHandle({ canResize: true, isDragging: true, min: 140, max: 400, value: 200, ...noopHandlers() }),
      "Resize chart bottom drawer",
    );
    const idle = findByAriaLabel(
      ChartResizeHandle({ canResize: true, isDragging: false, min: 140, max: 400, value: 200, ...noopHandlers() }),
      "Resize chart bottom drawer",
    );
    expect(dragging?.props.className).toContain("terminal-resize-handle-active");
    expect(idle?.props.className).not.toContain("terminal-resize-handle-active");
  });

  test("keeps the drag target large and touch-friendly", () => {
    const handle = findByAriaLabel(
      ChartResizeHandle({ canResize: true, isDragging: false, min: 140, max: 400, value: 200, ...noopHandlers() }),
      "Resize chart bottom drawer",
    );
    expect(handle?.props.className).toContain("touch-none");
    expect(handle?.props.className).toContain("xl:h-6");
  });
});

// ============================================
// terminal-chart-panel-layout (pure math extracted from the component)
// ============================================

describe("terminal-chart-panel-layout constants", () => {
  test("pin the sizes the resize handle and compact layouts depend on", () => {
    expect(MIN_CHART_HEIGHT).toBe(260);
    expect(MOBILE_MIN_CHART_HEIGHT).toBe(300);
    expect(MIN_BOTTOM_DRAWER_HEIGHT).toBe(140);
    expect(MOBILE_TRADE_PANEL_HEIGHT).toBe(420);
    expect(TABLET_TRADE_PANEL_HEIGHT).toBe(340);
    expect(DEFAULT_BOTTOM_DRAWER_FRACTION).toBe(0.3);
    expect(DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT).toBe(200);
    expect(INITIAL_BOTTOM_DRAWER_HEIGHT).toBe(220);
    expect(CHART_CHROME_HEIGHT).toBe(184);
    // The drawer no longer opens pinned to its own minimum height.
    expect(INITIAL_BOTTOM_DRAWER_HEIGHT).not.toBe(MIN_BOTTOM_DRAWER_HEIGHT);
  });

  test("the default share leaves room for more than a header and two rows", () => {
    // The drawer keeps 40px of its own header. The 0.22 share this replaced
    // opened a 900px terminal at 156px, leaving 116px of body: two position
    // rows, so the panel that answers "what am I holding" could not show a
    // third holding without a drag. The floor exists for the short viewport
    // where a percentage alone lands back in that state.
    const drawerHeaderHeight = 40;
    const availableHeight = 900 - CHART_CHROME_HEIGHT;
    const openedAt = Math.round(availableHeight * DEFAULT_BOTTOM_DRAWER_FRACTION);

    expect(openedAt - drawerHeaderHeight).toBeGreaterThan(140);
    expect(DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT).toBeGreaterThan(MIN_BOTTOM_DRAWER_HEIGHT);
  });
});

describe("clamp", () => {
  test("keeps a value inside [min, max] and tolerates inverted bounds", () => {
    expect(clamp(50, 0, 100)).toBe(50);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(500, 0, 100)).toBe(100);
    expect(clamp(5, 100, 0)).toBe(100);
  });
});

describe("parseStoredTradeHeight", () => {
  test("accepts a positive finite number and rejects everything else", () => {
    expect(parseStoredTradeHeight("240")).toBe(240);
    expect(parseStoredTradeHeight(null)).toBeNull();
    expect(parseStoredTradeHeight(undefined)).toBeNull();
    expect(parseStoredTradeHeight("")).toBeNull();
    expect(parseStoredTradeHeight("not-a-number")).toBeNull();
    expect(parseStoredTradeHeight("0")).toBeNull();
    expect(parseStoredTradeHeight("-40")).toBeNull();
  });
});

describe("finiteNumber", () => {
  test("coerces to a finite number, and only undefined for genuinely non-numeric input", () => {
    expect(finiteNumber("185.2")).toBe(185.2);
    expect(finiteNumber(185.2)).toBe(185.2);
    // `Number(null) === 0`, so null coerces to a finite 0 rather than "absent" -
    // this mirrors the pre-existing coercion, not a design choice of this test.
    expect(finiteNumber(null)).toBe(0);
    expect(finiteNumber(undefined)).toBeUndefined();
    expect(finiteNumber("not-a-number")).toBeUndefined();
  });
});

describe("resolveChromeHeight", () => {
  test("falls back to the static estimate only when the DOM measurement is empty", () => {
    expect(resolveChromeHeight(0)).toBe(CHART_CHROME_HEIGHT);
    expect(resolveChromeHeight(150)).toBe(150);
  });
});

describe("canResizeDrawer", () => {
  test("is resizable only when there is slack between min and max", () => {
    expect(canResizeDrawer(140, 400)).toBe(true);
    expect(canResizeDrawer(140, 140)).toBe(false);
    expect(canResizeDrawer(140, 100)).toBe(false);
  });
});

describe("computeTradeHeightBounds", () => {
  test("sizes the drawer to a fixed mobile height under 640px", () => {
    const bounds = computeTradeHeightBounds({ viewportWidth: 375, panelHeight: 800, chromeHeight: 0 });
    expect(bounds).toEqual({
      min: MOBILE_TRADE_PANEL_HEIGHT,
      max: 800,
      autoDefault: MOBILE_TRADE_PANEL_HEIGHT,
    });
  });

  test("sizes the drawer to a fixed tablet height between 640 and 1024px", () => {
    const bounds = computeTradeHeightBounds({ viewportWidth: 800, panelHeight: 900, chromeHeight: 0 });
    expect(bounds).toEqual({
      min: TABLET_TRADE_PANEL_HEIGHT,
      max: 900,
      autoDefault: TABLET_TRADE_PANEL_HEIGHT,
    });
  });

  test("never lets the compact max drop below the compact min, even on a short viewport", () => {
    const bounds = computeTradeHeightBounds({ viewportWidth: 375, panelHeight: 100, chromeHeight: 0 });
    expect(bounds.max).toBeGreaterThanOrEqual(bounds.min);
  });

  test("on desktop, defaults the drawer to a minority share of the available height", () => {
    const bounds = computeTradeHeightBounds({ viewportWidth: 1440, panelHeight: 900, chromeHeight: 184 });
    const availableHeight = 900 - 184;

    expect(bounds.min).toBe(MIN_BOTTOM_DRAWER_HEIGHT);
    expect(bounds.max).toBe(availableHeight - MIN_CHART_HEIGHT);
    expect(bounds.autoDefault).toBe(Math.round(availableHeight * DEFAULT_BOTTOM_DRAWER_FRACTION));
    // The chart, not the drawer, stays dominant.
    expect(bounds.autoDefault).toBeLessThan(availableHeight - bounds.autoDefault);
  });

  test("lifts a too-small proportional default to the drawer floor when there is room for it", () => {
    // 684px of panel leaves 500px of available height; 30% of that is 150px,
    // which is a header and four rows. There is room for the 200px floor here
    // (the chart still clears its own 260px minimum), so the floor applies.
    const bounds = computeTradeHeightBounds({
      viewportWidth: 1440,
      panelHeight: 684,
      chromeHeight: CHART_CHROME_HEIGHT,
    });
    const availableHeight = 684 - CHART_CHROME_HEIGHT;

    expect(Math.round(availableHeight * DEFAULT_BOTTOM_DRAWER_FRACTION)).toBeLessThan(
      DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT,
    );
    expect(bounds.autoDefault).toBe(DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT);
    expect(availableHeight - bounds.autoDefault).toBeGreaterThanOrEqual(MIN_CHART_HEIGHT);
  });

  test("the drawer floor never wins over the chart minimum", () => {
    // Squeeze the panel until the floor cannot fit. The chart's minimum, not
    // the drawer's preferred opening height, is what survives.
    const bounds = computeTradeHeightBounds({
      viewportWidth: 1440,
      panelHeight: 614,
      chromeHeight: CHART_CHROME_HEIGHT,
    });
    const availableHeight = 614 - CHART_CHROME_HEIGHT;

    expect(bounds.autoDefault).toBeLessThan(DEFAULT_BOTTOM_DRAWER_MIN_HEIGHT);
    expect(bounds.autoDefault).toBe(availableHeight - MIN_CHART_HEIGHT);
  });

  test("compact viewports are untouched by the desktop default", () => {
    // The mobile and tablet branches return fixed heights and never consult
    // the fraction or the floor, so raising the desktop default cannot change
    // what a phone or tablet opens at.
    expect(
      computeTradeHeightBounds({ viewportWidth: 375, panelHeight: 900, chromeHeight: 184 }),
    ).toEqual({
      min: MOBILE_TRADE_PANEL_HEIGHT,
      max: 900,
      autoDefault: MOBILE_TRADE_PANEL_HEIGHT,
    });
    expect(
      computeTradeHeightBounds({ viewportWidth: 1023, panelHeight: 900, chromeHeight: 184 }),
    ).toEqual({
      min: TABLET_TRADE_PANEL_HEIGHT,
      max: 900,
      autoDefault: TABLET_TRADE_PANEL_HEIGHT,
    });
  });

  test("clamps the desktop default and max so the chart never drops below its own minimum", () => {
    const bounds = computeTradeHeightBounds({ viewportWidth: 1440, panelHeight: 300, chromeHeight: 184 });
    expect(bounds.max).toBe(MIN_BOTTOM_DRAWER_HEIGHT);
    expect(bounds.autoDefault).toBe(MIN_BOTTOM_DRAWER_HEIGHT);
  });
});

describe("computeDragResizedHeight", () => {
  test("is the panel's bottom edge minus the pointer position, clamped to bounds", () => {
    expect(computeDragResizedHeight({ panelBottom: 900, pointerClientY: 700, min: 140, max: 400 })).toBe(200);
    expect(computeDragResizedHeight({ panelBottom: 900, pointerClientY: 890, min: 140, max: 400 })).toBe(140);
    expect(computeDragResizedHeight({ panelBottom: 900, pointerClientY: 100, min: 140, max: 400 })).toBe(400);
  });
});

describe("computeKeyboardResizedHeight", () => {
  const bounds = { min: 140, max: 400 };

  test("arrow keys step by 24px, or 48px with shift", () => {
    expect(computeKeyboardResizedHeight({ key: "ArrowUp", shiftKey: false, currentHeight: 200, ...bounds })).toBe(224);
    expect(computeKeyboardResizedHeight({ key: "ArrowDown", shiftKey: false, currentHeight: 200, ...bounds })).toBe(176);
    expect(computeKeyboardResizedHeight({ key: "ArrowUp", shiftKey: true, currentHeight: 200, ...bounds })).toBe(248);
    expect(computeKeyboardResizedHeight({ key: "ArrowDown", shiftKey: true, currentHeight: 200, ...bounds })).toBe(152);
  });

  test("Home/End jump to the bounds, and arrows clamp at them", () => {
    expect(computeKeyboardResizedHeight({ key: "Home", shiftKey: false, currentHeight: 200, ...bounds })).toBe(140);
    expect(computeKeyboardResizedHeight({ key: "End", shiftKey: false, currentHeight: 200, ...bounds })).toBe(400);
    expect(computeKeyboardResizedHeight({ key: "ArrowUp", shiftKey: false, currentHeight: 390, ...bounds })).toBe(400);
    expect(computeKeyboardResizedHeight({ key: "ArrowDown", shiftKey: false, currentHeight: 150, ...bounds })).toBe(140);
  });

  test("any other key is a no-op", () => {
    expect(computeKeyboardResizedHeight({ key: "Tab", shiftKey: false, currentHeight: 200, ...bounds })).toBeNull();
  });
});

describe("attachGlobalPointerDrag", () => {
  function createRecordingTarget() {
    const added: Array<{ type: string; listener: EventListenerOrEventListenerObject; options?: unknown }> = [];
    const removed: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = [];
    return {
      added,
      removed,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: unknown) {
        added.push({ type, listener, options });
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        removed.push({ type, listener });
      },
    };
  }

  test("listens on the given target (window in production), not just the handle, so a fast drag can't outrun it", () => {
    const target = createRecordingTarget();
    const detach = attachGlobalPointerDrag(target, { onMove: () => {}, onEnd: () => {} });

    expect(target.added.map((call) => call.type)).toEqual(["pointermove", "pointerup", "pointercancel"]);
    expect(target.added[0].options).toEqual({ passive: false });
    // pointerup and pointercancel share a single handler reference, so one
    // detach() call actually removes both (removeEventListener only works
    // when passed the exact function that was added).
    expect(target.added[1].listener).toBe(target.added[2].listener);

    detach();
    expect(target.removed).toHaveLength(3);
    for (const call of target.added) {
      expect(
        target.removed.some((r) => r.type === call.type && r.listener === call.listener),
      ).toBe(true);
    }
  });

  test("the pointermove listener forwards clientY and prevents the default (page-scroll) behavior", () => {
    const target = createRecordingTarget();
    const moves: number[] = [];
    attachGlobalPointerDrag(target, { onMove: (clientY) => moves.push(clientY), onEnd: () => {} });

    let prevented = false;
    const listener = target.added[0].listener as (event: Event) => void;
    listener({ clientY: 321, preventDefault: () => { prevented = true; } } as unknown as Event);

    expect(moves).toEqual([321]);
    expect(prevented).toBe(true);
  });

  test("pointerup or pointercancel ends the drag", () => {
    const target = createRecordingTarget();
    let ended = 0;
    attachGlobalPointerDrag(target, { onMove: () => {}, onEnd: () => { ended += 1; } });

    const pointerUpListener = target.added[1].listener as (event: Event) => void;
    pointerUpListener({} as Event);
    expect(ended).toBe(1);

    const pointerCancelListener = target.added[2].listener as (event: Event) => void;
    pointerCancelListener({} as Event);
    expect(ended).toBe(2);
  });
});
