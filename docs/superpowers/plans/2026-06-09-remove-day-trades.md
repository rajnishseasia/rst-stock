# Remove Day Trades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove day-trade and pattern-day-trader information from product-facing account data, UI, documentation, and AI context.

**Architecture:** Keep Alpaca's raw account response type intact, but stop forwarding or presenting its day-trade fields at every product boundary. Protect the removal with a source-level regression test covering the UI, API projection, AI context, and documentation.

**Tech Stack:** Bun test runner, TypeScript, React, Next.js, tRPC

---

### Task 1: Add the Removal Regression Test

**Files:**
- Create: `apps/web-v2/src/components/trade/__tests__/day-trades-removal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sources = {
  positionsPanel: readFileSync(new URL("../positions-panel.tsx", import.meta.url), "utf8"),
  guide: readFileSync(new URL("../../../app/guide/page.tsx", import.meta.url), "utf8"),
  positionsRouter: readFileSync(
    new URL("../../../../../api/src/routers/positions.ts", import.meta.url),
    "utf8"
  ),
  stockContext: readFileSync(
    new URL("../../../../../api/src/lib/chat/stock-context.ts", import.meta.url),
    "utf8"
  ),
  glossarySource: readFileSync(
    new URL("../../../../../../docs/tasks/glossary-section.jsx.txt", import.meta.url),
    "utf8"
  ),
  guideReview: readFileSync(
    new URL("../../../../../../docs/tasks/guide-review.md", import.meta.url),
    "utf8"
  ),
};

describe("day-trade product removal", () => {
  test("removes day-trade data and copy from product-facing sources", () => {
    for (const source of Object.values(sources)) {
      expect(source).not.toMatch(/daytradeCount|patternDayTrader/i);
      expect(source).not.toMatch(/day[ -]?trades?|pattern day trader|\bPDT\b/i);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test apps/web-v2/src/components/trade/__tests__/day-trades-removal.test.ts
```

Expected: FAIL because the current product sources contain day-trade fields and copy.

### Task 2: Remove Product Data and UI Exposure

**Files:**
- Modify: `apps/web-v2/src/components/trade/positions-panel.tsx:194-208`
- Modify: `apps/api/src/routers/positions.ts:665-666`
- Modify: `apps/api/src/lib/chat/stock-context.ts:173`

- [ ] **Step 1: Remove the Account Summary metric**

Delete the final grid item that renders `Day Trades`, `account.daytradeCount`, and the conditional PDT badge. Keep the existing two-column grid and the other three metrics unchanged.

- [ ] **Step 2: Remove account API projection fields**

Delete these properties from the account router response:

```ts
daytradeCount: account.daytrade_count,
patternDayTrader: account.pattern_day_trader,
```

- [ ] **Step 3: Remove the AI context line**

Delete this entry from the account summary context:

```ts
`- Day trade count: ${account.daytrade_count}`,
```

### Task 3: Remove Documentation Exposure

**Files:**
- Modify: `apps/web-v2/src/app/guide/page.tsx:411`
- Modify: `apps/web-v2/src/app/guide/page.tsx:646`
- Modify: `apps/web-v2/src/app/guide/page.tsx:757`
- Modify: `apps/web-v2/src/app/guide/page.tsx:906-911`
- Modify: `docs/tasks/glossary-section.jsx.txt:110-116`
- Modify: `docs/tasks/guide-review.md:26-29`

- [ ] **Step 1: Update Account Summary descriptions**

Change the right-column overview to list only portfolio value, buying power, and cash. Remove the Day Trades list item from the Manage Positions section.

- [ ] **Step 2: Remove PDT guidance and glossary entries**

Delete the PDT callout and the Day Trade/PDT glossary cards from the web guide. Delete the matching entries from `glossary-section.jsx.txt`.

- [ ] **Step 3: Remove stale review notes**

Remove PDT and PDT badge references from `guide-review.md` while preserving the surrounding review notes.

### Task 4: Verify the Removal

**Files:**
- Test: `apps/web-v2/src/components/trade/__tests__/day-trades-removal.test.ts`
- Verify: `packages/alpaca/src/types.ts`

- [ ] **Step 1: Run the regression test**

Run:

```bash
bun test apps/web-v2/src/components/trade/__tests__/day-trades-removal.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the web typecheck**

Run:

```bash
bun --filter @trade-bot/web typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Search for remaining references**

Run:

```bash
rg -n -i "day[ _-]?trades?|daytrade|pattern[ _-]?day[ _-]?trader|\bPDT\b" apps packages docs README.md readme-other.md
```

Expected: only `daytrade_count` and `pattern_day_trader` in `packages/alpaca/src/types.ts`, plus ignored/generated output outside the tracked source scope if present.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git diff -- apps/web-v2/src/components/trade/positions-panel.tsx apps/web-v2/src/app/guide/page.tsx apps/api/src/routers/positions.ts apps/api/src/lib/chat/stock-context.ts docs/tasks/glossary-section.jsx.txt docs/tasks/guide-review.md apps/web-v2/src/components/trade/__tests__/day-trades-removal.test.ts
```

Expected: no whitespace errors and only the approved removals plus the regression test.
