# Final STRICT Verification: RST-019 Round 4

- Verdict: **ACCEPT**
- Accepted base: `fb8c3b841db5a34b454cfee154dfe9c010e376a4`
- Combined committed A/B HEAD: `39c29387abe092dc14bfcd5e9103efa1f46c701b`
- Reviewed tree: that HEAD plus the six Group C source/test modifications. The accepted-base diff is 12 paths, +1,783/-208.
- Round 4 changes only the mounted-test isolation in `perp-positions-panel.mobile.test.tsx:180-213`; runtime source is unchanged from Round 2.

## Round-4 Finding: Closed

The test now follows the established child-process browser-fixture pattern in `apps/web-v2/src/components/copy-trade/copy-trade-panel-clock.test.ts:3-19`. With Playwright opt-in enabled, the parent runs a named wrapper and skips the mounted case; the wrapper starts a fresh Bun test process with `RST_PERP_PANEL_MOUNTED_CHILD=1`, captures its output, and asserts a zero exit (`perp-positions-panel.mobile.test.tsx:180-212`). This keeps the real mounted fixture out of other files' Bun/module state.

The child still builds and mounts the real `PerpPositionsPanel`: its fixture imports `perp-positions-panel.tsx` and renders it through React DOM (`perp-positions-panel.mobile.test.tsx:280-358`). The tRPC fixture records actual `.mutate` calls and variables (`:256-269`). For cached successful empty and populated data, it transitions to background fetching or advances the browser clock to the 15-second boundary without rerender; the revision and control identities remain unchanged, then actual Set, Edit, Update, and Cancel controls are clicked and the mutation log must remain empty (`:403-425,461-483,507-534`). Because the query mock reads current state through a proxy and the handlers use invocation-time freshness checks, bypassing a real handler guard would be observed by the mutation spy. Fresh snapshots restore real dispatch: Set asserts the full-position payload (`:484-502`), and populated data asserts `modifyPerpTpSl` and `cancelPerp` names and variables (`:535-552`). Browser routes intercept external requests and the test asserts none escaped (`:370-393,557`).

The reproduction now passes with onboarding and the mounted test in the same opt-in Bun process: **31 passed, 0 failed, 255 expectations, 2 files**. The isolated child reports its mounted case passing (1 pass, 24 filtered, 24 expectations). This closes the Round-3-only test-interference finding.

## Original Findings

All six original RST-019 behavior findings remain closed:

1. **PASS: stale open-order actionability and handler dispatch.** Actionability requires successful, settled, valid, fresh (<15s) data, with invocation-time guards on Set/Edit/Cancel (`perp-tpsl-intent.ts:14-43`; `perp-positions-panel.tsx:220-235,516-547,572-573,640-667`). Round 4 adds the actual-control and mutation-spy proof above.
2. **PASS: stock TP parsing.** Full-string decimal parsing rejects malformed suffixes and dispatches nothing (`stock-exit-save.ts:29-40`; `stock-exit-save.test.ts`).
3. **PASS: stock direction and invalid current prices.** Save paths require a finite positive market price and retain strict long/short boundaries (`stop-loss-input.ts:22-56`; `stock-exit-save.ts:43-66`).
4. **PASS: full-position size contract.** The table sends `sizeMode: "full-position"`; the API uses exact decimal-string comparison before reservation, without `Number`, epsilon, or rounding. Mismatched/unusable sizes stop before DB writes and broker calls; explicit partial and omitted-mode callers remain compatible (`perp-positions-panel.tsx:655-665`; `orders.ts:71-90,3148-3156,3170-3207`; `perp-trigger-router.test.ts`).
5. **PASS: idempotency and reconciliation.** Ambiguous outcomes retain the intent key and durable PENDING state; definitive outcomes clear the key, and an existing ambiguous key is not resubmitted (`perp-positions-panel.tsx:366-400`; `perp-tpsl-intent.ts`; `orders.ts:234-295,3194-3229`).
6. **PASS: stock populated display and dispatch payloads.** Populated/empty exit-order rendering and selected credential, order ID, and price-field dispatch remain covered (`__tests__/positions-panel.test.ts`; `stock-exit-save.test.ts`; `positions-panel.tsx:740-805,822-904`).

No runtime source changed in Rounds 3 or 4; runtime behavior remains as reviewed in Round 2. The six source/test modifications in the final worktree are the scoped A/B/C changes; Round 4 itself changed only the panel test.

## Fresh Gates

- Mounted panel opt-in: **25 passed, 0 failed, 143 expectations; 1 file**.
- Onboarding + mounted panel opt-in: **31 passed, 0 failed, 255 expectations; 2 files**.
- Group A focused: **39 passed, 1 opt-in test skipped, 0 failed, 191 expectations; 2 files**.
- Group C focused: **43 passed, 0 failed, 145 expectations; 2 files**.
- Exact combined command from the plan: **409 passed, 1 opt-in test skipped, 0 failed, 1,408 expectations; 14 files**.
- Canonical `bun test --timeout 30000`: **5,314 passed, 53 skipped, 0 failed; 5,367 tests across 334 files; 15,933 expectations**.
- Forced uncached `bun run check-types --force`: **11/11 successful, 0 cached**.
- `bun run lint`: **exit 0, 23 warnings**, none on the six changed source/test paths.
- `git diff --check`: **PASS** (rerun after this report edit; the untracked report is checked separately).

## Full Opt-In Baseline

Exact command on both trees: `RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test --timeout 30000`.

- Current: **5,322 passed, 33 skipped, 1 failed; 5,356 tests across 334 files; 16,047 expectations**.
- Accepted base `fb8c3b84`: **5,212 passed, 27 skipped, 1 failed; 5,240 tests across 326 files; 15,451 expectations**.
- Both runs report the same sole failing test: `sizing modes are named in words > renders coherent sizing dividers across sm and xl`. There is no current-only failure; Bun's `EISDIR` diagnostics around that viewport test are also present on the accepted base.

## History and Scope

This is the first ACCEPT after three rejected review rounds: Round 1 rejected the six original behavior findings; Round 2 rejected because actual component-handler click-through proof was missing (and lint/diff-check were outstanding); Round 3 rejected because its mounted fixture introduced a current-only Bun/module setup failure in the onboarding test. Round 4 closes that test-isolation issue and reruns the required gates. Verifier context: this is an independent replacement-verifier pass over the same worktree; no source or test files were edited by the verifier.

All browser requests were intercepted or satisfied by local fixtures. No live services, credentials, production data, or real broker calls were used. No commit or push was made. The 12 temporary dependency symlinks were removed individually; their accepted-base target directories remain intact. Final status is exactly these six modified source/test files plus this report: `apps/api/src/__tests__/perp-trigger-router.test.ts`, `apps/api/src/routers/orders.ts`, `apps/web-v2/src/components/trade/perp-positions-panel.mobile.test.tsx`, `apps/web-v2/src/components/trade/perp-positions-panel.tsx`, `apps/web-v2/src/components/trade/perp-tpsl-intent.test.ts`, and `apps/web-v2/src/components/trade/perp-tpsl-intent.ts`.
