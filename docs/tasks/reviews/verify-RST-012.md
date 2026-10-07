# RST-012 Strict Verification Report

- **Ticket:** RST-012
- **Base SHA:** `2fc6ea6860ead27805eaa8d21c318e8fb9bfc27b`
- **Round-2 reviewed tree:** `053c6822f76489912690b7c66a856c8b86808421`
- **Round-2 parent:** `10aabc655892d60004fbbb0d80ee0a79f7849290`
- **Round-3 reviewed tree:** `d03a3bbd107739410f51558e08184cdab785165e`
- **Round-3 parent:** `10aabc655892d60004fbbb0d80ee0a79f7849290`
- **Round-4 reviewed tree:** `403cb2aa524fcf1b349afee7014c0f978c56166c`
- **Round-4 parent:** `10aabc655892d60004fbbb0d80ee0a79f7849290`
- **Round-5 reviewed tree:** `145f7e4a2b59e5f1d1b2da56b702ca36b4ac858d`
- **Round-5 parent:** `10aabc655892d60004fbbb0d80ee0a79f7849290`
- **Round-1 reviewed tree:** `10aabc655892d60004fbbb0d80ee0a79f7849290`
- **Model / round:** GPT-5, strict verification, Round 5; Round-1/2/3/4 records retained below
- **Scope:** Exact detached worktree `/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-wallet-existing`; report-only write scope.
- **Round-2 verdict: REJECT (historical)**
- **Round-3 verdict: REJECT (historical)**
- **Round-4 verdict: REJECT (historical)**
- **Round-5 verdict: STRICT ACCEPT**

Round 5 closes the remaining Round-4 proof gap. The 1-USDC interactive case now checks zero account mutations before and after 20 seconds, and verifies the pending and timeout notices, account/balance snapshot, hidden funding hint and controls, and zero wallet/account actions in both states. All requested offline verification gates pass; no live restore proof is claimed.

## Round 1 Finding

### RST-012-F1: Unresolved custom-auth sessions can bypass the timeout indefinitely

`waitingForCustomAuth` requires `wallet.ready` and, for an authenticated session, requires `!embeddedAddress` before it considers an unverified subject to be waiting (`apps/web-v2/src/components/perps/perps-onboarding-card.tsx:684-690`). Thus an already-present embedded address with `subjectVerified=false` and `subjectMismatch=false` never arms the timer; `wallet.ready=false` also never arms it. The card shows only `Loading wallet...` for the latter (`:1023-1024`) or the pending-verification state (`:960-970,1302-1308`) for the former. Export and deposit remain blocked until verification (`:1434-1446,1517-1528`), while the timeout notice with Retry/Reset is only rendered in other branches (`:787-827,1048-1055,1106-1113`). The existing-account user can therefore remain without wallet-management recovery indefinitely; the ordinary account Refresh is not a Privy-session Retry or Reset.

The static card test confirms that an embedded wallet with unresolved subject is read-only, but does not advance time or assert recovery controls (`apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx:167-190`). The suite uses `renderToStaticMarkup` (`:21-22,112-115`); it has no mounted fake-timer test for timeout, Reset, Retry, or repeated retry.

**Exact correction:** Arm a bounded timeout for unresolved custom-auth readiness and subject verification independent of whether an embedded address already exists. After expiry, render the existing Retry/Reset session notice in both the wallet-loading and existing-account pending-subject branches, while continuing to block funding, export, and signing until verification succeeds. Add mounted card tests with fake timers for unresolved subject with an embedded address, `wallet.ready=false`, the ready-but-missing-wallet state, and repeated Retry/Reset. Assert Reset invokes only Privy logout/reload and does not call any account mutation or alter the stored master, agent, or balance.

## Round 1 Numbered Audit

1. **Reconnect, subject gate, timeout, Retry, and Reset trace: FAIL.** Existing-account reconnect and the read-only unverified-subject gate are present (`perps-onboarding-card.tsx:313-370,946-970,1302-1308`). The timeout predicate misses unresolved subject with an embedded address and wallet-not-ready (`:684-707`); Retry/Reset exist only in the timeout notice (`:787-827`) and are not reachable in those stuck states. Reset calls `wallet.logout()` and reloads without invoking a perps account mutation (`:759-781`); `usePerpsWallet` exposes Privy's `logout` directly (`use-perps-wallet.ts:167-175,378-389`).
2. **No permanent wallet-action dead end; Reset isolation: FAIL / PASS.** The UI can remain wallet-management-blocked indefinitely in the two states in F1. By code inspection, Reset only calls the browser's Privy logout and reload; the handler does not rebind or delete the server master, agent, or balance (`perps-onboarding-card.tsx:759-781`). The code path is safe, but no behavioral test currently exercises that control.
3. **Loading, mismatch, missing wallet, stale subject, repeated retry coverage: FAIL.** Existing static tests cover mismatch (`perps-onboarding-card.test.tsx:192-224`), no wallet/legacy recovery (`:144-165`), and unresolved subject (`:167-190`); a wallet-list-pending state is also rendered (`:338-362`). They do not cover `wallet.ready=false`, timer expiry, Retry/Reset interactions, or repeated retry. The mismatch test is rendered markup, not an interactive control test.
4. **Focused pure/mocked restore tests and live proof: PASS / BLOCKED.** The prescribed offline restore group passed. No live Privy session or account was used. Live restore proof remains unavailable and is not claimed.

## Round 1 Strict Checklist

