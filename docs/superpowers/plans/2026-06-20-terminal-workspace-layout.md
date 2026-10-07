# Terminal Workspace Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live, annotatable Ready Set Trade terminal layout guided by the Fomo terminal reference: dominant center chart, unified collapsible/splittable left and right drawers, embedded tab banners, and less dead space.

**Architecture:** Add a pure terminal layout state model, reusable terminal drawer chrome, and a measured center chart host. Existing data panels remain the source of truth; they receive presentation props so they can render inside drawer tiles without nested card chrome. The app page owns active symbol/account/trade state and maps drawer tabs to the existing panels.

**Tech Stack:** Next.js App Router, React client components, Tailwind/shadcn, lightweight-charts, tRPC, Bun tests.

---

## Files

- Create: `apps/web-v2/src/components/terminal/terminal-layout-state.ts`
- Create: `apps/web-v2/src/components/terminal/terminal-layout-state.test.ts`
- Create: `apps/web-v2/src/components/terminal/terminal-drawer.tsx`
- Create: `apps/web-v2/src/components/terminal/terminal-drawer.test.tsx`
- Create: `apps/web-v2/src/components/terminal/terminal-chart-panel.tsx`
- Modify: `apps/web-v2/src/app/app/page.tsx`
- Modify: `apps/web-v2/src/app/app/page-layout.test.ts`
- Modify: `apps/web-v2/src/components/trade/trade-form.tsx`
- Modify: `apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts`
- Modify: `apps/web-v2/src/components/feed/signal-feed.tsx`
- Modify: `apps/web-v2/src/components/signa/signa-signals-panel.tsx`
- Modify: `apps/web-v2/src/components/watchlist/watchlist-panel.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Modify: `apps/web-v2/src/components/social/social-feed-panel.tsx`
- Modify: `apps/web-v2/src/components/chat/stock-chat-panel.tsx`
- Modify: `apps/web-v2/src/components/trade/positions-panel.tsx`
- Modify: `apps/web-v2/src/components/trade/open-orders-panel.tsx`
- Modify: `apps/web-v2/src/components/charts/portfolio-history-chart.tsx`

---

### Task 1: Pure Terminal Layout State

**Files:**
- Create: `apps/web-v2/src/components/terminal/terminal-layout-state.ts`
- Create: `apps/web-v2/src/components/terminal/terminal-layout-state.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
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

  test("does not split past two panes", () => {
    const first = splitPane(DEFAULT_TERMINAL_LAYOUT, "right", "right");
    const second = splitPane(first, "right", "bottom");
    expect(second.right.panes).toHaveLength(2);
    expect(second.right.split).toBe("right");
  });

  test("closing one split pane restores the surviving pane to a full drawer", () => {
    const split = splitPane(DEFAULT_TERMINAL_LAYOUT, "left", "bottom");
    const remainingId = split.left.panes[1]!.id;
    const closed = closePane(split, "left", split.left.panes[0]!.id);
    expect(closed.left.split).toBeNull();
    expect(closed.left.panes).toEqual([{ id: remainingId, tab: "watchlist" }]);
  });

  test("collapse and tab updates are drawer-scoped", () => {
    const collapsed = collapseDrawer(DEFAULT_TERMINAL_LAYOUT, "right", true);
    expect(collapsed.right.collapsed).toBe(true);
    expect(collapsed.left.collapsed).toBe(false);

    const paneId = collapsed.right.panes[0]!.id;
    const updated = updatePaneTab(collapsed, "right", paneId, "ai");
    expect(updated.right.panes[0]?.tab).toBe("ai");
  });

  test("malformed persisted layout falls back to defaults", () => {
    expect(parseTerminalLayout("{not json")).toEqual(DEFAULT_TERMINAL_LAYOUT);
    expect(parseTerminalLayout(JSON.stringify({ version: 999 }))).toEqual(
      DEFAULT_TERMINAL_LAYOUT,
    );
  });
});
```

- [ ] **Step 2: Implement the pure model**

```ts
export type TerminalSide = "left" | "right";
export type TerminalSplit = "bottom" | "right";
export type LeftTerminalTab = "x_signals" | "signa" | "watchlist" | "copy_trade" | "social";
export type RightTerminalTab = "trade" | "ai" | "positions" | "orders" | "portfolio";
export type TerminalTab<S extends TerminalSide> = S extends "left" ? LeftTerminalTab : RightTerminalTab;

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
```

Implement `splitPane`, `closePane`, `collapseDrawer`, `updatePaneTab`, `parseTerminalLayout`, and `serializeTerminalLayout`. Use deterministic pane IDs (`left-a`, `left-b`, `right-a`, `right-b`) so persistence and tests remain stable.

- [ ] **Step 3: Run the focused test**

Run: `bun test apps/web-v2/src/components/terminal/terminal-layout-state.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/web-v2/src/components/terminal/terminal-layout-state.ts apps/web-v2/src/components/terminal/terminal-layout-state.test.ts
git commit -m "feat: add terminal layout state"
```

---

### Task 2: Terminal Drawer Chrome

**Files:**
- Create: `apps/web-v2/src/components/terminal/terminal-drawer.tsx`
- Create: `apps/web-v2/src/components/terminal/terminal-drawer.test.tsx`

- [ ] **Step 1: Write failing render tests**

Use `renderToStaticMarkup` to assert:
- drawer has `aria-label`;
- double-chevron collapse button exists;
- active tab has `aria-pressed="true"`;
- split buttons disable at two panes;
- close button appears only when two panes exist;
- split-right has responsive fallback classes.

- [ ] **Step 2: Implement `TerminalDrawer`**

Create a client component with props:

```ts
interface TerminalDrawerProps<T extends string> {
  side: "left" | "right";
  title: string;
  tabs: Array<{ value: T; label: string }>;
  state: TerminalDrawerState<T>;
  collapsedLabel: string;
  renderPane: (tab: T, paneId: string) => React.ReactNode;
  onCollapse: (collapsed: boolean) => void;
  onSplit: (direction: TerminalSplit) => void;
  onClosePane: (paneId: string) => void;
  onTabChange: (paneId: string, tab: T) => void;
}
```

Use `ChevronsLeft`, `ChevronsRight`, `PanelBottom`, `PanelRight`, and `X` from `lucide-react`. Use one outer border frame, compact tab banner per tile, and `min-h-0` everywhere.

- [ ] **Step 3: Run drawer tests**

Run: `bun test apps/web-v2/src/components/terminal/terminal-drawer.test.tsx`

- [ ] **Step 4: Commit**

```bash
git add apps/web-v2/src/components/terminal/terminal-drawer.tsx apps/web-v2/src/components/terminal/terminal-drawer.test.tsx
git commit -m "feat: add terminal drawer chrome"
```

---

### Task 3: Dominant Center Chart And TradeForm Sync

**Files:**
- Create: `apps/web-v2/src/components/terminal/terminal-chart-panel.tsx`
- Modify: `apps/web-v2/src/components/trade/trade-form.tsx`
- Modify: `apps/web-v2/src/app/app/page-layout.test.ts`

- [ ] **Step 1: Write failing source tests**

Extend `page-layout.test.ts` to assert:
- `useState("SPY")`;
- a persistent `<TerminalChartPanel`;
- `<TradeForm` receives `showChart={false}`;
- `onSymbolCommit={handleTradeSymbolCommit}` exists.

- [ ] **Step 2: Implement `TerminalChartPanel`**

Use `ResizeObserver` to measure a `flex-1 min-h-0` chart host and pass the measured height to `LiveChart`. Keep a compact symbol form above the chart.

- [ ] **Step 3: Add TradeForm props**

Add:

```ts
showChart?: boolean;
embedded?: boolean;
onSymbolCommit?: (symbol: string) => void;
```

Default `showChart` to `true`. Gate the existing internal chart with `showChart`. Invoke `onSymbolCommit` from the existing debounced symbol effect only when the normalized symbol is non-empty.

- [ ] **Step 4: Run focused tests**

Run: `bun test apps/web-v2/src/app/app/page-layout.test.ts apps/web-v2/src/components/trade/__tests__/trade-form.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/web-v2/src/components/terminal/terminal-chart-panel.tsx apps/web-v2/src/components/trade/trade-form.tsx apps/web-v2/src/app/app/page-layout.test.ts
git commit -m "feat: add persistent terminal chart"
```

---

### Task 4: Embedded Presentation For Existing Panels

**Files:**
- Modify: `apps/web-v2/src/components/feed/signal-feed.tsx`
- Modify: `apps/web-v2/src/components/signa/signa-signals-panel.tsx`
- Modify: `apps/web-v2/src/components/watchlist/watchlist-panel.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Modify: `apps/web-v2/src/components/social/social-feed-panel.tsx`
- Modify: `apps/web-v2/src/components/chat/stock-chat-panel.tsx`
- Modify: `apps/web-v2/src/components/trade/positions-panel.tsx`
- Modify: `apps/web-v2/src/components/trade/open-orders-panel.tsx`
- Modify: `apps/web-v2/src/components/charts/portfolio-history-chart.tsx`

