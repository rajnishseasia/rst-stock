# Audit CI Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository's CI checks accurately exercise current tests, all TypeScript workspaces, the production build, and current-tree secret detection.

**Architecture:** Preserve existing package-local `typecheck` commands and add Turbo-compatible `check-types` aliases. Reconcile stale source-string tests only where current production behavior is clearly intentional, then add workflow guardrails without touching trading behavior.

**Tech Stack:** Bun 1.3.4, Turborepo, TypeScript, Bun test, GitHub Actions, Gitleaks.

## Global Constraints

- Do not modify broker, database, API behavior, or frontend production behavior.
- Keep existing `typecheck` scripts working for contributors.
- Secret output must always be redacted.
- CI secret scanning covers the checked-out tree and future committed files; historical rotation remains a maintainer action.

---

### Task 1: Restore the web test baseline

**Files:** `apps/web-v2/**/*.test.ts`, `apps/web-v2/**/*.test.tsx`

- [ ] Run `bun test apps/web-v2` and record every failing assertion.
- [ ] For each failure, compare the assertion with current source and adjacent documentation. Update stale names/expectations only when the current behavior is unambiguous; do not weaken assertions with generic substring checks.
- [ ] Run each changed test file and then `bun test apps/web-v2`; expected result is zero failures.

### Task 2: Make all workspace typechecks participate

**Files:** every workspace `package.json`, `turbo.json`

- [ ] Add `"check-types": "bun run typecheck"` beside each existing `typecheck` script. Preserve `packages/db`'s existing `check-types` task.
- [ ] Run `bun check-types` and verify Turbo executes all ten workspace tasks, not only `@trade-bot/db`.
- [ ] Run the API, worker, and web filters directly to preserve contributor compatibility.

### Task 3: Strengthen the CI workflow

**Files:** `.github/workflows/ci.yml`, optional `.gitleaks.toml`

- [ ] Pin `oven-sh/setup-bun` to Bun `1.3.4`.
- [ ] Add a production build step using the repository's root build command. Supply only documented non-secret placeholder build variables if Next configuration requires them.
- [ ] Add a Gitleaks current-tree scan with redacted output and vendored/build directories excluded.
- [ ] Verify workflow YAML parses and local equivalents for typecheck, test, build, and secret scan succeed.

### Task 4: Document repository-setting follow-up

**Files:** `docs/maintenance/ci-and-secret-rotation.md`

- [ ] Document the required `build-and-test` branch-protection check.
- [ ] List affected historical credential categories without values and require explicit rotation confirmation.
- [ ] Explain that encryption-key rotation requires re-encrypting stored credentials.