| Category | Item | Result | Evidence |
|---|---|---|---|
| Money-loss | Wrong account | PASS | Stored-master matching and unverified-session blocks prevent wallet actions; `perps-onboarding-card.tsx:340-370,711-728,1434-1446,1517-1528`; mismatch rendering test `perps-onboarding-card.test.tsx:192-224`. |
| Money-loss | Size | N/A | Restore/reset changes no order size or collateral calculation. |
| Money-loss | Side | N/A | Restore/reset submits no venue order and selects no position direction. |
| Money-loss | Leverage | N/A | Restore/reset does not set or change leverage. |
| Money-loss | Consent | PASS | Subject verification is required for wallet-session actions; pending/mismatch states block auto/manual actions: `perps-onboarding-card.tsx:348-370,711-728,1517-1528`; pure subject-gate tests in `perps-onboarding.test.ts:90-151`. |
| Money-loss | Attribution | PASS | Enabled-account actions are tied to the stored master and verified custom-auth subject: `perps-onboarding-card.tsx:340-370`; `perps-onboarding.test.ts:90-151`. |
| Parity | Stocks and perps | N/A | This restore flow is the Hyperliquid wallet UI, not a stock/perp execution parity change. |
| Parity | Entry behavior | N/A | Restore/reset does not create a trading entry. |
| Parity | Exit behavior | N/A | Restore/reset does not close or modify a position. |
| Boundaries | Empty state | PASS | Missing embedded wallet stays in existing-wallet preparation or recovery; it does not select a replacement for an enabled account: `perps-onboarding-card.tsx:321-325,1048-1055`; `perps-onboarding-card.test.tsx:144-165,338-362`. |
| Boundaries | Malformed state | PASS | Invalid/missing stored master is surfaced as unavailable and funding/export/signing are disabled: `perps-onboarding-card.tsx:354-370,1027-1047`. |
| Boundaries | Missing state | PASS | A missing wallet has a recovery-only path; Reset does not change server account state: `perps-onboarding-card.tsx:739-781,1048-1113`; static coverage at `perps-onboarding-card.test.tsx:144-165`. |
| Boundaries | Stale state | FAIL | Unresolved/stale custom-auth subject with an embedded address bypasses the timeout; wallet-not-ready does too: `perps-onboarding-card.tsx:684-707,1023-1025,1302-1308`; see F1. |
| Boundaries | Partial state | PASS | Reset errors are caught and shown without a server mutation; the handler only logs out and reloads: `perps-onboarding-card.tsx:762-781`. Interaction coverage is still missing under audit item 3. |
| Duplication | Replay | N/A | The card restore path does not replay trading events or write order state. |
| Duplication | Retries | PASS | Retry reloads the page and Reset logs out the browser session; neither calls a financial/account mutation (`perps-onboarding-card.tsx:801-822,762-770`). Repeated control behavior is not behaviorally tested; see audit item 3. |
| Duplication | Reconciliation | N/A | The card restore path does not reconcile venue orders or persisted trading state. |
| Duplication | Competing workers | N/A | The UI restore/reset flow starts no background trading worker or competing order action. |

## Round 1 Gates

- `bun test apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx` — **PASS**, 70 passed, 0 failed, 170 expectations.
- `bun test --timeout 30000` — **PASS**, 5,205 passed, 40 skipped, 0 failed, 15,338 expectations across 325 files.
- `bun run check-types` — **PASS**, 11/11 packages.
- `bun run lint` — **PASS**, exit 0 with 23 warnings.

No source or test files were changed. This REJECT requires the bounded timeout/control fix and interactive card coverage above; live Privy restore proof remains separately blocked.

## Round 2 Review

**Verdict: REJECT.** The timeout, retry, reset, local-fixture, and scope checks pass. One required action gate remains open.

### RST-012-R2-F1: Direct funding remains available while the subject is unverified

The round-2 fixture has an enabled account whose embedded address matches the synthetic stored master while `subjectVerified=false` (`apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx:6,21-27,61-75,308-321`). In that state `walletMismatch` is false. The address row and its `Copy` button are rendered whenever `!walletMismatch` (`apps/web-v2/src/components/perps/perps-onboarding-card.tsx:1323-1337`); `handleCopy` checks only that an embedded address exists and matches the stored master, not `walletSessionVerified` (`:461-469`). The direct-funding instructions and `Copy address` button are likewise gated only by `!walletMismatch` (`:1453-1472`). This still invites and enables a direct external transfer while the subject is pending, contrary to the round-2 requirement that funding remain blocked until subject verification.

The new browser test verifies that export is absent, deposit is disabled, activation is absent, and no instrumented wallet/account mutation fires (`perps-onboarding-card-timeout.test.tsx:332-338`). It does not assert that the `How to fund your wallet` section or either address-copy control is absent, and it does not instrument clipboard writes. The `wallet.fund` counter alone does not cover these direct-transfer affordances.

**Exact correction:** For an enabled account with an unverified custom-auth subject, hide the wallet-address copy control and direct-funding instructions/copy CTA until `walletSessionVerified` is true, and make `handleCopy` fail closed on the same predicate. Keep the pending-verification and timeout notices and server-side account/balance display. Extend the interactive pending-subject test to assert the funding instructions and copy controls are unavailable and no clipboard or funding action can occur before verification. Preserve the existing stored-master mismatch behavior.

### Numbered Verification