- [ ] **Step 1: Add narrow presentation props**

Add `embedded?: boolean` to panel props. For `TradeForm`, use the props from Task 3.

- [ ] **Step 2: Replace fixed card chrome in embedded mode**

In embedded mode, each panel should render `h-full min-h-0 overflow-hidden` and use one internal scroll region. Preserve all existing data queries, filters, buttons, warnings, and mutation behavior.

- [ ] **Step 3: Keep card mode unchanged**

When `embedded` is false/undefined, existing route behavior must remain visually and behaviorally unchanged.

- [ ] **Step 4: Run focused panel tests**

Run:

```bash
bun test apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts \
  apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts \
  apps/web-v2/src/components/watchlist/watchlist-panel.test.ts \
  apps/web-v2/src/components/charts/__tests__/portfolio-history-chart.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web-v2/src/components/feed/signal-feed.tsx apps/web-v2/src/components/signa/signa-signals-panel.tsx apps/web-v2/src/components/watchlist/watchlist-panel.tsx apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx apps/web-v2/src/components/social/social-feed-panel.tsx apps/web-v2/src/components/chat/stock-chat-panel.tsx apps/web-v2/src/components/trade/positions-panel.tsx apps/web-v2/src/components/trade/open-orders-panel.tsx apps/web-v2/src/components/charts/portfolio-history-chart.tsx
git commit -m "feat: embed dashboard panels in terminal drawers"
```

