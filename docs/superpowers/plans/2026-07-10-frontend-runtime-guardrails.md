# Frontend Runtime Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop hidden responsive terminal shells from polling and consolidate Next.js configuration without changing visible mobile or desktop workflows.

**Architecture:** Use a hydration-safe viewport hook to mount exactly one terminal shell at a time. Consolidate the two Next configs into the active TypeScript configuration and preserve all rewrites, image rules, and build settings.

**Tech Stack:** Next.js 16, React 19, tRPC/TanStack Query, Bun test.

## Global Constraints

- No API, database, broker, or visual redesign changes.
- Mobile breakpoint remains `xl`.
- Server render and hydration must not produce duplicate polling trees or hydration warnings.
- Existing route rewrites and Vercel validation remain covered.

---

### Task 1: Add responsive-shell behavior tests

**Files:** `apps/web-v2/src/app/app/page-layout.test.ts`, new focused hook test if needed

- [ ] Add a failing behavior-oriented test for mounting only the active responsive shell.
- [ ] Preserve mobile trade sheet and desktop drawer expectations while removing stale source assertions unrelated to this PR.

### Task 2: Mount one terminal shell

**Files:** `apps/web-v2/src/app/app/page.tsx`, optional `apps/web-v2/src/hooks/use-media-query.ts`

- [ ] Implement a hydration-safe `xl` media query state.
- [ ] Render only mobile or desktop shell after client viewport resolution; avoid running hidden queries.
- [ ] Run focused tests and web typecheck.

### Task 3: Consolidate Next configuration

**Files:** `apps/web-v2/next.config.mjs`, `apps/web-v2/next.config.ts`, `apps/web-v2/next-config.test.ts`

- [ ] Add failing tests covering every setting currently split between both files.
- [ ] Keep one `next.config.ts` with rewrites, image policy, `typedRoutes`, and React Compiler settings.
- [ ] Remove the dead twin and run config tests plus the web production build.