1. **20-second timeout behavior: PASS.** The existing duration remains `20_000` (`perps-onboarding-card.tsx:141`). The predicate now waits for custom-auth readiness, authentication, unresolved subject verification, or an unsettled missing-wallet list (`:667-692`). The not-ready branch shows the existing notice only after timeout (`:1008-1013`); the embedded-address pending-subject branch shows it at timeout without removing the pending banner (`:1291-1301`). The mounted tests assert no controls at 19,999 ms and the notice plus both controls at 20,000 ms for both states (`perps-onboarding-card-timeout.test.tsx:285-344`).
2. **Pending-subject action gates: FAIL.** Export remains gated by verified session (`perps-onboarding-card.tsx:694-722,1428-1441`), deposit remains disabled (`:1511-1525`), activation/signing remains gated (`:472-494,1562-1568`), and the auto-action helper rejects an unverified subject (`apps/web-v2/src/lib/perps-onboarding.test.ts`, test `H1: an unverified Privy subject blocks EVERY auto action`). However, direct funding instructions and address copying remain available, as detailed in R2-F1. No identity, mismatch, or server account mutation is introduced by the timeout diff.
3. **Retry: PASS.** Retry performs one local fixture navigation/reload, with no logout or instrumented wallet/account mutation, and remains available across two reload attempts (`perps-onboarding-card-timeout.test.tsx:346-372`). The route records the local fixture origin and fulfills requests locally (`:190-224`); each test asserts no external requests.
4. **Reset: PASS.** Successful Reset records exactly one `wallet.logout` followed by one local reload, preserves the synthetic master/funded-agent status/balance snapshot, and makes no other wallet or account mutation; the test repeats this twice (`perps-onboarding-card-timeout.test.tsx:238-277,374-408`). Rejected logout causes no reload, surfaces the error, re-enables the controls, and a subsequent successful reset follows the same one-logout/one-reload order (`:410-445`). The source handler only logs out then reloads on success and always clears its resetting state (`perps-onboarding-card.tsx:747-766`).
5. **Local browser fixture and no live access: PASS.** The fixture uses a synthetic master and local status (`perps-onboarding-card-timeout.test.tsx:5-7,19-120`), mocks wallet/tRPC boundaries, fulfills all requests through the page route (`:190-212`), and asserts the external-request list is empty. The exact `RST_PLAYWRIGHT_MODULE` path was supplied for the opt-in gate. All five browser tests ran, none were skipped; no Privy/provider/account access was used.
6. **Cold diff and unchanged behavior: PASS, with R2-F1 outstanding.** Parent-to-commit diff contains exactly the authorized paths: added `apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` and modified `apps/web-v2/src/components/perps/perps-onboarding-card.tsx`. The diff retains the existing timeout duration, Retry/Reset handlers, export/deposit/sign/auto-action gates, mismatch UI, and server account state. A verified, authenticated, settled no-address session does not satisfy the wait predicate and remains on the existing legacy recovery path (`perps-onboarding-card.tsx:670-675,321-331,1037-1104`; existing static recovery tests at `apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx:144-165,338-362`).
7. **Gates and working-tree scope: PASS.** Actual results are below. Before canonical tests, `packages/db/dist` did not exist, so no generated output needed moving; none was deleted. The working tree initially contained only the two authorized untracked verifier reports. This round edits only this RST-012 report; RST-011 remains byte-for-byte unchanged.

### Round-2 Strict Checklist

| Category | Item | Result | Evidence |
|---|---|---|---|
| Money-loss | Wrong account | PASS | The embedded address is matched against the stored master; mismatch UI/actions remain unchanged: `perps-onboarding-card.tsx:354-367,1323-1337`; existing mismatch test `perps-onboarding-card.test.tsx:192-224`. |
| Money-loss | Size | N/A | This restore-timeout change does not size orders. |
| Money-loss | Side | N/A | This restore-timeout change does not select an order side. |
| Money-loss | Leverage | N/A | This restore-timeout change does not set leverage. |
| Money-loss | Consent | FAIL | Direct funding instructions and copy controls remain available before subject verification: `perps-onboarding-card.tsx:1453-1472`; see R2-F1. |
| Money-loss | Attribution | PASS | No stored master or account binding is changed; the tested address equals the synthetic stored master, and Reset only invokes Privy logout/reload: `perps-onboarding-card-timeout.test.tsx:21-27,238-253,374-408`; `perps-onboarding-card.tsx:747-766`. |
| Parity | Stocks and perps | N/A | No trading execution path is changed by this UI timeout fix. |
| Parity | Entry behavior | N/A | The card timeout does not submit an entry. |
| Parity | Exit behavior | N/A | The card timeout does not submit an exit. |
| Boundaries | Empty state | PASS | A settled verified no-address account retains the existing legacy recovery branch: `perps-onboarding-card.tsx:670-675,321-331,1037-1104`; `perps-onboarding-card.test.tsx:144-165`. |
| Boundaries | Malformed state | PASS | Existing malformed/missing master guard remains untouched: `perps-onboarding-card.tsx:354-370,1016-1036`. |
| Boundaries | Missing state | PASS | Missing-wallet recovery behavior is unchanged by the diff: `perps-onboarding-card.tsx:1037-1104,1170-1221`; static tests `perps-onboarding-card.test.tsx:144-165,338-362`. |
| Boundaries | Stale state | FAIL | The timeout now appears at 20 seconds, but pending subject still sees copy/direct-funding affordances: `perps-onboarding-card.tsx:670-692,1291-1301,1323-1337,1453-1472`; see R2-F1. |
| Boundaries | Partial state | PASS | Failed logout does not reload, exposes its error, and clears resetting state; success preserves the synthetic account snapshot: `perps-onboarding-card.tsx:747-766`; `perps-onboarding-card-timeout.test.tsx:374-445`. |
| Duplication | Replay | N/A | The timeout UI does not replay trading events. |
| Duplication | Retries | PASS | Repeated Retry is one local reload per click, with no logout or mutation: `perps-onboarding-card-timeout.test.tsx:346-372`. |
| Duplication | Reconciliation | N/A | The timeout UI does not reconcile orders. |
| Duplication | Competing workers | N/A | The timeout UI does not start trading workers. |

