export type TerminalSide = "left" | "right";
export type TerminalSplit = "bottom" | "right";
export type LeftTerminalTab =
  | "x_signals"
  | "signa"
  | "watchlist"
  | "copy_trade"
  | "social"
  | "hl_markets";
export type RightTerminalTab =
  | "trade"
  | "ai"
  | "positions"
  | "orders"
  | "portfolio";
export type TerminalTab<S extends TerminalSide> = S extends "left"
  ? LeftTerminalTab
  : RightTerminalTab;

export interface TerminalPane<T extends string = string> {
  id: string;
  tab: T;
}

export interface TerminalDrawerState<T extends string = string> {
  collapsed: boolean;
  split: TerminalSplit | null;
  panes: TerminalPane<T>[];
}

export interface TerminalLayoutState {
  version: 1;
  left: TerminalDrawerState<LeftTerminalTab>;
  right: TerminalDrawerState<RightTerminalTab>;
}

const LEFT_TABS: readonly LeftTerminalTab[] = [
  "x_signals",
  "signa",
  "watchlist",
  "copy_trade",
  "social",
  "hl_markets",
];

const RIGHT_TABS: readonly RightTerminalTab[] = [
  "trade",
  "positions",
  "orders",
  "portfolio",
  "ai",
];

/**
 * Pane slots, POSITIONAL. A drawer's Nth pane always occupies the Nth slot, so
 * `splitPane` can append the "-b" slot knowing it is free. Any operation that
 * removes a pane must re-seat the survivors (see `closePane`), otherwise a lone
 * "left-b" is left behind and the next split appends a second "left-b".
 */
export const PANE_IDS = {
  left: ["left-a", "left-b"],
  right: ["right-a", "right-b"],
} as const;

export const DEFAULT_TERMINAL_LAYOUT: TerminalLayoutState = {
  version: 1,
  left: {
    collapsed: false,
    split: null,
    panes: [{ id: "left-a", tab: "x_signals" }],
  },
  right: {
    collapsed: false,
    split: null,
    panes: [{ id: "right-a", tab: "trade" }],
  },
};

function cloneLayout(layout: TerminalLayoutState): TerminalLayoutState {
  return {
    version: 1,
    left: {
      collapsed: layout.left.collapsed,
      split: layout.left.split,
      panes: layout.left.panes.map((pane) => ({ ...pane })),
    },
    right: {
      collapsed: layout.right.collapsed,
      split: layout.right.split,
      panes: layout.right.panes.map((pane) => ({ ...pane })),
    },
  };
}

function defaultSplitTab(side: "left"): LeftTerminalTab;
function defaultSplitTab(side: "right"): RightTerminalTab;
function defaultSplitTab(side: TerminalSide): LeftTerminalTab | RightTerminalTab {
  return side === "left" ? "watchlist" : "positions";
}

function setDrawer(
  layout: TerminalLayoutState,
  side: "left",
  drawer: TerminalDrawerState<LeftTerminalTab>
): TerminalLayoutState;
function setDrawer(
  layout: TerminalLayoutState,
  side: "right",
  drawer: TerminalDrawerState<RightTerminalTab>
): TerminalLayoutState;
function setDrawer(
  layout: TerminalLayoutState,
  side: TerminalSide,
  drawer:
    | TerminalDrawerState<LeftTerminalTab>
    | TerminalDrawerState<RightTerminalTab>
): TerminalLayoutState {
  return side === "left"
    ? { ...layout, left: drawer as TerminalDrawerState<LeftTerminalTab> }
    : { ...layout, right: drawer as TerminalDrawerState<RightTerminalTab> };
}

