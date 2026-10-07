# Fable Audit (2026-07-02) - Verification Status as of 2026-07-20

> Round 2 close-out: 0.2/H5, 2.1/H8 (finding obsolete), M2, M6, M7, M9, M10,
> M16, M18, M20, and L1 are now addressed. Still open: H7/M12 god-component
> and API-dedup refactors, M4 durable copy-mirror retry queue, M13 partial.

Verified against `main` by direct code inspection (grep + file reads; nothing
executed against any database or broker). Each item cites the evidence found.
Source audit: `docs/AUDIT-2026-07-02.md` (same content as the Drive PDF linked
from the RST tasks doc, row 10).

## Summary

Most of the money-path and safety-net items (Milestones 0 and 1) are done.
The main outstanding items are lint tooling, the drizzle-kit bump, CORS
localhost gating, and several Milestone 2/3 cleanups.

## Milestone 0 - Safety net

| Item | Status | Evidence |
|---|---|---|
| 0.1 CI type-check rename (C2) | DONE | All 11 workspaces have a `check-types` script (`packages/hyperliquid` was the last gap, closed in PR #118); `.github/workflows/ci.yml` runs `bun check-types`. |
| 0.2 oxlint config + bump (H5) | DONE | oxlint bumped to 1.x with a committed `.oxlintrc.json` (correctness = error, vendored bundles ignored); the 6 surfaced errors were fixed; unused `oxc` dep and web-v2's deprecated `next lint` removed. `bun lint` now exits nonzero on real errors. |
| 0.3 Secret scanning in CI | DONE | gitleaks step present in `.github/workflows/ci.yml`. |
| C1 Tracked secrets | DONE (current tree) | `git ls-files` shows only `.env.example` files; no live env files tracked. Whether git history was purged and keys rotated cannot be confirmed from the working tree. |

## Milestone 1 - Critical correctness

| Item | Status | Evidence |
|---|---|---|
| 1.2 Broker success never marked REJECTED (H1) | DONE | `apps/api/src/routers/orders.ts` uses `persistBrokerAcceptance` + a pending-sync response path after broker acceptance; `REJECTED` is only set when the broker call itself fails. `AlpacaAmbiguousOrderError` (`packages/alpaca/src/client.ts:149`) models ambiguous outcomes for reconciliation. |
| 1.3 `client_order_id` on exit legs (H2) | DONE | `apps/worker/src/services/order-sync.ts` calls `deriveClientOrderId()` for TP and trailing legs (leg keys `tp0`, `trail`). |
| 1.4 Copy-trade dollar cap (H3) | DONE | The self-defeating `max(env, 1.2 x intent)` is gone. `withinDollarCap` (`apps/api/src/lib/copy-mirror.ts:164`) enforces `orderDollars <= maxOrderDollars`, where the cap comes only from `COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS` or the $1,000 default, independent of intent. |
| 1.5 Bounded leaderboard scans (H6) | DONE | Users query paginates with `.limit(USER_HISTORY_PAGE_SIZE)`; the `xCallers` signals scan is now capped at `XCALLER_SIGNAL_SCAN_CAP` (5,000 newest rows). |
| 1.6 CORS localhost gating (M1) | DONE | Origins are built by `buildCorsOrigins` (`apps/api/src/lib/cors-origins.ts`); localhost is included only when `NODE_ENV !== "production"`. Unit tested. |

## Milestone 2 / 3 - Cleanups

| Item | Status | Evidence |
|---|---|---|
| 2.1 drizzle-kit bump (H8) | OBSOLETE (verified working) | The audit's pairing advice was wrong: drizzle-kit and drizzle-orm version lines diverged, and kit 0.22.x is the correct partner for orm 0.31.x (kit 0.31 refuses to run with orm 0.31). `bun run db:generate` produces a clean no-op on the current versions and generated migration 0016 correctly; migrations 0009+ prove the tooling works. |
| 2.2 Polymarket purge (M17/M18) | DONE | `turbo.json` clean, Dockerfile gone, `.npmrc` deleted. The "dead package directories" were untracked local `node_modules` residue only (never in git); removed locally. Root-level `@next/swc-win32-x64-msvc` and `discord.js` deps deleted (zero importers; the Discord poller uses raw HTTP). |
| 2.6 Indexes + timestamptz (M9/M10) | DONE (migration pending prod apply) | Migration 0016: `signals` timestamp/created_at/updated_at converted to timestamptz, `orders.signal_id` index added, `orders.executed_quantity` widened to double precision (M6). The other audit-suggested indexes already existed as compound indexes. Requires `bun run db:migrate` against prod (see PR checklist). |
| 2.7 Delete vendor charting d.ts (M14) | DONE | The 30,450-line duplicate is deleted; `src/vendor/charting_library/index.d.ts` re-exports types from the runtime copy in `public/charting_library/` (the two copies were verified byte-identical before the switch). |
| 3.2 Shared formatters (M16) | DONE | `apps/web-v2/src/lib/format.ts` (formatUsd, formatCompactUsd, formatSignedNumber) with unit tests; 7 duplicate declarations removed. The portfolio chart keeps its intentionally-different axis-compact formatter. |
| 3.3 Single Next config (M15) | DONE | Only `next.config.ts` exists; the `.mjs` twin is gone. |
| 3.5 `pending_cancel` mapping (M5) | DONE | `mapAlpacaStatus` keeps `pending_cancel` as `SUBMITTED` (non-terminal) so a cancel that loses the race to a fill still syncs to `FILLED` on the next poll. Unit tested. |
| M2 Prod-touching scripts | DONE | Obsolete `apply-chat-tables.ts` deleted (superseded by the migration journal); `chat-tools-smoke`, `list-users`, `list-active-users` refuse non-local databases without `--yes-prod` (`apps/api/scripts/lib/guard.ts`, unit tested); the hardcoded real email default is gone (USER_EMAIL required); all email output is masked. |
| M6 Fractional fills vs integer column | DONE | `orders.executed_quantity` widened to double precision (migration 0016); order-sync's `parseFloat(filled_qty)` writes are lossless and the inferred TS type stays `number`. |
| M7 Loose order validation | DONE | Shared `symbolSchema` (max 21, charset-checked, all three submit procedures), `optionExpirationSchema` (strict YYMMDD), `notesSchema` (max 2000). Unit tested. |
| M20 Docs contradict code | DONE | README fixed (Winston not Pino, Next.js 16); `FEATURE_BASED_ARCHITECTURE.md` deleted per the audit's own recommendation. |
| M19 Deploy story | RESOLVED | The broken Dockerfile is gone; the worker deploys as a plain Bun process. |
| L1 Logger secret redaction | DONE | `packages/logger/src/redact.ts`: key-based recursive redaction applied to every log context before any transport serializes it. Unit tested. |
| M13 Swallowed errors | DONE | signals.list returns a `degraded` flag and copyTrade.feed returns `failedSources`; both feed panels render an amber degraded notice instead of a silently-empty list. |
| M4 Missed mirrors on restart | ALREADY FIXED (verified) | The current worker persists a `copy_mirror_checkpoints` watermark (seeded only on very first run, resumed across restarts) and stages candidates into a durable `copy_mirror_deliveries` retry queue in the same transaction as watermark advancement (`apps/worker/src/services/copy-mirror.ts` poll/stageWindow/loadDueDeliveries). The audit's finding predates this implementation. |
| M12 API copy-paste blocks | DONE | `publishSocialTrade()` (`apps/api/src/lib/social-publish.ts`) replaces the 4 copy-pasted social-feed blocks in orders.ts; the 11 credential-guard blocks in positions.ts now use the shared `getAlpacaClient()` helper. |
| H7 God components | IN PROGRESS (3 seams extracted) | Landed: `use-exit-plan-prefs.ts` (preference persistence), `use-trade-quotes.ts` (all market-data queries + derived values, trade-form now ~3.3k lines from 3.6k), and `components/terminal/drawer-layout.ts` (pure width-balancing math out of app/page.tsx, now behaviorally unit tested). Remaining: order-submission hook, review modal, mobile-tab reducer. Each is a further bounded verbatim extraction. |

## Related fix in this PR

Audit theme "error handling around user-entered broker data": the settings
save path now verifies Alpaca keys against `GET /v2/account` before storing
them (`apps/api/src/lib/alpaca-credential-check.ts`), with distinct messages
for rejected keys (including Paper/Live mismatch), Alpaca unreachable, and
missing fields. Previously any typo was silently encrypted and stored.