### Round-2 Gates

- `bun test apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx` — **PASS**, 70 passed, 0 failed, 170 expectations.
- `RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test --timeout 30000 apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` — **PASS**, 5 passed, 0 failed, 0 skipped, 76 expectations.
- `bun test --timeout 30000` — **PASS**, 5,205 passed, 45 skipped, 0 failed, 15,338 expectations across 326 files. The five opt-in browser tests were skipped in this canonical invocation because the opt-in variable was not in that command's environment; they ran separately above with 0 skipped.
- `bun run check-types` — **PASS**, 11/11 packages (10 cached).
- `bun run lint` — **PASS**, exit 0 with 23 warnings; no warning in either changed source/test path.
- `git diff --check` — **PASS**, exit 0.

No live Privy/provider/account access or production data was used. No source, test, ledger, or RST-011 report was changed by the Round-2 verification. As recorded then, its verdict was **REJECT** because direct-funding/copy affordances were not yet gated on verified session; Round 3 rechecks those controls below and records the remaining low-balance edge separately. Live restore proof remains unverified.

## Round 3 Review

**Verdict: REJECT.** The Round-2 correction is present and its requested browser assertions pass. One direct-funding prompt remains reachable for an unverified subject when the on-wallet USDC balance is below the deposit minimum.

### RST-012-R3-F1: Low-balance prompt still instructs an unverified user to fund

The pending-subject card hides the wallet row's `Copy` button (`perps-onboarding-card.tsx:1323-1337`) and the full external-funding instructions plus `Copy address` button (`:1455-1474`) unless `walletSessionVerified` is true. The click handler also returns before clipboard access unless the address is bound and the session is verified (`:461-469`). The enabled-account `Deposit USDC` action remains disabled for an unverified session (`:1513-1527`). The interactive test asserts that both copy controls and the external-funding panel are absent, clipboard and wallet/account action events stay zero, and the deposit button is disabled (`perps-onboarding-card-timeout.test.tsx:255-285,316-357`).

However, when `walletUsdc` is known and below `PERPS_MIN_USABLE_DEPOSIT_USDC`, a separate message says `Fund your wallet with at least ... (see How to fund your wallet above), then deposit` without checking `walletSessionVerified` (`perps-onboarding-card.tsx:1535-1541`). That is a direct-funding instruction in the same pending-subject state where the banner says funding is paused (`:945-955`). The browser fixture fixes the mock wallet balance at 2,000 USDC (`perps-onboarding-card-timeout.test.tsx:91,115`), so the low-balance message does not render in its assertions.

**Exact correction:** Gate the low-balance funding prompt on `walletSessionVerified`, or replace it while verification is pending with neutral copy that says funding is paused. Add an interactive pending-subject case with on-wallet USDC below the minimum and assert the prompt, copy controls, and funding actions remain unavailable while the server account/balance, pending and timeout notices remain visible and `Deposit USDC` stays disabled.

### Round-3 Numbered Verification

1. **Reconnect, subject gate, timeout, Retry, and Reset: PASS, subject to R3-F1.** Existing-account reconnect and mismatch-reset decisions flow through the card helpers (`perps-onboarding-card.tsx:315-352`; `perps-card-display.ts:93-114,116-160`). Session verification remains the control for manual wallet actions (`perps-onboarding-card.tsx:348-352,461-469,694-708`). The revised custom-auth predicate covers wallet-not-ready, unauthenticated, unresolved subject, and unsettled wallet-list states (`:667-692`); timeout notices appear in loading, existing-wallet, no-wallet, and pending-subject branches (`:1008-1013,1037-1044,1095-1102,1197-1222,1295-1301`). Retry reloads; Reset calls only `wallet.logout()` and reloads on success (`:747-766,786-807`).
2. **No permanent dead end; Reset isolation and account preservation: PASS.** The browser test reaches the timeout at exactly 20,000 ms, retries twice, resets twice, and covers a rejected logout followed by a successful reset (`perps-onboarding-card-timeout.test.tsx:293-355,359-456`). It checks one local reload per action, Reset's logout-before-reload order, no account mutation, and stable stored-master/agent/balance snapshots (`:238-252,359-456`). The `usePerpsWallet` hook returns Privy's `logout` directly (`use-perps-wallet.ts:167-175,378-389`); the card handler invokes no account mutation (`perps-onboarding-card.tsx:747-766`).
3. **Loading, mismatch, missing wallet, stale subject, repeated retry: PASS, with a low-balance funding gap.** The real browser test covers `wallet.ready=false`, a matching embedded wallet with unresolved subject, both timeout thresholds, and repeated Retry/Reset (`perps-onboarding-card-timeout.test.tsx:293-456`). Existing static card tests render the pending subject and wrong-address mismatch (`perps-onboarding-card.test.tsx:167-224`), plus missing-wallet and wallet-list-pending states (`:144-165,338-362`). Mismatch derivation and warning/reset UI remain intact (`perps-onboarding-card.tsx:333-339,354-367,935-980,1303-1317`); helper tests cover stale-subject reset eligibility (`perps-card-display.test.ts:230-298`). The newly requested funding invariant is incomplete only for the low-balance hint in R3-F1.
4. **Round-2 funding/copy correction: PARTIAL.** The address-copy button and direct-funding panel are gated on `walletSessionVerified`, `handleCopy` fails closed on that predicate, and the interactive test checks absent controls plus zero clipboard and wallet/account action events (`perps-onboarding-card.tsx:461-469,1323-1337,1455-1474`; `perps-onboarding-card-timeout.test.tsx:255-285,330-351`). The low-balance inline funding prompt is not gated and its conditional branch is not exercised (`perps-onboarding-card.tsx:1535-1541`; fixture balances `:91,115`).
5. **Pure/mocked restore tests and live proof: PASS / BLOCKED.** The prescribed offline restore tests passed. All interactive fixtures use synthetic addresses and local mocked tRPC/wallet modules; the route fulfills requests locally and the browser assertions record no external requests (`perps-onboarding-card-timeout.test.tsx:5-7,19-120,181-224,308,351`). No live Privy session, account, credentials, keys, or production data were accessed; live restore proof remains unavailable and is not claimed.
6. **Exact diff and scope: PASS.** Parent-to-candidate diff contains exactly `A apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` and `M apps/web-v2/src/components/perps/perps-onboarding-card.tsx`. The verifier changed only this RST-012 report. `verify-RST-011.md` remains byte-for-byte unchanged; no source, test, or ledger path was edited by the verifier.
7. **Required gates: PASS.** Exact current results are listed below. `packages/db/dist` did not exist before or after the canonical suite, and no generated artifacts were left behind.