export function splitPane(
  layout: TerminalLayoutState,
  side: "left",
  split: TerminalSplit
): TerminalLayoutState;
export function splitPane(
  layout: TerminalLayoutState,
  side: "right",
  split: TerminalSplit
): TerminalLayoutState;
export function splitPane(
  layout: TerminalLayoutState,
  side: TerminalSide,
  split: TerminalSplit
): TerminalLayoutState {
  if (side === "left") {
    if (layout.left.panes.length >= 2) return layout;

    return setDrawer(layout, "left", {
      ...layout.left,
      split,
      panes: [
        ...layout.left.panes.map((pane) => ({ ...pane })),
        { id: "left-b", tab: defaultSplitTab("left") },
      ],
    });
  }

  if (layout.right.panes.length >= 2) return layout;

  const nextRightTab =
    RIGHT_TABS.find(
      (tab) => !layout.right.panes.some((pane) => pane.tab === tab),
    ) ?? defaultSplitTab("right");

  return setDrawer(layout, "right", {
    ...layout.right,
    split,
    panes: [
      ...layout.right.panes.map((pane) => ({ ...pane })),
      { id: "right-b", tab: nextRightTab },
    ],
  });
}

export function closePane(
  layout: TerminalLayoutState,
  side: "left",
  paneId: string
): TerminalLayoutState;
export function closePane(
  layout: TerminalLayoutState,
  side: "right",
  paneId: string
): TerminalLayoutState;
export function closePane(
  layout: TerminalLayoutState,
  side: TerminalSide,
  paneId: string
): TerminalLayoutState {
  if (side === "left") {
    // Re-seat onto the canonical slots. Closing the FIRST pane used to leave
    // the survivor holding "left-b"; splitting again then appended a second
    // "left-b", so the two panes shared a React key and a tab change or close
    // hit both at once. Reachable from the plain UI, not just a crafted save.
    const panes = layout.left.panes
      .filter((pane) => pane.id !== paneId)
      .map((pane, index) => ({ ...pane, id: PANE_IDS.left[index] }));

    if (panes.length === layout.left.panes.length || panes.length === 0) {
      return layout;
    }

    return setDrawer(layout, "left", {
      ...layout.left,
      split: panes.length === 1 ? null : layout.left.split,
      panes,
    });
  }

  const panes = layout.right.panes
    .filter((pane) => pane.id !== paneId)
    .map((pane, index) => ({ ...pane, id: PANE_IDS.right[index] }));

  if (panes.length === layout.right.panes.length || panes.length === 0) {
    return layout;
  }

  return setDrawer(layout, "right", {
    ...layout.right,
    split: panes.length === 1 ? null : layout.right.split,
    panes,
  });
}

export function collapseDrawer(
  layout: TerminalLayoutState,
  side: "left",
  collapsed: boolean
): TerminalLayoutState;
export function collapseDrawer(
  layout: TerminalLayoutState,
  side: "right",
  collapsed: boolean
): TerminalLayoutState;
export function collapseDrawer(
  layout: TerminalLayoutState,
  side: TerminalSide,
  collapsed: boolean
): TerminalLayoutState {
  if (side === "left") {
    return setDrawer(layout, "left", { ...layout.left, collapsed });
  }

  return setDrawer(layout, "right", { ...layout.right, collapsed });
}

