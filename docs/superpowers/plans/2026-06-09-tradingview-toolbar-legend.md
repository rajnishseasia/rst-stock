# TradingView Toolbar and Legend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TradingView timezone controls an opaque toolbar background and remove the price and percentage legend beneath them.

**Architecture:** Extract the widget options into a small pure builder exported from the existing chart component, then pass that object unchanged to `TradingView.widget`. Test the builder directly with Bun so verification does not depend on loading TradingView's remote script or accessing its cross-origin iframe.

**Tech Stack:** React 19, TypeScript, TradingView widget API, Bun test runner

---

### Task 1: Configure the TradingView toolbar and legend

**Files:**
- Create: `apps/web-v2/src/components/charts/__tests__/tradingview-chart.test.ts`
- Modify: `apps/web-v2/src/components/charts/tradingview-chart.tsx`

- [ ] **Step 1: Write the failing configuration test**

Create the focused test:

```typescript
import { describe, expect, test } from "bun:test";
import { createTradingViewWidgetOptions } from "../tradingview-chart";

describe("TradingView chart configuration", () => {
  test("uses an opaque toolbar and hides the quote legend", () => {
    const options = createTradingViewWidgetOptions({
      containerId: "chart-test",
      symbol: "AAPL",
      theme: "dark",
    });

    expect(options.toolbar_bg).toBe("#131722");
    expect(options.hide_legend).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/tradingview-chart.test.ts
```

Expected: FAIL because `createTradingViewWidgetOptions` is not exported.

- [ ] **Step 3: Add the widget options builder**

Add this type and function above `TradingViewChart`:

```typescript
type TradingViewTheme = "light" | "dark";

export function createTradingViewWidgetOptions({
  containerId,
  symbol,
  theme,
}: {
  containerId: string;
  symbol: string;
  theme: TradingViewTheme;
}) {
  return {
    container_id: containerId,
    autosize: true,
    symbol,
    interval: "5",
    timezone: "Etc/UTC",
    theme,
    style: "1",
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: true,
    calendar: false,
    toolbar_bg: theme === "dark" ? "#131722" : "#ffffff",
    hide_legend: true,
  };
}
```

Reuse `TradingViewTheme` for the component's `theme` prop.

- [ ] **Step 4: Pass the builder result to TradingView**

Replace the inline widget options object with:

```typescript
new window.TradingView.widget(
  createTradingViewWidgetOptions({
    containerId,
    symbol: formattedSymbol,
    theme,
  })
);
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/tradingview-chart.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Run web verification**

Run:

```bash
bun --filter @trade-bot/web typecheck
bun test apps/web-v2/src/components/charts
```

Expected: TypeScript exits successfully and all chart tests pass.

- [ ] **Step 7: Inspect the final diff**

Run:

```bash
git diff --check
git diff -- apps/web-v2/src/components/charts/tradingview-chart.tsx apps/web-v2/src/components/charts/__tests__/tradingview-chart.test.ts
```

Expected: no whitespace errors; the production diff only adds the opaque toolbar and hidden-legend configuration through the tested builder.
