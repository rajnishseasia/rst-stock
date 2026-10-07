# RST-005 Strict Verification

**Verdict: REJECT**

- Ticket: RST-005
- Base SHA: `f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2`
- Reviewed tree SHA: `3c593237292b4d113dd2eebe7000ac021f0f1279`
- Round: 1 (no prior verifier report existed)
- Model: GPT-5 Codex. The role requests Luna 5.6/max; that model override was unavailable in this runtime.
- Diff reviewed: `git show --format=fuller --no-ext-diff --no-renames 3c593237292b4d113dd2eebe7000ac021f0f1279`
- Scope: commit parent matches the base SHA. The commit changes exactly the two authorized helper/test files. The worktree was clean before review and remained clean after checks; this report is the only verifier-owned edit.

## Findings

1. **Cumulative per-order P&L snapshots can be added as if they were per-fill P&L.** `realizedPnlForOpenPerps` adds each closing row's `realizedPnl` at `apps/api/src/lib/perp-realized-pnl.ts:167-185`. The `listPerps` query admits `FILLED`/`PARTIAL` rows and selects neither a parent identifier nor `syncReason` at `apps/api/src/routers/positions.ts:1586-1601`. The worker creates `FILLED` synthetic rows with delta size but copies `update.realizedPnl` into each row at `apps/worker/src/services/hyperliquid-order-sync.ts:1428-1478`; `update.realizedPnl` is cumulative across the order at `apps/api/src/lib/hyperliquid-order-sync.ts:527-531`. If the parent becomes `CANCELLED`, the router excludes it while retaining its synthetic children. A read-only helper probe with `Buy 2 / P&L 0`, then `Sell 0.5 / P&L 5` and `Sell 0.5 / P&L 9` on successive updates, and live long size `1`, returns `BTC=14`; the latest cumulative close P&L is `9`. If the parent remains included, its latest timestamp collides with the final child timestamp (`hyperliquid-order-sync.ts:1353-1356,1482-1485`), and the helper returns `null` at `perp-realized-pnl.ts:159-162`. Both outcomes violate the required persisted-row contract. Correction: define one coherent replay representation for parent and synthetic rows, preserving per-delta P&L (or an explicit cumulative-to-delta conversion and identity), and add a behavioral test covering multiple partial updates with both retained and cancelled parents. This needs source authorization beyond the reviewed two-file write set; no source/test edits were made here.

2. **Same-size stale or incomplete history is not detectable and can return a stale total.** The only final completeness check compares reconstructed and live exposure at `apps/api/src/lib/perp-realized-pnl.ts:189-192`; neither that helper input nor the router query (`apps/api/src/routers/positions.ts:1586-1601`) carries a history-completeness watermark. A read-only probe using the subset `Buy 2 / 0`, `Sell 0.5 / 5`, `Buy 0.5 / 0` with live long size `2` returns `BTC=5`. If a later flat-and-reopen pair is absent from the stale rows, the same live side/size has a new open-run total of zero, but this helper cannot distinguish it. Correction: provide authoritative history coverage through the same snapshot (or fail closed when coverage cannot be established); do not invent an age cutoff or size tolerance.

## Numbered Checks

1. **PASS.** Signed exposure keeps the current total across same-side adds and resets on flat/flip (`apps/api/src/lib/perp-realized-pnl.ts:165-186`); scale-in, flat-to-reopen, and flip tests are at `apps/api/src/__tests__/perp-realized-pnl.test.ts:9-26,54-60`.
2. **FAIL.** Exact decimal and final-exposure checks reject detectable malformed/mismatched inputs (`apps/api/src/lib/perp-realized-pnl.ts:26-52,143-155,189-192`), but finding 2 demonstrates stale, incomplete history that still matches live size returns a number. No tolerance or coercion-to-zero is introduced for close P&L.
3. **PASS.** Long/short replay, partial closes, flips, flat-to-reopen, exact duplicate collapse, and a no-close open run are covered at `apps/api/src/__tests__/perp-realized-pnl.test.ts:9-26,44-60,80-87`; close P&L is added only for opposite-side fills at `apps/api/src/lib/perp-realized-pnl.ts:167-185`.
4. **FAIL.** Finding 1 reproduces cumulative snapshot overcount from the current router/worker contract. Exact duplicate collapse at `perp-realized-pnl.ts:74-82,123-130` does not collapse cumulative snapshots with different delta sizes/timestamps.
5. **FAIL.** Tests are behavioral, and both original regressions are represented: the base helper would return `100.306336` for the ETHFI fixture now expecting `124.670392` (`perp-realized-pnl.test.ts:9-16`; base algorithm `perp-realized-pnl.ts:74-90`), and `25` for the incomplete-history fixture now expecting `null` (`perp-realized-pnl.test.ts:36-42`; base algorithm `perp-realized-pnl.ts:84-92`). The new mismatch, missing-P&L, and ambiguous-order assertions are useful boundaries, but there is no test for the production parent/synthetic cumulative-snapshot shape that fails check 4.
6. **APPLIED.** Every checklist item is recorded below with a reason and current evidence.
7. **PASS.** `git rev-list --parents -n 1` confirms the stated base as parent; `git diff-tree --name-status` shows only `apps/api/src/lib/perp-realized-pnl.ts` and `apps/api/src/__tests__/perp-realized-pnl.test.ts`. No unrelated commit diff or verifier-time source/test/ledger changes.
8. **PASS.** Required focused and canonical gates completed in the specified order; totals and baseline comparison are below.

