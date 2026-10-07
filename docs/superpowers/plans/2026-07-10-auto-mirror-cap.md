# Auto-Mirror Absolute Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS` an actual safety ceiling.

**Architecture:** Separate intended notional from configured maximum. The worker skips an intent above the ceiling and logs a structured reason; it never silently clamps follower exposure.

**Tech Stack:** TypeScript, copy-mirror decision core, Bun test.

## Global Constraints

- No schema or UI changes.
- Preserve ratio sizing behavior unless a notional can be computed safely.
- Above-cap trades are skipped, not resized.
- Auto-mirror remains disabled by default and live mirroring retains its existing opt-in.

---

### Task 1: Prove the current cap fails open

**Files:** `apps/api/src/__tests__/copy-mirror-sizing.test.ts`, `apps/worker/src/services/__tests__/copy-mirror.test.ts`

- [ ] Replace tests that codify `max(baseline, intent)` with failing cases for USD, percent-buying-power, and percent-equity intents above the ceiling.
- [ ] Add boundary and below-cap cases.

### Task 2: Enforce the ceiling

**Files:** `apps/api/src/lib/copy-mirror.ts`, `apps/worker/src/services/copy-mirror.ts`

- [ ] Make the configured value independent of intent and reject candidates whose computed notional exceeds it.
- [ ] Add a structured skip reason containing IDs and amounts but no secrets.
- [ ] Run API and worker focused tests and typechecks.
