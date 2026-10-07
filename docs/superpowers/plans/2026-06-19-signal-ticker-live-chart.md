# Signal Ticker Live Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tickers in X Signals, Signa Signals, Copy Trade, Community Trades, and Community Hot Symbols open the existing Live Chart.

**Architecture:** Each feed receives a dedicated `onViewSymbol(symbol)` callback and renders its ticker as an accessible button. The dashboard owns the shared handler that clears source-specific prefills, selects the symbol, activates New Trade, and scrolls the chart column on narrow screens.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS, Bun tests, in-app Browser.

---

### Task 1: Add Failing Navigation Contract Tests

**Files:**
- Create: `apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts`
- Read: `apps/web-v2/src/components/feed/signal-feed.tsx`
- Read: `apps/web-v2/src/components/signa/signa-signals-panel.tsx`
- Read: `apps/web-v2/src/components/signa/best-pick-row.tsx`
- Read: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Read: `apps/web-v2/src/components/social/social-feed-panel.tsx`
- Read: `apps/web-v2/src/app/app/page.tsx`

- [ ] **Step 1: Write the failing source-contract test**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sources = {
  x: read("./signal-feed.tsx"),
  signa: read("../signa/signa-signals-panel.tsx"),
  bestPick: read("../signa/best-pick-row.tsx"),
  copyTrade: read("../copy-trade/copy-trade-panel.tsx"),
  community: read("../social/social-feed-panel.tsx"),
  dashboard: read("../../app/app/page.tsx"),
};

describe("feed ticker chart navigation", () => {
  test("routes every feed ticker through onViewSymbol", () => {
    expect(sources.x).toContain("onViewSymbol(t.symbol)");
    expect(sources.signa).toContain("onViewSymbol(pick.ticker)");
    expect(sources.bestPick).toContain("onViewSymbol");
    expect(sources.copyTrade).toContain("onViewSymbol(item.symbol)");
    expect(sources.community).toContain("onViewSymbol(hot.symbol)");
    expect(sources.community).toContain("onViewSymbol(trade.symbol)");
  });

  test("uses chart-specific accessible labels", () => {
    for (const key of ["x", "signa", "bestPick", "copyTrade", "community"] as const) {
      expect(sources[key]).toContain("live chart");
    }
  });

  test("dashboard reveals New Trade and scrolls the chart", () => {
    expect(sources.dashboard).toContain('setActiveTab("quick")');
    expect(sources.dashboard).toContain("chartColumnRef.current?.scrollIntoView");
    expect(sources.dashboard.match(/onViewSymbol=\{handleTradeSymbol\}/g)?.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts`

Expected: FAIL because the feed components do not expose or call `onViewSymbol`.

### Task 2: Wire Accessible Ticker Buttons

**Files:**
- Modify: `apps/web-v2/src/components/feed/signal-feed.tsx`
- Modify: `apps/web-v2/src/components/signa/signa-signals-panel.tsx`
- Modify: `apps/web-v2/src/components/signa/best-pick-row.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Modify: `apps/web-v2/src/components/social/social-feed-panel.tsx`

- [ ] **Step 1: Add the callback to each public panel prop**

```ts
onViewSymbol: (symbol: string) => void;
```

- [ ] **Step 2: Thread callbacks into nested Signa rows**

```tsx
<SignalRow onViewSymbol={() => onViewSymbol(pick.ticker)} />
<BestPickRow onViewSymbol={() => onViewSymbol(pick.ticker)} />
```

- [ ] **Step 3: Replace inert ticker text with native buttons**

Use this interaction pattern at every ticker surface, preserving each surface's current typography and color classes:

```tsx
<button
  type="button"
  onClick={() => onViewSymbol(symbol)}
  aria-label={`View $${symbol} live chart`}
  title={`View $${symbol} live chart`}
  className="cursor-pointer rounded-sm font-bold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  ${symbol}
</button>
```

- [ ] **Step 4: Run the contract test and verify remaining dashboard failure**

Run: `bun test apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts`

Expected: feed assertions PASS; dashboard wiring assertion still FAILS.

### Task 3: Connect The Shared Dashboard Handler

**Files:**
- Modify: `apps/web-v2/src/app/app/page.tsx`

- [ ] **Step 1: Make the existing symbol handler reveal the chart**

```ts
const handleTradeSymbol = (symbol: string) => {
  clearCopyPrefill();
  clearSignaPrefill();
  setSelectedSignal(null);
  setActiveSymbol(symbol);
  setActiveTab("quick");
  if (typeof window !== "undefined" && window.innerWidth < 1280) {
    chartColumnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
};
```

- [ ] **Step 2: Pass it to all four feed panels**

```tsx
<SignalFeed onViewSymbol={handleTradeSymbol} />
<SignaSignalsPanel onViewSymbol={handleTradeSymbol} />
<CopyTradePanel onViewSymbol={handleTradeSymbol} />
<SocialFeedPanel onViewSymbol={handleTradeSymbol} />
```

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `bun test apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts apps/web-v2/src/components/feed/signal-feed.test.ts apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts apps/web-v2/src/app/app/page-layout.test.ts`

Expected: PASS.

### Task 4: Verify The Feature

**Files:**
- Test: `apps/web-v2/src/components/feed/ticker-chart-navigation.test.ts`

- [ ] **Step 1: Run web validation**

Run: `bun --filter @trade-bot/web typecheck`

Run: `bun test apps/web-v2/src`

Run: `bun run lint`

Expected: all commands exit 0; existing lint warnings may remain, with no new errors.

- [ ] **Step 2: Start local dependencies and app services**

Run Docker Postgres/Redis using the repository compose file, then start API and web development servers on ports 3001 and 3000. Do not start the worker and do not place orders.

- [ ] **Step 3: Verify with the in-app Browser**

Flow: `http://localhost:3000/app` -> click a visible ticker in each available feed -> confirm New Trade is selected and the Live Chart displays that symbol.

Also verify page identity, nonblank DOM, no framework overlay, relevant console health, screenshot evidence, and at least one exact ticker-to-chart state transition.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/superpowers apps/web-v2/src
git commit -m "feat: open live chart from feed tickers"
git push -u origin codex/signal-ticker-live-chart
gh pr create --base main --head codex/signal-ticker-live-chart
```
