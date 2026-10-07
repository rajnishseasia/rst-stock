import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TERMINAL_LAYOUT,
  closePane,
  collapseDrawer,
  parseTerminalLayout,
  splitPane,
  updatePaneTab,
} from "./terminal-layout-state";

describe("terminal layout state", () => {
  test("starts with one left discovery tile and one right trade tile", () => {
    expect(DEFAULT_TERMINAL_LAYOUT.left.panes).toHaveLength(1);
    expect(DEFAULT_TERMINAL_LAYOUT.left.panes[0]?.tab).toBe("x_signals");
    expect(DEFAULT_TERMINAL_LAYOUT.right.panes).toHaveLength(1);
    expect(DEFAULT_TERMINAL_LAYOUT.right.panes[0]?.tab).toBe("trade");
  });

  test("splits one drawer into two independent panes", () => {
    const layout = splitPane(DEFAULT_TERMINAL_LAYOUT, "left", "bottom");
    expect(layout.left.split).toBe("bottom");
    expect(layout.left.panes).toHaveLength(2);
    expect(layout.left.panes[0]?.id).not.toBe(layout.left.panes[1]?.id);
  });

  test("updating the second split pane leaves the first tab unchanged", () => {
    const split = splitPane(DEFAULT_TERMINAL_LAYOUT, "left", "bottom");
    const firstPane = split.left.panes[0]!;
    const secondPane = split.left.panes[1]!;

    const updated = updatePaneTab(split, "left", secondPane.id, "signa");

    expect(updated.left.panes[0]?.tab).toBe(firstPane.tab);
    expect(updated.left.panes[1]).toEqual({ ...secondPane, tab: "signa" });
  });

  test("does not split past two panes", () => {
    const first = splitPane(DEFAULT_TERMINAL_LAYOUT, "right", "right");
    const second = splitPane(first, "right", "bottom");
    expect(second.right.panes).toHaveLength(2);
    expect(second.right.split).toBe("right");
  });

  test("splitting the right modules drawer chooses an independent module tab", () => {
    const splitFromTrade = splitPane(DEFAULT_TERMINAL_LAYOUT, "right", "bottom");
    expect(splitFromTrade.right.panes.map((pane) => pane.tab)).toEqual([
      "trade",
      "positions",
    ]);

    const paneId = DEFAULT_TERMINAL_LAYOUT.right.panes[0]!.id;
    const positionsFirst = updatePaneTab(
      DEFAULT_TERMINAL_LAYOUT,
      "right",
      paneId,
      "positions",
    );
    const splitFromPositions = splitPane(positionsFirst, "right", "bottom");
    expect(splitFromPositions.right.panes.map((pane) => pane.tab)).toEqual([
      "positions",
      "trade",
    ]);
  });

  test("closing one split pane restores the surviving pane to a full drawer", () => {
    const split = splitPane(DEFAULT_TERMINAL_LAYOUT, "left", "bottom");
    const closed = closePane(split, "left", split.left.panes[0]!.id);
    expect(closed.left.split).toBeNull();
    // The survivor keeps its TAB but is re-seated into the first slot. It used
    // to keep "left-b", which is what made the next split collide.
    expect(closed.left.panes).toEqual([{ id: "left-a", tab: "watchlist" }]);
  });

  test("split -> close the FIRST pane -> split again does not duplicate a pane id", () => {
    // Reachable from the plain UI, no crafted payload: closing pane one left the
    // survivor holding "left-b", and splitPane appends a hard-coded "left-b", so
    // both panes shared a React key. A tab change then hit both at once and
    // closing one filtered out both, leaving a drawer the user could not repair.
    const split = splitPane(DEFAULT_TERMINAL_LAYOUT, "left", "bottom");
    const closed = closePane(split, "left", split.left.panes[0]!.id);
    const resplit = splitPane(closed, "left", "bottom");

    const ids = resplit.left.panes.map((pane) => pane.id);
    expect(ids).toEqual(["left-a", "left-b"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the same holds for the right drawer", () => {
    const split = splitPane(DEFAULT_TERMINAL_LAYOUT, "right", "bottom");
    const closed = closePane(split, "right", split.right.panes[0]!.id);
    expect(closed.right.panes.map((pane) => pane.id)).toEqual(["right-a"]);

    const resplit = splitPane(closed, "right", "bottom");
    const ids = resplit.right.panes.map((pane) => pane.id);
    expect(ids).toEqual(["right-a", "right-b"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("collapse and tab updates are drawer-scoped", () => {
    const collapsed = collapseDrawer(DEFAULT_TERMINAL_LAYOUT, "right", true);
    expect(collapsed.right.collapsed).toBe(true);
    // Left is unchanged (default is expanded; collapsing right must not affect left)
    expect(collapsed.left.collapsed).toBe(false);

    const paneId = collapsed.right.panes[0]!.id;
    const updated = updatePaneTab(collapsed, "right", paneId, "ai");
    expect(updated.right.panes[0]?.tab).toBe("ai");
  });

  test("malformed persisted layout falls back to defaults", () => {
    expect(parseTerminalLayout("{not json")).toEqual(DEFAULT_TERMINAL_LAYOUT);
    expect(parseTerminalLayout(JSON.stringify({ version: 999 }))).toEqual(
      DEFAULT_TERMINAL_LAYOUT
    );
  });

  test("preserves right trade panes without resetting discovery layout", () => {
    const parsed = parseTerminalLayout(
      JSON.stringify({
        version: 1,
        left: {
          collapsed: false,
          split: "bottom",
          panes: [
            { id: "left-a", tab: "copy_trade" },
            { id: "left-b", tab: "watchlist" },
          ],
        },
        right: {
          collapsed: false,
          split: null,
          panes: [{ id: "right-a", tab: "trade" }],
        },
      }),
    );

    expect(parsed.left.split).toBe("bottom");
    expect(parsed.left.panes.map((pane) => pane.tab)).toEqual([
      "copy_trade",
      "watchlist",
    ]);
    expect(parsed.right.panes).toEqual([{ id: "right-a", tab: "trade" }]);
  });
});
