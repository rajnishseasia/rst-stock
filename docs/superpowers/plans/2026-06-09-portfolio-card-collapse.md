# Portfolio Card Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent collapse control to the Portfolio card while keeping its title, value summary, period selector, and collapse button visible.

**Architecture:** Reuse the dashboard's shared `useCollapsible` and `CollapseButton` APIs. Keep persistence in `PortfolioHistoryChartView`, and extract the card markup into an exported renderer with explicit collapse props so expanded and collapsed states can be tested without adding a DOM test framework.

**Tech Stack:** React 19, Next.js, TypeScript, Tailwind CSS, Bun test runner, React server renderer

---

### Task 1: Add tested Portfolio collapse rendering

**Files:**
- Create: `apps/web-v2/src/components/charts/__tests__/portfolio-history-chart.test.tsx`
- Modify: `apps/web-v2/src/components/charts/portfolio-history-chart.tsx:3-7`
- Modify: `apps/web-v2/src/components/charts/portfolio-history-chart.tsx:268-350`

- [ ] **Step 1: Write the failing expanded and collapsed render tests**

Create `apps/web-v2/src/components/charts/__tests__/portfolio-history-chart.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PortfolioHistoryCard } from "../portfolio-history-chart";

const data = {
  points: [
    {
      t: Date.UTC(2026, 5, 9),
      equity: 1891.84,
      pnl: -108.16,
      pnlPct: -5.41,
    },
  ],
  baseValue: 2000,
  period: "1M",
};

function renderCard(collapsed: boolean) {
  return renderToStaticMarkup(
    <PortfolioHistoryCard
      data={data}
      period="1M"
      onPeriodChange={() => {}}
      collapsed={collapsed}
      onToggleCollapse={() => {}}
    />
  );
}

describe("PortfolioHistoryCard", () => {
  test("shows the complete header and chart while expanded", () => {
    const html = renderCard(false);

    expect(html).toContain("Portfolio");
    expect(html).toContain("$1,891.84");
    expect(html).toContain("-$108.16");
    expect(html).toContain('aria-label="Collapse Portfolio"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Portfolio equity history"');
  });

  test("keeps the complete header and hides only the chart while collapsed", () => {
    const html = renderCard(true);

    expect(html).toContain("Portfolio");
    expect(html).toContain("$1,891.84");
    expect(html).toContain("-$108.16");
    expect(html).toContain(">1M<");
    expect(html).toContain('aria-label="Expand Portfolio"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="Portfolio equity history"');
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/portfolio-history-chart.test.tsx
```

Expected: FAIL because `PortfolioHistoryCard` is not exported yet.

- [ ] **Step 3: Import the shared collapse APIs**

Add this import to `apps/web-v2/src/components/charts/portfolio-history-chart.tsx`:

```tsx
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
```

- [ ] **Step 4: Extract the card renderer and add the collapse control**

Replace the existing `PortfolioHistoryChartView` block with:

```tsx
type PortfolioHistoryCardProps = {
  data: PortfolioHistoryData | undefined;
  period: Period;
  onPeriodChange: (p: Period) => void;
  isLoading?: boolean;
  error?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

export function PortfolioHistoryCard({
  data,
  period,
  onPeriodChange,
  isLoading,
  error,
  collapsed,
  onToggleCollapse,
}: PortfolioHistoryCardProps) {
  const points = data?.points ?? [];
  const hasPoints = points.length > 0;
  const latest = hasPoints ? points[points.length - 1] : undefined;
  const baseValue = data?.baseValue ?? 0;
  const latestEquity = latest?.equity ?? 0;
  const totalPnl = hasPoints ? latestEquity - baseValue : 0;
  const totalPnlPct = baseValue !== 0 ? (totalPnl / baseValue) * 100 : 0;
  const up = totalPnl >= 0;
  const accent = up ? UP_COLOR : DOWN_COLOR;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap">
          <div className="min-w-0">
            <CardTitle className="text-lg">Portfolio</CardTitle>
            {hasPoints ? (
              <CardDescription className="whitespace-nowrap">
                <span className="font-data tabular-nums text-foreground text-base font-semibold">
                  {formatUsd(latestEquity)}
                </span>{" "}
                <span className="font-data tabular-nums font-medium" style={{ color: accent }}>
                  {up ? "+" : ""}
                  {formatUsd(totalPnl)} ({formatPercent(totalPnlPct)})
                </span>
              </CardDescription>
            ) : (
              <CardDescription className="whitespace-nowrap">
                Equity over time
              </CardDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <PeriodToggle period={period} onPeriodChange={onPeriodChange} />
            <CollapseButton
              collapsed={collapsed}
              onToggle={onToggleCollapse}
              label="Portfolio"
            />
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent>
          {isLoading ? (
            <div className="h-56 w-full animate-pulse rounded-md bg-muted" />
          ) : error ? (
            <div className="flex h-56 items-center justify-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : !hasPoints ? (
            <div className="flex h-56 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              No portfolio history yet — connect an Alpaca account
            </div>
          ) : (
            <PortfolioSvgChart points={points} period={period} />
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function PortfolioHistoryChartView({
  data,
  period,
  onPeriodChange,
  isLoading,
  error,
}: {
  data: PortfolioHistoryData | undefined;
  period: Period;
  onPeriodChange: (p: Period) => void;
  isLoading?: boolean;
  error?: string;
}) {
  const { collapsed, toggle } = useCollapsible("portfolio");

  return (
    <PortfolioHistoryCard
      data={data}
      period={period}
      onPeriodChange={onPeriodChange}
      isLoading={isLoading}
      error={error}
      collapsed={collapsed}
      onToggleCollapse={toggle}
    />
  );
}
```

This keeps the value and gain/loss summary on one line. At narrow widths, the control group
may move below it rather than forcing the summary to wrap or overflow.

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/portfolio-history-chart.test.tsx
```

Expected: 2 tests pass.

- [ ] **Step 6: Run the web TypeScript check**

Run:

```bash
bun --filter @trade-bot/web typecheck
```

Expected: TypeScript exits successfully with no errors.

- [ ] **Step 7: Inspect responsive behavior**

Run:

```bash
bun dev:web
```

Open `http://localhost:4001/app` and verify:

- The Portfolio value and gain/loss remain on one line at normal desktop card widths.
- The period selector and chevron sit together at the far right.
- At narrow widths, the controls wrap below the summary without horizontal overflow.
- Collapsing hides only the chart body.
- Reloading preserves the collapsed state through `section-collapsed:portfolio`.

- [ ] **Step 8: Commit only the Portfolio collapse files**

```bash
git add apps/web-v2/src/components/charts/portfolio-history-chart.tsx apps/web-v2/src/components/charts/__tests__/portfolio-history-chart.test.tsx
git commit -m "feat(web): make portfolio card collapsible"
```
