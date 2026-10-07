# Direction-Aware X Leaderboard Returns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate honest X caller return and hit-rate metrics by scoring every ticker independently with its inferred bullish or bearish direction.

**Architecture:** Add a pure, conservative parser for direction evidence local to a signal row's ticker. Feed its result into the existing bar-based return calculation, expose sample counts and measurement status through tRPC, and add selectable 1/3/7-day horizons in the existing leaderboard UI.

**Tech Stack:** TypeScript, Bun tests, tRPC, React, Drizzle-backed signal rows, Alpaca daily bars.

---

### Task 1: Per-Ticker Direction Parser

**Files:**
- Create: `apps/api/src/lib/x-call-direction.ts`
- Create: `apps/api/src/__tests__/x-call-direction.test.ts`

- [ ] **Step 1: Write failing parser tests**

Cover bullish and bearish equity language, BTO calls and puts, sell-to-close exits, conflicting language, ambiguous mentions, and a mixed post where AAPL and TSLA resolve independently.

- [ ] **Step 2: Verify the tests fail**

Run: `bun test apps/api/src/__tests__/x-call-direction.test.ts`

Expected: failure because `deriveXCallDirection` does not exist.

- [ ] **Step 3: Implement the pure parser**

Expose:

```ts
export type XCallDirection = "bullish" | "bearish" | "unknown";

export function deriveXCallDirection(input: {
  content: string | null | undefined;
  symbol: string;
  referenceDate?: Date | string | null;
}): XCallDirection;
```

Use ticker-local clauses, explicit action words, and the existing option parser. Return `unknown` when evidence is missing or conflicting.

- [ ] **Step 4: Verify parser tests pass**

Run: `bun test apps/api/src/__tests__/x-call-direction.test.ts`

Expected: all parser tests pass.

### Task 2: Direction-Adjusted Aggregation

**Files:**
- Modify: `apps/api/src/lib/leaderboard.ts`
- Modify: `apps/api/src/__tests__/leaderboard.test.ts`
- Modify: `apps/api/src/routers/leaderboard.ts`

- [ ] **Step 1: Write failing aggregation tests**

Assert that a bearish call inverts a negative raw ticker return into a positive scored return, ambiguous calls remain in `callCount`, and `measuredCallCount` only counts finite scored returns.

- [ ] **Step 2: Verify the tests fail**

Run: `bun test apps/api/src/__tests__/leaderboard.test.ts`

Expected: failure because measured sample counts and direction adjustment are absent.

- [ ] **Step 3: Add measured sample counts**

Extend `CallerStats` and `XCallerLeaderboardRow` with:

```ts
measuredCallCount: number;
directionalCallCount: number;
```

Keep `callCount` as the total number of per-ticker signal rows.

- [ ] **Step 4: Apply direction before aggregation**

For each stored signal row, derive its direction. Map bullish calls to the raw return, bearish calls to `-rawReturn`, and unknown calls to `null`. Return a row status that distinguishes unavailable bars from no matured directional calls.

- [ ] **Step 5: Verify API tests pass**

Run: `bun test apps/api/src/__tests__/x-call-direction.test.ts apps/api/src/__tests__/leaderboard.test.ts`

Expected: all focused API tests pass.

### Task 3: Horizon And Measurement UI

**Files:**
- Modify: `apps/web-v2/src/components/copy-trade/leaderboard-view.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

- [ ] **Step 1: Write failing UI source tests**

Require 1D/3D/7D horizon controls, `horizonDays` state defaulting to 1, measured/total sample copy, and distinct pending/direction/market-data messages.

- [ ] **Step 2: Verify the tests fail**

Run: `bun test apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

Expected: failure because the horizon is hard-coded to seven days and the status states are conflated.

- [ ] **Step 3: Implement the controls and status display**

Add a compact horizon segmented control beside the existing window/sort controls. Render metrics from measured calls and explain why a row has no measurement without claiming market data is missing when calls are merely immature or directionless.

- [ ] **Step 4: Verify UI tests pass**

Run: `bun test apps/web-v2/src/components/copy-trade/leaderboard.test.ts`

Expected: all leaderboard UI tests pass.

### Task 4: Verification

**Files:**
- No additional production files.

- [ ] **Step 1: Run focused tests**

```bash
bun test apps/api/src/__tests__/x-call-direction.test.ts apps/api/src/__tests__/leaderboard.test.ts apps/web-v2/src/components/copy-trade/leaderboard.test.ts
```

- [ ] **Step 2: Run typechecks and lint**

```bash
bun --filter @trade-bot/api typecheck
bun --filter @trade-bot/web typecheck
bun run lint
```

- [ ] **Step 3: Run the full suite and production web build**

```bash
bun test
bun --filter @trade-bot/web build
```

- [ ] **Step 4: Verify in the in-app browser**

Start Docker, API, and web locally. Open `/leaderboard`, exercise the 1D/3D/7D controls, and confirm the X tab renders sample status without runtime errors. Do not place any orders.

- [ ] **Step 5: Commit the implementation**

```bash
git add apps/api/src/lib/x-call-direction.ts apps/api/src/__tests__/x-call-direction.test.ts apps/api/src/lib/leaderboard.ts apps/api/src/__tests__/leaderboard.test.ts apps/api/src/routers/leaderboard.ts apps/web-v2/src/components/copy-trade/leaderboard-view.tsx apps/web-v2/src/components/copy-trade/leaderboard.test.ts
git commit -m "fix: score X leaderboard calls by direction"
```