### Round-3 Strict Checklist

| Category | Item | Result | Evidence |
|---|---|---|---|
| Money-loss | Wrong account | PASS | Stored-master binding and mismatch handling are unchanged: `perps-onboarding-card.tsx:354-367,1303-1317`; card mismatch test `perps-onboarding-card.test.tsx:192-224`. |
| Money-loss | Size | N/A | The restore-timeout UI does not size orders. |
| Money-loss | Side | N/A | The restore-timeout UI does not choose an order side. |
| Money-loss | Leverage | N/A | The restore-timeout UI does not set leverage. |
| Money-loss | Consent | FAIL | With low on-wallet USDC, the prompt still instructs the unverified user to fund: `perps-onboarding-card.tsx:1535-1541`; see R3-F1. |
| Money-loss | Attribution | PASS | Reset only logs out the browser wallet session and reloads; the test preserves stored master, agent status, and balance: `perps-onboarding-card.tsx:747-766`; `perps-onboarding-card-timeout.test.tsx:238-252,387-456`. |
| Parity | Stocks and perps | N/A | No trading execution path is changed. |
| Parity | Entry behavior | N/A | The restore flow submits no trading entry. |
| Parity | Exit behavior | N/A | The restore flow submits no trading exit. |
| Boundaries | Empty state | PASS | A settled verified no-address account retains the existing recovery branch: `perps-onboarding-card.tsx:670-675,1037-1104,1189-1235`; card tests `perps-onboarding-card.test.tsx:144-165,338-362`. |
| Boundaries | Malformed state | PASS | The stored-master validity guard remains unchanged: `perps-onboarding-card.tsx:354-370,1016-1036`. |
| Boundaries | Missing state | PASS | Existing missing-wallet recovery remains intact and is rendered in card tests: `perps-onboarding-card.tsx:1037-1104,1170-1235`; `perps-onboarding-card.test.tsx:144-165,338-362`. |
| Boundaries | Stale state | FAIL | The low-balance hint still directs the pending subject to fund the wallet: `perps-onboarding-card.tsx:945-955,1535-1541`; see R3-F1. |
| Boundaries | Partial state | PASS | Failed logout leaves the controls usable without reload; successful reset preserves the account snapshot: `perps-onboarding-card-timeout.test.tsx:423-456`. |
| Duplication | Replay | N/A | The UI does not replay trading events. |
| Duplication | Retries | PASS | Two Retry attempts each perform one local reload and no logout/account mutation: `perps-onboarding-card-timeout.test.tsx:359-385`. |
| Duplication | Reconciliation | N/A | The UI does not reconcile orders. |
| Duplication | Competing workers | N/A | The UI starts no trading worker. |

### Round-3 Gates

- `bun test apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx` — **PASS**, 70 passed, 0 failed, 170 expectations.
- `RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test --timeout 30000 apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` — **PASS**, 5 passed, 0 failed, 0 skipped, 87 expectations.
- `bun test --timeout 30000` — **PASS**, 5,205 passed, 45 skipped, 0 failed, 15,338 expectations across 326 files. The five opt-in browser tests skipped in this canonical invocation all passed in the separate interactive run above with 0 skipped.
- `bun run check-types` — **PASS**, 11/11 packages (11 cached).
- `bun run lint` — **PASS**, exit 0 with 23 warnings; none in the changed source or test path.
- `git diff --check 10aabc655892d60004fbbb0d80ee0a79f7849290 d03a3bbd107739410f51558e08184cdab785165e` — **PASS**, exit 0.

No live Privy/provider/account access, real keys, production data, or orders were used. As recorded for Round 3, its verdict remained **REJECT** until the low-balance funding prompt was gated and covered by a pending-subject browser case. Round 4's current result follows.

## Round 4 Review

**Verdict: REJECT.** The source correction is present: the low-balance prompt now requires `walletSessionVerified`, and the interactive browser test confirms the hint is absent at 1 USDC. The requested proof is incomplete because the low-balance test does not assert zero account mutations or retain the timeout notice in that same state.

