# RST-006 Strict Verification

**Decision: ACCEPT**

- Ticket: `RST-006`
- Base SHA: `f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2`
- Reviewed-tree SHA: `c0c86891a39548aa88c30543ce14eada9a930bd5`
- Model: GPT-5 Codex
- Round: 1
- Mode: STRICT semantic review, offline fixtures

## Findings

None. The reviewed commit meets the bounded acceptance criteria. No source or test correction is required.

## Numbered Checks

1. **PASS.** `STATUS_PRESENTATION.FILLED` has no status emoji (`apps/worker/src/services/discord-notify.ts:186`); the shared formatter still emits the action glyph (`:432`) and omits an empty status prefix (`:477`). The UNI long-open and evidenced short-close tests assert the respective action text and no checkmark (`apps/worker/src/services/__tests__/discord-notify-suppression.test.ts:514`, `:528`, `:530`, `:533`, `:548`, `:550`). A side-only `Buy` remains `Buy` (`:381`, `:401`); explicit reduce-only/direction metadata distinguishes the short close (`discord-notify.ts:425`, `:427`). Alpaca's ambiguous simple fills are rejected without position intent (`apps/worker/src/services/__tests__/external-fill-sync.test.ts:396`, `:409`).
2. **PASS.** FILLED/PARTIAL return only `executedPrice`, including null for absent values (`discord-notify.ts:340`, `:341`); notional uses that same selector and rejects unusable inputs (`:397`, `:398`, `:400`). The FILLED and PARTIAL missing-price tests supply a non-null limit, retain `25.4 UNI`, and assert no dollar value or price suffix (`discord-notify-suppression.test.ts:553`, `:567`, `:568`, `:571`, `:585`, `:586`). Venue producers pass confirmed execution fields: Alpaca `filled_avg_price` (`apps/worker/src/services/external-fill-sync.ts:440`, `:540`), row sync's persisted execution price (`apps/worker/src/services/order-sync.ts:706`), Hyperliquid row sync's finite-checked execution update (`apps/worker/src/services/hyperliquid-order-sync.ts:1540`, `:1541`), and external Hyperliquid fill `fill.px` after malformed-fill rejection (`apps/worker/src/services/hyperliquid-external-fill-sync.ts:738`; `apps/api/src/lib/hyperliquid-external-fill.ts:68`, `:78`). No quote field or inferred-price branch exists in `OrderNotification` (`discord-notify.ts:49`, `:55`).
3. **PASS.** SUBMITTED still falls through to its prior limit-price selection (`apps/worker/src/services/discord-notify.ts:343`, `:344`); behavioral coverage asserts the submitted amount and limit suffix (`apps/worker/src/services/__tests__/discord-notify-suppression.test.ts:737`, `:750`, `:751`). `shouldSuppress` is unchanged (`discord-notify.ts:306`) and its PARTIAL/SUBMITTED/market regressions pass (`discord-notify-suppression.test.ts:220`, `:236`, `:252`). Stale-fill and close-throttle guards are unchanged (`discord-notify.ts:657`, `:676`); their stale/fresh and staggered-fill tests pass (`apps/worker/src/services/__tests__/discord-notify-staleness.test.ts:124`, `:140`, `:152`; `apps/worker/src/services/__tests__/discord-alert-throttle.test.ts:45`). External-fill replay remains idempotent: the insert is conflict-safe (`apps/worker/src/services/hyperliquid-external-fill-sync.ts:692`) and the re-read test asserts one row and one ping (`apps/worker/src/services/__tests__/hyperliquid-external-fill-sync.test.ts:520`, `:532`, `:533`). The separate signal-entry formatter/call site is untouched and still uses the confirmed fill (`apps/worker/src/services/external-discord-signal-poller.ts:949`, `:965`, `:1842`, `:1852`), with price-format tests (`apps/worker/src/services/external-discord-signal-poller.test.ts:32`, `:47`).
4. **PASS.** The four added tests call `formatOrderLine` directly and cover the realistic UNI long-open/short-close pair, FILLED/PARTIAL absent execution prices with present limits, and no-checkmark assertions (`discord-notify-suppression.test.ts:514`, `:533`, `:553`, `:571`). Assertions pin action, notional, price, quantity fallback, and absence of any dollar value. The SUBMITTED limit regression also asserts both amount and requested limit (`:737`, `:750`, `:751`). Existing side mapping covers a `Buy` without direction metadata (`:381`, `:401`).
5. **PASS.** Every checklist item is recorded individually below.
6. **PASS.** The complete commit diff owns exactly the two authorized files: `apps/worker/src/services/discord-notify.ts` and `apps/worker/src/services/__tests__/discord-notify-suppression.test.ts`. `git diff --name-status` reports only those two modifications.
7. **PASS.** The focused suites and initial canonical run preceded the recorded typecheck and lint. After generated `dist` was moved outside the worktree, the clean canonical suite was rerun; no further typecheck was run after that correction. Its total is exactly four passes above baseline, matching the four added behavioral tests; the skip count is unchanged.

