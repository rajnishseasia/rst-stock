# Portfolio Panel Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Portfolio card below Open Orders on desktop while keeping Portfolio last on mobile.

**Architecture:** Keep a single `PortfolioHistoryChart` instance and move it from the middle dashboard column to the end of the right dashboard column. The existing responsive column ordering will preserve the requested mobile placement without conditional rendering.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS, Bun test runner

---

### Task 1: Lock the responsive source order

**Files:**
- Create: `apps/web-v2/src/app/app/page-layout.test.ts`
- Modify: `apps/web-v2/src/app/app/page.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dashboardSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("dashboard panel order", () => {
  test("renders Portfolio once after Open Orders", () => {
    const portfolioMarker = "<PortfolioHistoryChart credentialId={selectedCredentialId} />";
    const openOrdersMarker = "<OpenOrdersPanel";

    expect(dashboardSource.split(portfolioMarker)).toHaveLength(2);
    expect(dashboardSource.indexOf(portfolioMarker)).toBeGreaterThan(
      dashboardSource.indexOf(openOrdersMarker)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web-v2/src/app/app/page-layout.test.ts`

Expected: FAIL because Portfolio currently appears before Open Orders in the source.

- [ ] **Step 3: Move the existing Portfolio chart**

Remove the chart from the middle-column stack:

```tsx
<PortfolioHistoryChart credentialId={selectedCredentialId} />
```

Add the same chart after `OpenOrdersPanel` in the right-column stack:

```tsx
<OpenOrdersPanel
  activeCredentialId={selectedCredentialId}
  activeAccountType={selectedAccountType}
/>
<PortfolioHistoryChart credentialId={selectedCredentialId} />
```

- [ ] **Step 4: Run automated verification**

Run: `bun test apps/web-v2/src/app/app/page-layout.test.ts`

Expected: 1 test passes.

Run: `bun --filter @trade-bot/web typecheck`

Expected: TypeScript exits successfully.

- [ ] **Step 5: Verify responsive placement**

Open the dashboard at desktop width and confirm Portfolio appears below Open Orders in the
right column. Resize to a mobile width and confirm Portfolio is the final dashboard card.