### RST-012-R4-F1: Low-balance browser case omits account-mutation and timeout assertions

The source hides the low-balance `Fund your wallet...` prompt unless the session is verified (`perps-onboarding-card.tsx:1535-1543`). In the new low-balance browser case, the fixture returns 1 USDC (`perps-onboarding-card-timeout.test.tsx:113-117,360-379`). It asserts the pending banner, stored master/agent/Hyperliquid-balance snapshot, missing low-balance prompt, absent address-copy and direct-funding controls, zero clipboard writes and wallet action events, a disabled `Deposit USDC` button, and no external requests (`:239-287,360-379`).

The case does not call `accountMutationEvents(events)` even though that helper records enable/agent tRPC mutations (`:279-287`), and it does not advance the fake clock or assert the timeout notice. The standard pending-subject test does verify account mutations are zero and checks the exact 19,999/20,000 ms transition (`:317-358,351`), but that scenario uses the normal 2,000-USDC balance. Thus this run does not prove all requested no-account-action and timeout-display assertions while the low-balance branch is active.

**Exact correction:** In the low-balance browser test, assert `accountMutationEvents(events)` is empty. Advance the fake clock through the 20-second timeout and verify the timeout controls appear while the pending banner, account/balance snapshot, and hidden low-balance hint remain; reassert no clipboard, wallet, account, or external actions and that `Deposit USDC` stays disabled.

### Round-4 Numbered Verification

1. **Reconnect, subject gate, timeout, Retry, and Reset: PASS.** Existing-account reconnect and mismatch-reset decisions flow through the card helpers (`perps-onboarding-card.tsx:315-352`; `perps-card-display.ts:93-160`). Session verification guards wallet actions and now also gates the low-balance funding hint (`perps-onboarding-card.tsx:348-352,461-469,694-708,1535-1543`). The timeout predicate covers wallet-not-ready, unauthenticated, unresolved-subject, and unsettled wallet-list states (`:667-692`); the notice is rendered in the relevant loading/recovery/pending branches (`:1008-1013,1037-1044,1095-1102,1197-1222,1295-1301`).
2. **Low-balance funding/copy behavior: PARTIAL.** The source check and low-balance UI assertion pass. The low-balance case confirms the 1-USDC balance, account snapshot, pending notice, hidden prompt/copy controls, zero clipboard/wallet action events, disabled deposit, and no external requests (`perps-onboarding-card-timeout.test.tsx:239-287,360-379`). Its `events` do not get checked with `accountMutationEvents`, and it does not advance to the timeout notice; see R4-F1.
3. **Timing, Retry, Reset, failure/repeat behavior: PASS.** The normal pending fixture verifies no timeout controls at 19,999 ms and the timeout notice at 20,000 ms; Retry repeats twice with one local reload per click (`perps-onboarding-card-timeout.test.tsx:294-358,381-407`). Reset repeats twice, logs out before reload, and preserves the account snapshot; rejected logout leaves controls available and the next successful Reset reloads (`:409-480`).
4. **Action gates, mismatch, and legacy behavior: PASS.** `handleCopy`, export, deposit, activation, and auto-actions remain gated on verified identity/session (`perps-onboarding-card.tsx:348-370,395-480,694-722,1513-1527,1564-1569`; `perps-onboarding.test.ts`, test `H1: an unverified Privy subject blocks EVERY auto action`). The mismatch condition and recovery UI are unchanged (`perps-onboarding-card.tsx:333-367,935-980,1303-1317`); static card tests cover wrong-wallet mismatch and missing-wallet recovery (`perps-onboarding-card.test.tsx:144-224,338-362`), and helper tests cover mismatch reset (`perps-card-display.test.ts:230-298`).
5. **Local-only fixture/no live access: PASS.** Browser fixture uses a synthetic address, mocked wallet/tRPC modules, and the `.test` origin; all requests are intercepted and fulfilled locally (`perps-onboarding-card-timeout.test.tsx:5-7,19-129,181-225`). Tests assert no external requests. No live Privy session/account, credentials, keys, production data, or orders were used.
6. **Exact diff and write scope: PASS.** Parent-to-candidate diff contains exactly `A apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` and `M apps/web-v2/src/components/perps/perps-onboarding-card.tsx`. The verifier updated only this report. `verify-RST-011.md` remains byte-for-byte unchanged; no source, test, or ledger path was edited by the verifier.
7. **Required gates: PASS.** Results follow. `packages/db/dist` did not exist before or after canonical tests; no generated artifacts were left behind.

### Round-4 Strict Checklist