export function updatePaneTab(
  layout: TerminalLayoutState,
  side: "left",
  paneId: string,
  tab: LeftTerminalTab
): TerminalLayoutState;
export function updatePaneTab(
  layout: TerminalLayoutState,
  side: "right",
  paneId: string,
  tab: RightTerminalTab
): TerminalLayoutState;
export function updatePaneTab(
  layout: TerminalLayoutState,
  side: TerminalSide,
  paneId: string,
  tab: LeftTerminalTab | RightTerminalTab
): TerminalLayoutState {
  if (side === "left") {
    return setDrawer(layout, "left", {
      ...layout.left,
      panes: layout.left.panes.map((pane) =>
        pane.id === paneId ? { ...pane, tab: tab as LeftTerminalTab } : { ...pane }
      ),
    });
  }

  return setDrawer(layout, "right", {
    ...layout.right,
    panes: layout.right.panes.map((pane) =>
      pane.id === paneId ? { ...pane, tab: tab as RightTerminalTab } : { ...pane }
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTerminalSplit(value: unknown): value is TerminalSplit | null {
  return value === null || value === "bottom" || value === "right";
}

function isLeftTab(value: unknown): value is LeftTerminalTab {
  return typeof value === "string" && LEFT_TABS.includes(value as LeftTerminalTab);
}

function isRightTab(value: unknown): value is RightTerminalTab {
  return typeof value === "string" && RIGHT_TABS.includes(value as RightTerminalTab);
}

function migrateRightTab(value: unknown): RightTerminalTab | null {
  if (isRightTab(value)) return value;

  // v1 of the terminal layout kept Trade in the right drawer. Trade now lives
  // under the chart, so preserve the rest of the saved workspace and move that
  // legacy drawer pane to AI instead of resetting the whole layout.
  if (value === "trade") return "ai";

  return null;
}

function isPaneIdForSide(
  side: TerminalSide,
  id: unknown,
  index: number,
): id is string {
  // Positional, not mere membership: a stored `[{ id: "left-b" }]` would pass a
  // membership check, and the next split would append a duplicate "left-b".
  return typeof id === "string" && id === PANE_IDS[side][index];
}

function hasUniquePaneIds(panes: Array<TerminalPane<string>>): boolean {
  return new Set(panes.map((pane) => pane.id)).size === panes.length;
}

function parseDrawer(
  value: unknown,
  side: "left"
): TerminalDrawerState<LeftTerminalTab> | null;
function parseDrawer(
  value: unknown,
  side: "right"
): TerminalDrawerState<RightTerminalTab> | null;
function parseDrawer(
  value: unknown,
  side: TerminalSide
):
  | TerminalDrawerState<LeftTerminalTab>
  | TerminalDrawerState<RightTerminalTab>
  | null {
  if (!isRecord(value) || typeof value.collapsed !== "boolean") return null;
  if (!isTerminalSplit(value.split) || !Array.isArray(value.panes)) return null;
  if (value.panes.length < 1 || value.panes.length > 2) return null;
  if (value.split === null && value.panes.length !== 1) return null;
  if (value.split !== null && value.panes.length !== 2) return null;

  const panes: Array<TerminalPane<string>> = [];
  for (const [index, pane] of value.panes.entries()) {
    if (!isRecord(pane) || !isPaneIdForSide(side, pane.id, index)) return null;
    if (side === "left" && !isLeftTab(pane.tab)) return null;
    if (side === "right" && !migrateRightTab(pane.tab)) return null;

    panes.push({
      id: pane.id,
      tab:
        side === "right"
          ? migrateRightTab(pane.tab)!
          : (pane.tab as string),
    });
  }

  if (!hasUniquePaneIds(panes)) return null;

  return {
    collapsed: value.collapsed,
    split: value.split,
    panes,
  } as TerminalDrawerState<LeftTerminalTab> | TerminalDrawerState<RightTerminalTab>;
}

export function parseTerminalLayout(
  persistedLayout: string | null | undefined
): TerminalLayoutState {
  if (!persistedLayout) return cloneLayout(DEFAULT_TERMINAL_LAYOUT);

  try {
    const parsed = JSON.parse(persistedLayout) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return cloneLayout(DEFAULT_TERMINAL_LAYOUT);
    }

    const left = parseDrawer(parsed.left, "left");
    const right = parseDrawer(parsed.right, "right");
    if (!left || !right) return cloneLayout(DEFAULT_TERMINAL_LAYOUT);

    return {
      version: 1,
      left,
      right,
    };
  } catch {
    return cloneLayout(DEFAULT_TERMINAL_LAYOUT);
  }
}

export function serializeTerminalLayout(layout: TerminalLayoutState): string {
  return JSON.stringify(layout);
}
