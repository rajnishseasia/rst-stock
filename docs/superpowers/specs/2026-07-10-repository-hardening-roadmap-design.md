# Repository Hardening Roadmap Design

## Goal

Strengthen Ready Set Trade without combining unrelated real-money, infrastructure, database, and frontend changes into one review surface.

## Delivery Model

Changes ship as focused pull requests. Independent first-wave branches start from `origin/main`; dependent order-state and database changes are stacked only after their prerequisite branch is reviewed. Every behavioral change uses a failing regression test first. Every PR includes exact validation and a maintainer-only checklist when repository settings or production credentials are involved.

## Workstreams

1. CI guardrails: restore the test baseline, run every workspace typecheck, build in CI, pin Bun, and scan the current tree for secrets.
2. Order idempotency: assign stable Alpaca client order IDs to every manual order path and make ambiguous retries query before resubmitting.
3. Broker reconciliation: introduce a non-terminal sync state so broker-accepted orders cannot become locally rejected.
4. Smart Exit durability: persist exit legs incrementally and resume partial attachment safely.
5. Auto-mirror safety: enforce an absolute per-order ceiling, then add durable checkpoints and transient retries.
6. Runtime performance: mount only the active responsive terminal shell, consolidate Next configuration, and address leaderboard scaling without corrupting FIFO P&L.
7. Deployment and database hygiene: establish one worker deployment path, remove inherited Polymarket configuration, align Drizzle tooling, and add safe migrations and indexes.
8. Maintainability: replace source-string UI tests with behavioral coverage before extracting the largest frontend components.

## Maintainer-Only Actions

Code PRs cannot prove or perform production credential rotation, safely rotate the credential-encryption master key without production coordination, rewrite shared git history, or enable required GitHub checks. Each relevant PR must list these as explicit follow-up actions rather than implying they were completed.

## Safety Decisions

- An auto-mirror intent above the configured maximum is skipped, not silently resized.
- Broker-accepted orders never transition to `REJECTED` because of a later local failure.
- A naive SQL limit is not applied to FIFO leaderboard history.
- Current-tree secret scanning is enabled without making CI permanently fail on already-deleted historical files.