| Category | Item | Result | Evidence |
|---|---|---|---|
| Money-loss | Wrong account | PASS | Stored-master binding and mismatch handling remain intact: `perps-onboarding-card.tsx:354-367,1303-1317`; mismatch card test `perps-onboarding-card.test.tsx:192-224`. |
| Money-loss | Size | N/A | Restore UI changes no order sizing. |
| Money-loss | Side | N/A | Restore UI selects no order side. |
| Money-loss | Leverage | N/A | Restore UI changes no leverage. |
| Money-loss | Consent | PASS | Both copy controls/direct-funding panel and the low-balance prompt are hidden until session verification; deposit remains disabled: `perps-onboarding-card.tsx:1323-1337,1455-1474,1513-1527,1535-1543`; low-balance browser case `perps-onboarding-card-timeout.test.tsx:360-379`. Account-mutation/timeout coverage within that case remains incomplete under R4-F1. |
| Money-loss | Attribution | PASS | Reset invokes only browser wallet logout/reload; repeated tests preserve stored master, agent status, and balance: `perps-onboarding-card.tsx:747-766`; `perps-onboarding-card-timeout.test.tsx:409-480`. |
| Parity | Stocks and perps | N/A | No trading execution path changes. |
| Parity | Entry behavior | N/A | Restore flow submits no entry. |
| Parity | Exit behavior | N/A | Restore flow submits no exit. |
| Boundaries | Empty state | PASS | Settled verified no-address recovery remains intact: `perps-onboarding-card.tsx:670-675,1037-1104,1189-1235`; card tests `perps-onboarding-card.test.tsx:144-165,338-362`. |
| Boundaries | Malformed state | PASS | Stored-master validity guard is unchanged: `perps-onboarding-card.tsx:354-370,1016-1036`. |
| Boundaries | Missing state | PASS | Existing missing-wallet recovery remains intact and covered: `perps-onboarding-card.tsx:1037-1104,1170-1235`; `perps-onboarding-card.test.tsx:144-165,338-362`. |
| Boundaries | Stale state | PASS | Unverified subject hides the low-balance funding prompt and manual actions; pending/timeout behavior passes in the interactive suite. Low-balance timeout assertion itself remains outstanding: R4-F1. |
| Boundaries | Partial state | PASS | Rejected logout exposes the error, keeps controls usable, and avoids reload; a later success reloads and preserves account snapshot: `perps-onboarding-card-timeout.test.tsx:453-480`. |
| Duplication | Replay | N/A | Restore flow replays no trading events. |
| Duplication | Retries | PASS | Retry repeats with one local reload per click and no logout/account mutation: `perps-onboarding-card-timeout.test.tsx:381-407`. |
| Duplication | Reconciliation | N/A | Restore flow reconciles no orders. |
| Duplication | Competing workers | N/A | Restore flow starts no trading worker. |

### Round-4 Gates

- `bun test apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx` — **PASS**, 70 passed, 0 failed, 170 expectations.
- `RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test --timeout 30000 apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` — **PASS**, 6 passed, 0 failed, 0 skipped, 97 expectations.
- `bun test --timeout 30000` — **PASS**, 5,205 passed, 46 skipped, 0 failed, 15,338 expectations across 326 files. The six opt-in browser tests skipped in this canonical invocation all passed separately above with 0 skipped.
- `bun run check-types` — **PASS**, 11/11 packages (11 cached).
- `bun run lint` — **PASS**, exit 0 with 23 warnings; none in the changed source or test path.
- `git diff --check 10aabc655892d60004fbbb0d80ee0a79f7849290 403cb2aa524fcf1b349afee7014c0f978c56166c` — **PASS**, exit 0.

The Round-4 verdict remains **REJECT** on its candidate. Round 5 independently verifies that its exact correction is present and passing. Live restore proof remains unverified.

## Round 5 Review

**Verdict: STRICT ACCEPT.** The exact Round-4 correction is present in the low-balance browser case. Before and after advancing 20 seconds, it asserts zero clipboard writes, zero wallet-action events, and zero account-mutation events; keeps the account/balance snapshot and pending notice visible; hides the low-balance hint, copy buttons, and direct-funding panel; and keeps `Deposit USDC` disabled. After the advance, the timeout notice and Retry/Reset controls are also visible. The prior precise timing, Retry/Reset, action-gate, mismatch, legacy, local-only, and scope checks pass. No unresolved offline finding remains.

### RST-012-R4-F1 Closure

The low-balance fixture returns 1 USDC (`perps-onboarding-card-timeout.test.tsx:113-117`). In that same mounted case, the test verifies the account snapshot, pending banner, absent funding hint and controls, and zero clipboard/wallet/account actions before the timeout (`:360-373`). It advances the same state by 20 seconds, then reasserts the pending banner, 1-USDC balance, account snapshot, hidden funding hint and controls, zero actions, and disabled deposit while checking the timeout notice and controls (`:375-386`). The named Round-4 omission is closed; no further correction is required.

### Round-5 Numbered Verification

