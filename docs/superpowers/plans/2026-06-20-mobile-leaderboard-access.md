# Mobile Leaderboard Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Copy Trade leaderboard button visible and touch-friendly on mobile.

**Architecture:** Use responsive Tailwind classes to stack filters and actions below the `sm` breakpoint. Keep desktop structure and routing unchanged.

**Tech Stack:** React, Next.js, Tailwind CSS, Bun tests, in-app Browser.

---

### Task 1: Add The Mobile Layout Regression Test

**Files:**
- Modify: `apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
const manageFollows = readFileSync(
  new URL("./manage-follows.tsx", import.meta.url),
  "utf8",
);

test("keeps leaderboard actions visible on mobile", () => {
  expect(panel).toContain("flex-col items-stretch");
  expect(panel).toContain("sm:flex-row");
  expect(panel).toContain("w-full items-center");
  expect(panel).toContain("flex-1 sm:flex-none");
  expect(panel).toContain("h-11 w-full");
  expect(manageFollows).toContain("h-11");
  expect(manageFollows).toContain("sm:h-7");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

Expected: FAIL because the controls still use one non-wrapping horizontal row and 28px buttons.

### Task 2: Implement The Responsive Action Row

**Files:**
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/manage-follows.tsx`

- [ ] **Step 1: Stack the header controls on mobile**

```tsx
<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
```

- [ ] **Step 2: Make the action row and leaderboard link responsive**

```tsx
<div className="flex w-full items-center gap-1.5 sm:w-auto sm:shrink-0">
  <Link href="/leaderboard" className="flex-1 sm:flex-none">
    <Button className="h-11 w-full gap-1.5 text-xs sm:h-7 sm:w-auto">
```

- [ ] **Step 3: Increase the mobile Manage Follows touch target**

```tsx
className="h-11 gap-1.5 text-xs sm:h-7"
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

Expected: PASS.

### Task 3: Verify And Publish

**Files:**
- Test: `apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

- [ ] **Step 1: Run automated validation**

Run: `bun --filter @trade-bot/web typecheck`

Run: `bun test`

Run: `bun run lint`

Run: `bun --filter @trade-bot/web build`

Expected: all commands exit 0.

- [ ] **Step 2: Verify mobile behavior in the in-app Browser**

Flow: `http://localhost:3000/app` -> Copy Trade -> observe full-width `Top Traders` action -> click -> `/leaderboard` renders.

Use a mobile viewport and verify no clipping, horizontal overflow, framework overlay, or new console error.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs/superpowers apps/web-v2/src/components/copy-trade
git commit -m "fix: expose leaderboard actions on mobile"
git push -u origin codex/mobile-leaderboard-access
gh pr create --base main --head codex/mobile-leaderboard-access
```