## Strict Audit Checklist

| Category | Item | Result | Current evidence |
|---|---|---|---|
| Money-loss | Wrong account | N/A | This is a formatter/webhook path, not an account selector or order executor (`discord-notify.ts:416`, `:702`). No account can be selected or traded here. |
| Money-loss | Size | PASS | Display notional uses the selected price and absolute quantity; non-finite or zero inputs suppress notional (`discord-notify.ts:396`, `:398`, `:400`, `:402`). The 25.4 x 3.98 cases assert `$101.09` (`discord-notify-suppression.test.ts:528`, `:548`). |
| Money-loss | Side | PASS | The formatter distinguishes explicit trade action, reduce-only, and direction (`apps/worker/src/services/discord-notify.ts:420`, `:425`, `:430`, `:432`). Tests cover side-only Buy, long open, and evidenced short close (`apps/worker/src/services/__tests__/discord-notify-suppression.test.ts:381`, `:514`, `:533`). Ambiguous simple Alpaca fills are rejected (`apps/worker/src/services/__tests__/external-fill-sync.test.ts:396`, `:409`). |
| Money-loss | Leverage | N/A | No leverage input or leverage-setting operation exists in `OrderNotification` or `formatOrderLine` (`discord-notify.ts:41`, `:416`). |
| Money-loss | Consent | N/A | No order placement or consent decision occurs in this formatter-only change (`discord-notify.ts:416`). |
| Money-loss | Attribution | PASS | Copy-source fills remain suppressed (`discord-notify.ts:306`, `:310`); trader identity remains pseudonymized and external-origin labeling remains intact (`:471`, `:472`, `:492`, `:494`). |
| Parity | Stocks and perps | PASS | Price selection branches on status, not asset type (`discord-notify.ts:339`, `:347`); equity LIN and perp UNI behavior are both covered (`discord-notify-suppression.test.ts:341`, `:513`). |
| Parity | Entry behavior | PASS | The signal-entry path still requires `outcome.fill` and forwards its `entryPrice` (`external-discord-signal-poller.ts:1842`, `:1852`); the formatter and precision tests pass (`external-discord-signal-poller.test.ts:32`, `:47`). |
| Parity | Exit behavior | PASS | Reduce-only short-close and long-close action semantics remain explicit (`discord-notify.ts:425`, `:427`; `discord-notify-suppression.test.ts:421`, `:441`, `:533`). The separate API close acknowledgement is out of this approved scope and is not claimed as changed. |
| Boundaries | Empty state | N/A | The reviewed API formats one required order object, not an input collection/result set (`discord-notify.ts:41`, `:416`). |
| Boundaries | Malformed state | PASS | Current external-fill producers reject non-finite/non-positive fill prices (`apps/worker/src/services/external-fill-sync.ts:396`, `:402`, `:440`; `apps/api/src/lib/hyperliquid-external-fill.ts:68`, `:78`), and notional rejects non-finite/non-positive prices (`apps/worker/src/services/discord-notify.ts:398`). Malformed-row coverage exists (`apps/api/src/__tests__/hyperliquid-external-fill.test.ts:72`). |
| Boundaries | Missing state | PASS | A missing execution price returns null rather than the limit for FILLED/PARTIAL (`discord-notify.ts:340`, `:341`); behavioral assertions retain quantity and omit all dollar output (`discord-notify-suppression.test.ts:553`, `:567`, `:568`, `:571`, `:585`, `:586`). |
| Boundaries | Stale state | PASS | Stale fills are rejected before throttle and identity work (`discord-notify.ts:657`, `:669`); stale and fresh close cases pass (`discord-notify-staleness.test.ts:124`, `:140`, `:152`). |
| Boundaries | Partial state | PASS | PARTIAL uses only `executedPrice` (`discord-notify.ts:340`, `:341`); missing-price PARTIAL coverage asserts quantity without price/notional (`discord-notify-suppression.test.ts:571`, `:585`, `:586`). Existing PARTIAL suppression is unchanged (`:220`, `:233`). |
| Duplication | Replay | PASS | Hyperliquid external-fill IDs are deterministic and inserts use conflict-do-nothing (`apps/worker/src/services/hyperliquid-external-fill-sync.ts:652`, `:692`); replay coverage asserts one row and one notification (`apps/worker/src/services/__tests__/hyperliquid-external-fill-sync.test.ts:520`, `:532`, `:533`). |
| Duplication | Retries | PASS | The notifier performs one POST per invocation and has no retry loop (`apps/worker/src/services/discord-notify.ts:704`, `:713`, `:720`). Replayed ingestion is covered by the idempotency evidence above. |
| Duplication | Reconciliation | PASS | Only the singular winning conditional update authorizes notification (`apps/worker/src/services/order-sync.ts:674`, `:676`, `:680`, `:693`); the external-fill re-read test confirms no second row/ping (`apps/worker/src/services/__tests__/hyperliquid-external-fill-sync.test.ts:520`, `:532`, `:533`). |
| Duplication | Competing workers | PASS | The order-sync CAS notifies only when exactly one returned row wins; zero or multiple rows do not authorize a notification (`apps/worker/src/services/order-sync.ts:676`, `:678`, `:680`, `:693`). |