1. **Reconnect, subject gate, timeout, Retry, and Reset: PASS.** The timer covers wallet-not-ready, unauthenticated, unresolved-subject, and unsettled wallet-list states, then clears when waiting ends (`perps-onboarding-card.tsx:667-692`). The timeout notice is rendered in loading and existing-account pending states (`:1008-1013,1295-1301`). Interactive tests verify loading/pending before 19,999 ms, no timeout controls at 19,999 ms, and the notice at 20,000 ms (`perps-onboarding-card-timeout.test.tsx:294-358`); the low-balance pending state separately retains both pending and timeout notices (`:360-386`).
2. **Low-balance funding/copy behavior and account safety: PASS.** The 1-USDC scenario checks the account/master/agent/balance snapshot and pending notice; the low-balance hint, Copy buttons, and direct-funding instructions remain hidden; clipboard, wallet, and tRPC account-mutation event lists remain empty both before and after 20 seconds; deposit remains disabled; external requests remain empty (`perps-onboarding-card-timeout.test.tsx:239-287,360-386`).
3. **Retry, Reset, failure/repeat behavior: PASS.** Retry repeats twice with exactly one local reload per click, no logout/account mutation, and a preserved snapshot (`perps-onboarding-card-timeout.test.tsx:394-420`). Reset repeats twice with logout before local reload and preserves account state (`:422-456`). Rejected logout leaves controls usable and does not reload; a subsequent successful Reset reloads (`:458-493`).
4. **Action gates, mismatch, and legacy behavior: PASS.** The subject/session and selected/stored-master guards remain in place (`perps-onboarding-card.tsx:340-370,395-486,694-722`). Address copy, export, direct funding, deposit, and activation are gated (`:1332-1336,1430-1443,1455-1474,1513-1543,1565-1570`); the pure auto-action test blocks all actions for an unverified subject (`perps-onboarding.test.ts:75-93`). Mismatch reset and legacy recovery behavior remain distinct and covered (`perps-onboarding-card.tsx:315-339,935-981`; `perps-onboarding-card.test.tsx:144-224,338-362`; `perps-card-display.test.ts:162-298`).
5. **Local-only fixture/no live access: PASS.** Browser cases use a synthetic address and mocked wallet, tRPC, activation, and deposit modules; navigation and requests are intercepted at the `.test` fixture origin (`perps-onboarding-card-timeout.test.tsx:5-7,19-129,169-225`). The cases assert no external requests. No live Privy session/account, credentials, keys, production data, funding, or orders were used; live restore proof remains unverified.
6. **Exact diff and write scope: PASS.** Parent-to-candidate diff is exactly `apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` and `apps/web-v2/src/components/perps/perps-onboarding-card.tsx` (+519/-29). The verifier updated only this RST-012 report; RST-011's SHA-256 remains `91618bfbc88c47dd723277c90b16b0d0d4037ef6cf979bc23bbae8c1f1f7ef21`. No source, test, or ledger path was edited by the verifier.
7. **Required gates: PASS.** Fresh outputs are recorded below.

### Round-5 Strict Checklist

| Category | Item | Result | Evidence |
|---|---|---|---|
| Money-loss | Wrong account | PASS | Stored-master binding and mismatch handling remain intact; mismatch recovery is covered (`perps-onboarding-card.tsx:315-367,1303-1317`; `perps-onboarding-card.test.tsx:192-224`). |
| Money-loss | Size | N/A | Restore UI changes no order sizing. |
| Money-loss | Side | N/A | Restore UI selects no order side. |
| Money-loss | Leverage | N/A | Restore UI changes no leverage. |
| Money-loss | Consent | PASS | Unverified sessions cannot copy, export, fund, deposit, or sign; low-balance browser case asserts hidden controls and zero wallet/account actions (`perps-onboarding-card.tsx:348-370,461-486,694-722,1332-1336,1455-1474,1513-1543,1565-1570`; `perps-onboarding-card-timeout.test.tsx:360-386`). |
| Money-loss | Attribution | PASS | Reset invokes Privy logout plus local reload only, with stored master, agent status, and balance preserved (`perps-onboarding-card.tsx:747-766`; `perps-onboarding-card-timeout.test.tsx:422-493`). |
| Parity | Stocks and perps | N/A | No trading execution path changes. |
| Parity | Entry behavior | N/A | Restore flow submits no entry. |
| Parity | Exit behavior | N/A | Restore flow submits no exit. |
| Boundaries | Empty state | PASS | Settled missing-wallet recovery remains available (`perps-onboarding-card.tsx:321-325,1037-1104,1189-1235`; `perps-onboarding-card.test.tsx:144-165,338-362`). |
| Boundaries | Malformed state | PASS | Invalid stored-master state remains recovery-only and exposes no wallet actions (`perps-onboarding-card.tsx:354-370,1016-1036`; `perps-onboarding-card.test.tsx:264-299`). |
| Boundaries | Missing state | PASS | Missing wallet recovery remains intact and covered (`perps-onboarding-card.tsx:1037-1104,1170-1235`; `perps-onboarding-card.test.tsx:144-165,338-362`). |
| Boundaries | Stale state | PASS | Unverified low-balance session keeps account/pending/timeout display while all funding/copy and account actions remain gated (`perps-onboarding-card-timeout.test.tsx:360-386`). |
| Boundaries | Partial state | PASS | Rejected logout surfaces its error, preserves usable controls, and avoids reload; the next success reloads without changing the account snapshot (`perps-onboarding-card-timeout.test.tsx:458-493`). |
| Duplication | Replay | N/A | Restore flow replays no trading events. |
| Duplication | Retries | PASS | Retry repeats with one local reload per click and no wallet logout or account mutation (`perps-onboarding-card-timeout.test.tsx:394-420`). |
| Duplication | Reconciliation | N/A | Restore flow reconciles no orders. |
| Duplication | Competing workers | N/A | Restore flow starts no trading worker. |

### Round-5 Gates

- `bun test apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx` — **PASS**, 70 passed, 0 failed, 170 expectations.
- `RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test --timeout 30000 apps/web-v2/src/components/perps/perps-onboarding-card-timeout.test.tsx` — **PASS**, 6 passed, 0 failed, 0 skipped, 112 expectations.
- `bun test --timeout 30000` — **PASS**, 5,205 passed, 46 skipped, 0 failed, 15,338 expectations across 326 files. The six opt-in browser tests skipped in this canonical invocation all passed separately above with 0 skipped. This canonical run preceded typecheck.
- `bun run check-types` — **PASS**, 11/11 packages (all 11 cached).
- `bun run lint` — **PASS**, exit 0 with 23 warnings; none in the candidate's source or test paths.
- `git diff --check 10aabc655892d60004fbbb0d80ee0a79f7849290 145f7e4a2b59e5f1d1b2da56b702ca36b4ac858d` — **PASS**, exit 0.

Round 5 is **STRICT ACCEPT** for the reviewed offline candidate. Live restore behavior has not been exercised and remains unverified.