---

### Task 5: App Page Terminal Integration

**Files:**
- Modify: `apps/web-v2/src/app/app/page.tsx`
- Modify: `apps/web-v2/src/app/app/page-layout.test.ts`
- Modify: `apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts`

- [ ] **Step 1: Replace the three-column dashboard with terminal shell**

Use `TerminalDrawer` for left and right sides. Render `TerminalChartPanel` in the center. Remove `max-w-[1720px]`, route padding, and large `gap-6`.

- [ ] **Step 2: Wire left tabs**

Left tabs map to existing panels:
- `x_signals` -> `SignalFeed embedded`
- `signa` -> `SignaSignalsPanel embedded`
- `watchlist` -> `WatchlistPanel embedded`
- `copy_trade` -> `CopyTradePanel embedded`
- `social` -> `SocialFeedPanel embedded`

- [ ] **Step 3: Wire right tabs**

Right tabs map to:
- `trade` -> `TradeForm embedded showChart={false}`
- `ai` -> `StockChatPanel embedded`
- `positions` -> `PositionsPanel embedded`
- `orders` -> `OpenOrdersPanel embedded`
- `portfolio` -> `PortfolioHistoryChart embedded`

Copy actions activate the right `trade` tab. Ask-AI actions activate the right `ai` tab. Passive ticker selection updates the center chart but keeps the right tab unchanged.

- [ ] **Step 4: Add localStorage persistence**

Persist layout with `serializeTerminalLayout`. Hydrate after mount with `parseTerminalLayout`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test apps/web-v2/src/app/app/page-layout.test.ts \
  apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts \
  apps/web-v2/src/components/terminal/terminal-layout-state.test.ts \
  apps/web-v2/src/components/terminal/terminal-drawer.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add apps/web-v2/src/app/app/page.tsx apps/web-v2/src/app/app/page-layout.test.ts apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts
git commit -m "feat: integrate terminal workspace dashboard"
```

---

### Task 6: Verification And Live Browser Pass

**Files:**
- Modify as needed only for fixes found during verification.

- [ ] **Step 1: Run automated checks**

```bash
bun test apps/web-v2
bun --filter @trade-bot/web typecheck
bun --filter @trade-bot/web build
bun run lint
bun test
```

- [ ] **Step 2: Start the local app**

Use the project’s existing local Docker/API/web flow. Do not change production credentials or database schema.

- [ ] **Step 3: Browser verify**

Open `http://localhost:3000/app` and verify:
- chart is materially larger than before;
- left drawer collapses/expands;
- right drawer collapses/expands;
- split bottom and split right work on both sides;
- split tiles have independent tab selections;
- ticker clicks update the center chart;
- right Trade symbol changes update the center chart;
- AI can live in the right pane;
- no horizontal overflow at 1280px, 1440px, and mobile width.

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add <changed-files>
git commit -m "fix: polish terminal workspace layout"
```

