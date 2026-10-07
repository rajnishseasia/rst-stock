# Mobile Workspace UX Hardening Implementation Plan

**Goal:** Deliver a functional Bullpen-informed mobile workspace without
replacing RST's production controller or data boundaries.

**Architecture:** Keep `TradingAppContent` as the authenticated controller and
the `mobile-v2` components as presentational boundaries. First flatten each
screen into the shell's single scroll owner, then make one integration pass for
global search, menu, chart, and trade overlays. Agents own disjoint files until
that integration pass.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Bun tests.

## Task 1: Shell and Navigation

**Files:** `mobile-v2/mobile-frame.tsx`, `mobile-v2/mobile-frame.test.tsx`,
`components/layout/mobile-nav.tsx`, `components/layout/mobile-nav.test.tsx`

- Add regression tests for compact header metrics, safe numeric rendering,
  one scroll owner, safe-area bottom nav, and 320px navigation reachability.
- Tighten the shared header and navigation while preserving handlers and ARIA.
- Keep reduced-motion and keyboard focus states.

## Task 2: Markets and Feed

**Files:** `mobile-v2/markets-screen.tsx`, `mobile-v2/markets-screen.test.tsx`,
`mobile-v2/feed-screen.tsx`, `mobile-v2/feed-screen.test.tsx`,
`components/terminal/mobile-market-browse.tsx`, and its test.

- Test and remove nested page-sized scrolling/card shells.
- Make market browsing list-first with compact quote rows and useful filters.
- Tighten feed rows while preserving the production copy/trade handlers.

## Task 3: Copy Workspace

**Files:** `mobile-v2/copy-screen.tsx`, `mobile-v2/copy-screen.test.tsx`

- Test that rankings are visible before deployment/risk notices.
- Flatten the content hierarchy and move secondary configuration into a
  disclosure without hiding real warnings.
- Preserve controlled tabs and supplied production panels.

## Task 4: Account Workspace

**Files:** `mobile-v2/account-screen.tsx`, `mobile-v2/account-screen.test.tsx`,
`mobile-venue-stack.tsx`, `mobile-venue-stack.test.tsx`

- Test 320px account totals, horizontal tab reachability, and venue stacking.
- Remove nested scroll/card framing and make panel surfaces width-safe.
- Preserve tri-state balances and connection truthfulness.

## Task 5: Controller and Overlay Integration

**Files:** `trading-app-content.tsx` and directly related integration tests.

- Integrate the completed screen boundaries without changing business logic.
- Normalize mobile menu, full-screen search, chart, and trade-sheet mounting.
- Keep history/back behavior, focus restoration, and all existing callbacks.

## Task 6: Cross-Screen Review and Verification

- Run changed tests after each task, then web typecheck and lint.
- Review every agent diff for controller leakage, duplicated queries, hidden
  states, accessibility regressions, and CSS overflow.
- Run in-app browser journeys at 390x844 and 320x700.
- Fix only evidenced failures, rerun the relevant test, and capture screenshots.
- Rebase on current `origin/main`, push, and open a PR with maintainer notes.
