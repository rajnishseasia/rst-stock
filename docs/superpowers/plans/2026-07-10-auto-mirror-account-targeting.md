# Auto-Mirror Account Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every auto-mirror follow target one exact user-owned Alpaca credential so Paper and Live execution are intentional and deterministic.

**Architecture:** Store `credential_id` on `copy_trade_follows`, validate ownership through the API, propagate it into each mirror candidate, and decrypt only that exact credential in the worker. Existing auto-mirror rows are disabled by migration until the user selects an account again. The UI exposes a Paper/Live account selector per follow and cannot enable Auto-mirror without a valid selection.

**Tech Stack:** PostgreSQL/Drizzle, tRPC/Zod, React, worker poller, Bun test.

## Global Constraints

- This branch is stacked on `agent/auto-mirror-cap`; preserve its absolute-cap behavior.
- Live orders still require `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE=true` in addition to the master enable flag.
- Credential ownership is checked server-side; IDs from another user must never be accepted or disclosed.
- Existing enabled rows fail closed after migration.
- One follow targets one account in v1; mirroring the same source to Paper and Live simultaneously is out of scope.

---

### Task 1: Add the account-target schema and migration

**Files:** `packages/db/src/schema/copy-trade-follows.ts`, `packages/db/migrations/0010_add_auto_mirror_credential.sql`, migration journal/snapshot as required

- [ ] Write a failing schema/migration assertion for the new nullable `credential_id` foreign key.
- [ ] Add the Drizzle relation to `user_api_credentials.id` with `ON DELETE SET NULL`.
- [ ] In the migration, disable existing `auto_mirror=true` rows that cannot identify their prior account.
- [ ] Run DB typecheck and migration metadata validation without applying production changes.

### Task 2: Enforce credential ownership in the API

**Files:** `apps/api/src/routers/copy-trade-follows.ts`, `apps/api/src/__tests__/copy-trade-follows.test.ts`

- [ ] Add failing tests for enabling without a credential, another user's credential, a non-Alpaca credential, deleted credentials, and valid Paper/Live credentials.
- [ ] Return `credentialId` and a non-secret account label/type in list responses.
- [ ] Allow `credentialId` updates, but require a valid user-owned Alpaca credential whenever the resulting row has `autoMirror=true`.
- [ ] Clearing the credential must atomically disable Auto-mirror.

### Task 3: Bind worker candidates to the selected credential

**Files:** `apps/worker/src/services/copy-mirror.ts`, `apps/worker/src/services/__tests__/copy-mirror.test.ts`

- [ ] Add failing tests showing a user with both Paper and Live credentials always uses the selected follow credential.
- [ ] Propagate `credentialId` from every follow-derived candidate path.
- [ ] Call `getDecryptedCredentials` with that exact ID and fail closed when it is absent or invalid.
- [ ] Preserve the live gate after exact credential selection.

### Task 4: Add per-follow account controls

**Files:** `apps/web-v2/src/components/copy-trade/manage-follows.tsx`, `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`, focused tests

- [ ] Add failing UI contract tests for account selection and enablement rules.
- [ ] Show saved Alpaca accounts as Paper/Live options without exposing keys.
- [ ] Disable Auto-mirror until an account is selected; when using the inline Mirror toggle, bind the current active credential explicitly.
- [ ] Replace obsolete “cap auto-scales” copy with the absolute-ceiling behavior from the parent branch.
- [ ] Run focused API/worker/web tests and all three typechecks.