## Gates

1. Focused command from the plan: `bun test apps/worker/src/services/__tests__/discord-notify-suppression.test.ts apps/worker/src/services/__tests__/discord-notify-close-reason.test.ts apps/worker/src/services/__tests__/discord-alert-throttle.test.ts apps/worker/src/services/__tests__/discord-notify-staleness.test.ts apps/worker/src/services/external-discord-signal-poller.test.ts apps/api/src/__tests__/hyperliquid-external-fill.test.ts` — **PASS**, 169 pass, 0 fail, 346 expectations across 6 files.
2. Clean canonical rerun after generated files were moved outside the worktree: `bun test --timeout 30000` — **PASS**, 5,188 pass, 40 skip, 0 fail (5,228 tests across 324 files; 15,258 expectations). Against the supplied baseline of 5,184 pass / 40 skip / 0 fail, the exact delta is +4 pass / 0 skip / 0 fail. The generated `packages/db/dist` directory was outside the worktree for this run, so these are the clean source-suite totals. No typecheck was run after this rerun.
   Exact diff accounting: four new `it` cases were added (UNI long open, UNI short close, FILLED without execution price, PARTIAL without execution price), contributing exactly four passing tests. Those cases add 10 `expect()` calls; one more `expect()` was added to the existing SUBMITTED-limit test. Total added assertions: 11. No other test definition was added.
3. Earlier `bun run check-types` result from the initial gate sequence — **PASS**, 11/11 packages successful (all cache hits); not rerun after the clean canonical rerun.
4. `bun run lint` — **PASS**, exit 0, 23 warnings, matching the supplied warning baseline. No warning names a changed file.
5. `git diff --check f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2 c0c86891a39548aa88c30543ce14eada9a930bd5` — clean.

## Remaining Proof

Evidence is local behavioral tests and source inspection on the reviewed tree. No live Discord, broker, production data/configuration, or wallet operation was used or claimed; live proof is prohibited and is not a merge gate for this task. The separate API close acknowledgement remains outside RST-006 scope.
