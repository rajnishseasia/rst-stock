# Universal Order Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate manual Alpaca orders when a request times out after broker acceptance or an internal retry occurs.

**Architecture:** Generate one stable client order ID per user submit intent, carry it through tRPC and every Alpaca order wrapper, and reuse deterministic suffixes for multi-leg orders. Before retrying an ambiguous create, query Alpaca by client ID and return the existing order when present.

**Tech Stack:** TypeScript, tRPC, Alpaca SDK wrapper, Bun test.

## Global Constraints

- No database schema changes in this PR.
- Existing copy-mirror IDs and behavior remain unchanged.
- IDs must fit Alpaca limits, avoid PII, and remain stable across internal retries.
- Write failing tests before implementation.

---

### Task 1: Characterize duplicate-risk paths

**Files:** `packages/alpaca/src/**/*.test.ts`, `apps/api/src/__tests__/orders*.test.ts`

- [ ] Add failing tests proving a timeout-after-acceptance resolves the existing order by client ID instead of issuing a second POST.
- [ ] Add failing tests covering normal, bracket, explicit close, OCO, trailing-stop, and Smart Exit entry paths.

### Task 2: Add reusable idempotent order creation

**Files:** `packages/alpaca/src/client.ts`, `packages/alpaca/src/types.ts`

- [ ] Add a wrapper that requires `client_order_id`, classifies ambiguous transport failures, queries Alpaca by client ID, and only retries when no accepted order exists.
- [ ] Preserve existing response types and retry behavior for safe GET requests.
- [ ] Run package tests and typecheck.

### Task 3: Propagate stable IDs through API and web

**Files:** `apps/api/src/routers/orders.ts`, `apps/api/src/routers/positions.ts`, `apps/web-v2/src/components/trade/trade-form.tsx`, associated tests

- [ ] Generate the submit-intent key once in the client and retain it for the duration of that submission.
- [ ] Require or server-generate IDs for every API create path; derive deterministic leg suffixes without exceeding Alpaca's limit.
- [ ] Run focused API/web tests, API/web typechecks, and verify no production create call lacks a client ID.