## Strict Checklist

### Money-Loss

- Wrong account: **PASS** - `listPerps` resolves the wallet for `ctx.userId`, then scopes the durable order query to that user, Hyperliquid venue, and network (`apps/api/src/routers/positions.ts:1576-1601`).
- Size: **PASS** - positive sizes parse as exact decimals; reconstructed signed exposure must equal live side and size, otherwise result is `null` (`apps/api/src/lib/perp-realized-pnl.ts:26-52,134-141,189-192`; mismatch test `perp-realized-pnl.test.ts:36-42`). The cumulative-row P&L issue is tracked separately.
- Side: **PASS** - known buy/sell actions map to signed sizes and the final signed side is compared with live position (`apps/api/src/lib/perp-realized-pnl.ts:55-70,139-141,189-192`; symmetry/flip tests `perp-realized-pnl.test.ts:44-60`).
- Leverage: **N/A** - this helper only returns realized P&L for a supplied position and creates no order or leverage value (`apps/api/src/lib/perp-realized-pnl.ts:117-120`).
- Consent: **N/A** - the reviewed path is a read-only `listPerps` query and has no order/consent transition (`apps/api/src/routers/positions.ts:1574-1607`).
- Attribution: **PASS** - wallet resolution and order history are scoped to the authenticated user; order rows are also constrained by venue/network (`apps/api/src/routers/positions.ts:1576-1601`).

### Parity

- Stocks and perps: **PASS** - the stock open-run reference resets at flat and starts a new run on a flip (`apps/api/src/routers/positions.ts:302-350`); unchanged stock parity tests pass, and perps behavior is tested in `apps/api/src/__tests__/perp-realized-pnl.test.ts:9-60`.
- Entry behavior: **PASS** - same-side scale-ins preserve the run total (`apps/api/src/lib/perp-realized-pnl.ts:167-186`; `perp-realized-pnl.test.ts:9-16,44-51`).
- Exit behavior: **PASS** - flat and true flips reset the open-run total (`apps/api/src/lib/perp-realized-pnl.ts:168-186`; `perp-realized-pnl.test.ts:19-26,54-60`).

### Boundaries

- Empty state: **PASS** - no opening history yields `null` for a live position (`apps/api/src/__tests__/perp-realized-pnl.test.ts:28-34`); a missing/empty history cannot produce a matching nonzero exposure (`perp-realized-pnl.ts:143-155,189-192`).
- Malformed state: **PASS** - malformed decimal, unsupported action, or missing/non-finite execution timestamp marks the history invalid (`apps/api/src/lib/perp-realized-pnl.ts:26-33,55-70,143-155`); missing close P&L returns `null` (`perp-realized-pnl.test.ts:63-69`).
- Missing state: **PASS** - missing opening fill and missing close P&L fail closed (`apps/api/src/__tests__/perp-realized-pnl.test.ts:28-34,63-69`).
- Stale state: **FAIL** - no completeness watermark exists, and finding 2 shows a stale subset with the same net exposure returns `5` rather than `null` (`apps/api/src/lib/perp-realized-pnl.ts:189-192`; input/output described above).
- Partial state: **FAIL** - detectable size mismatch returns `null`, but the production multi-update row shape can either overstate cumulative P&L or be rejected as ambiguous; see finding 1 and the query/worker evidence there.

### Duplication

- Replay: **PASS** - exact duplicate rows are collapsed and have a behavioral assertion (`apps/api/src/lib/perp-realized-pnl.ts:74-82,123-130`; `perp-realized-pnl.test.ts:80-87`). This does not cover distinct cumulative snapshots.
- Retries: **N/A** - the helper is a pure read-time calculation and has no externally visible or financial side effect (`apps/api/src/lib/perp-realized-pnl.ts:117-120`).
- Reconciliation: **FAIL** - per-order cumulative snapshots on synthetic delta rows are summed as separate close P&L, or collide with the retained parent and return `null` (finding 1).
- Competing workers: **PASS** - worker reconciliation updates the parent inside a transaction with status/size/cursor compare-and-set before inserting its synthetic child (`apps/worker/src/services/hyperliquid-order-sync.ts:1311-1328,1378-1424`). This existing worker code was not changed.

## Verification Gates

- `bun test apps/api/src/__tests__/perp-realized-pnl.test.ts`: **PASS**, 9 pass, 0 fail.
- `bun test apps/api/src/__tests__/realized-pnl.test.ts`: **PASS**, 25 pass, 0 fail.
- `bun test --timeout 30000`: **PASS**, 5,189 pass, 40 skip, 0 fail; 5,229 tests across 324 files. Compared with baseline 5,184 pass / 40 skip / 0 fail, this is exactly +5 pass. The diff adds exactly five helper tests.
- `bun run check-types`: **PASS**, 11/11 packages successful (Turbo reported all 11 cached).
- `bun run lint`: **PASS**, exit 0, 23 warnings, matching baseline.
- `git diff --check <base>..<reviewed tree>`: **PASS**, no whitespace errors.

## Remaining Proof

No live account, order, production data, credential, or network verification was performed. Before acceptance, add a deterministic route/helper regression that uses the worker's actual cumulative parent and synthetic delta row contract, including a cancelled parent, and establish a trustworthy history-completeness signal for same-size stale histories. No source, test, or ledger edits were made during this review.
