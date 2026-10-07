# Watchlist Row Trade Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the non-control area of every watchlist item open that symbol in New Trade while preserving the existing Trade, AI, remove, and organize actions.

**Architecture:** Add an absolute native button as the row's background interaction layer and keep visible content plus action controls above it as siblings. This avoids nested buttons, gives the expanded target native keyboard behavior, and lets each existing action remain independent.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Bun test runner, Next.js

---

### Task 1: Add the watchlist row interaction regression test

**Files:**
- Create: `apps/web-v2/src/components/watchlist/watchlist-panel.test.ts`
- Test: `apps/web-v2/src/components/watchlist/watchlist-panel.test.ts`

- [ ] **Step 1: Write the failing source regression test**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const watchlistSource = readFileSync(
  new URL("./watchlist-panel.tsx", import.meta.url),
  "utf8"
);

describe("watchlist row trade activation", () => {
  test("uses one native full-row trade target behind sibling action controls", () => {
    expect(watchlistSource).toContain('aria-label={`Open ${item.symbol} in New Trade`}');
    expect(watchlistSource).toContain('className="absolute inset-0 z-0 cursor-pointer');
    expect(watchlistSource).toContain('onClick={() => onTradeSymbol(item.symbol)}');
    expect(watchlistSource).toContain(
      'className="relative z-10 pointer-events-none flex items-center'
    );
    expect(watchlistSource).toContain(
      'className="pointer-events-auto flex items-center gap-1"'
    );
    expect(
      watchlistSource.split('onClick={() => onTradeSymbol(item.symbol)}')
    ).toHaveLength(3);
    expect(watchlistSource).not.toContain(
      'className="flex min-w-0 items-center gap-1.5 text-left"'
    );
    expect(watchlistSource).toContain(
      'className="font-data text-xs tabular-nums text-muted-foreground"'
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test apps/web-v2/src/components/watchlist/watchlist-panel.test.ts
```

Expected: FAIL because the full-row button label and layering classes do not exist yet.

### Task 2: Implement the native full-row trade target

**Files:**
- Modify: `apps/web-v2/src/components/watchlist/watchlist-panel.tsx:240-335`
- Test: `apps/web-v2/src/components/watchlist/watchlist-panel.test.ts`

- [ ] **Step 1: Make the row a positioned group and add its background button**

Update the row wrapper and add the native button before the visible content:

```tsx
<div
  key={item.id}
  className={cn(
    "group relative rounded-lg border bg-card/70 px-3 py-2 transition-colors hover:bg-muted/30",
    isSelected && "ring-2 ring-primary"
  )}
>
  <button
    type="button"
    aria-label={`Open ${item.symbol} in New Trade`}
    onClick={() => onTradeSymbol(item.symbol)}
    className="absolute inset-0 z-0 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  />
```

- [ ] **Step 2: Move visible content above the background target**

Add `relative z-10 pointer-events-none` to both visible row lines. Give each actual action control `pointer-events-auto`. Convert the symbol and price wrappers from buttons to non-interactive `div` elements:

```tsx
<div className="relative z-10 pointer-events-none flex items-center justify-between gap-2">
  <div className="flex min-w-0 items-center gap-1.5">
    <span className="font-data text-sm font-semibold tracking-tight">
      {item.symbol}
    </span>
    {isSelected && <Badge variant="secondary" className="text-[10px] px-1 py-0">Active</Badge>}
  </div>
  ...
</div>

<div className="relative z-10 pointer-events-none flex items-center justify-between gap-2">
  <div className="font-data text-xs tabular-nums text-muted-foreground">
    ...
  </div>
  <div className="pointer-events-auto flex items-center gap-1">
    ...
  </div>
</div>
```

Apply `pointer-events-auto` to the organize button group so its controls remain clickable when organize mode is enabled.

- [ ] **Step 3: Run the focused test and verify it passes**

Run:

```bash
bun test apps/web-v2/src/components/watchlist/watchlist-panel.test.ts
```

Expected: 1 test passes.

- [ ] **Step 4: Run web type checking**

Run:

```bash
bun --filter @trade-bot/web typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 5: Run all web tests**

Run:

```bash
bun test apps/web-v2
```

Expected: all web tests pass.

- [ ] **Step 6: Review the final diff**

Run:

```bash
git diff --check
git diff -- apps/web-v2/src/components/watchlist/watchlist-panel.tsx apps/web-v2/src/components/watchlist/watchlist-panel.test.ts
```

Expected: no whitespace errors; the diff is limited to the row interaction and its regression test.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/web-v2/src/components/watchlist/watchlist-panel.tsx apps/web-v2/src/components/watchlist/watchlist-panel.test.ts
git commit -m "fix(web): make watchlist rows open trade"
```
