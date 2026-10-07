# Wallet Identity Strict Verification

## Round 2

**Verdict: ACCEPT**

- Ticket: RST-009, RST-010, safe RST-015 identity precondition
- Base SHA: `b543f8e466f22ca56162b0b5d798d1e17ff88579`
- Reviewed-tree SHA: `e0792477f5fb6b1f65d2c60162233c7c95bf0f11`
- Model: GPT-5 (Codex runtime)
- Review: STRICT, limited to F1-F3 and authorized-path verification
- The only additional authorized path is `apps/web-v2/src/lib/perps-private-key.test.ts`.
- No source or test files were edited during this verification; the assigned report is the only worktree file.

### F1 - RESOLVED: Missing or invalid enabled master fails closed

`selectPerpsEmbeddedWallet` now requires a valid preferred address for enabled accounts and returns no wallet for a missing or malformed master. The card presents an identity-unavailable recovery state, omits wallet/funding/export/deposit/activation affordances, and gates copy, deposit, export, activation, and automatic actions on a valid case-insensitive address match. Hook-level balance, funding, and signing methods recheck the binding. Regression tests cover absent and malformed masters with another EVM wallet available.

### F2 - RESOLVED: Conflicting concurrent enable rejects before side effects

The enable mutation re-reads the credential under the per-user transaction lock before ownership verification, agent provisioning, or credential writes, and holds the lock through those side effects. A competing different-master request sees the winner's row and returns the fixed `CONFLICT` error without provisioning or writing. The race test synchronizes both initially empty reads and verifies only the winning request provisions/inserts; the conflict message contains neither address.

### F3 - RESOLVED: Import errors and key-test diagnostics are secret-safe

Privy import failures now map to fixed user-facing copy instead of rendering provider messages. A synthetic-key-bearing provider error is tested against rendered output and captured logs. Full-key normalization comparisons now assert booleans, so assertion diffs cannot contain the fixture.

### Round 2 Scope and Results

- **Authorized paths: PASS.** The commit changes exactly the prior nine reviewed paths plus the authorized private-key test expansion; no generated database distribution path or other path changed:
  - `apps/api/src/__tests__/hyperliquid-enable-upsert.test.ts`
  - `apps/api/src/routers/hyperliquid.ts`
  - `apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx`
  - `apps/web-v2/src/components/perps/perps-onboarding-card.tsx`
  - `apps/web-v2/src/lib/perps-card-display.test.ts`
  - `apps/web-v2/src/lib/perps-card-display.ts`
  - `apps/web-v2/src/lib/perps-private-key.test.ts`
  - `apps/web-v2/src/lib/perps-wallet-selection.test.ts`
  - `apps/web-v2/src/lib/perps-wallet-selection.ts`
  - `apps/web-v2/src/lib/use-perps-wallet.ts`
- Focused group 1: **96 pass, 0 fail**, 227 expectations.
- Focused group 2: **70 pass, 0 fail**, 170 expectations.
- Canonical `bun test --timeout 30000`: **5,197 pass, 40 skip, 0 fail**, 5,237 tests across 324 files.
- `bun run check-types`: **11/11 packages successful**, all cached.
- `bun run lint`: completed with **23 warnings**, none in the reviewed paths.
- `git diff --check b543f8e466f22ca56162b0b5d798d1e17ff88579..HEAD`: clean.
- No live Privy/venue access, real key/account, production data, database mutation, or push was used.

## Round 1 Historical Record (superseded for F1-F3)

**Round 1 verdict: REJECT**

- Ticket: RST-009, RST-010, safe RST-015 identity precondition
- Base SHA: `f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2`
- Reviewed-tree SHA: `b543f8e466f22ca56162b0b5d798d1e17ff88579`
- Model: GPT-5 (Codex runtime)
- Round: 1, STRICT
- Worktree was clean before this report; no source, test, or ledger files were edited.

### Findings (Round 1)

### F1 - P1: An enabled account with no stored master can select and fund another wallet

The status route can return `enabled: true` with `walletAddress: null` when a credential row has neither `accountId` nor `username` (`apps/api/src/routers/hyperliquid.ts:131-148,182-185`). The card passes that absent value as `preferredAddress` (`apps/web-v2/src/components/perps/perps-onboarding-card.tsx:222-225`). The hook then selects without a preference (`apps/web-v2/src/lib/use-perps-wallet.ts:186-190`), and the selector deliberately falls back to an imported or first EVM wallet when the preference is nullish (`apps/web-v2/src/lib/perps-wallet-selection.ts:41-48`).

The card only sets `walletMismatch` when both addresses are truthy (`apps/web-v2/src/components/perps/perps-onboarding-card.tsx:339-344`). With the fallback wallet present, the recovery state is false; funding instructions and the deposit step render (`:1378-1404`), and `handleDeposit` only blocks on that same false mismatch before signing through the selected wallet (`:819-852`). This can direct funds to a wallet other than the account's enrolled master.

**Correction:** Distinguish first-time, disabled setup from an enabled account whose stored master is missing or invalid. For the latter, prohibit wallet fallback and show only recovery/reconnect. Require a valid stored master and case-insensitive selected-address equality before funding copy/copy, deposit, export, or signing actions, including their handlers and automatic paths. Add tests for enabled/null-master plus another EVM candidate, asserting no fallback and no wrong-wallet affordances or action.

### F2 - P2: A concurrent conflicting enable can provision before returning CONFLICT

The initial comparison is a non-serialized read (`apps/api/src/routers/hyperliquid.ts:273-279`). Agent provisioning occurs before the policy transaction and its locked re-read (`:349-352,370-385`). If a different-master request wins after the first read but before the locked re-read, this request provisions an agent and only then throws the controlled conflict (`:381-385,415-418`). It does not rebind the row, but it violates the required conflict-before-provisioning guarantee. The added conflict test covers an already-existing row, not this race (`apps/api/src/__tests__/hyperliquid-enable-upsert.test.ts:132-143`).

**Correction:** Serialize the identity check with the provisioning side effect. Re-read under the per-user lock before provisioning, and reject a different stored master before any Privy provisioning or credential write. Add a competing-request test where the initial read is empty and a different master wins before the serialized check; assert conflict, zero provisioning, zero writes, and no address in the error.

### F3 - P2: Import-provider errors and key-test failures are not guaranteed secret-free

The import path sends the normalized key directly to Privy, with no RST API, storage, database, or logging call in the hook (`apps/web-v2/src/lib/use-perps-wallet.ts:248-256`). However, the component forwards an arbitrary provider `error.message` into `walletError` and renders it (`apps/web-v2/src/components/perps/perps-onboarding-card.tsx:382-400,1061-1062,1216-1218`). No import-failure test proves that a provider error cannot echo the submitted key. The existing private-key tests also compare the entire fixture in assertions (`apps/web-v2/src/lib/perps-private-key.test.ts:8-9,48-58`), so a failing equality assertion can print the synthetic fixture. The focused and canonical passing outputs did not print a key; this is a fail-closed assurance gap, not a claim that a live provider echoed one.

**Correction:** Replace raw import-provider messages with a fixed safe user-facing error. Test a synthetic-key-bearing thrown error and assert the key is absent from rendered errors and captured logs. Rewrite full-key equality assertions so failure output reports booleans or other non-secret metadata, not the key.

### Numbered Checks (Round 1)

1. **FAIL.** A supplied master is a strict selector constraint, but an enabled account with no master passes `undefined` and takes the fallback path. Evidence and correction: F1; `perps-wallet-selection.ts:41-48`, `use-perps-wallet.ts:186-190`, and status contract `hyperliquid.ts:131-148,182-185`.
2. **FAIL.** Export availability and execution require authentication, verified session, and case-insensitive equality (`perps-card-display.ts:58-73`, `use-perps-wallet.ts:283-305`). The broader key-safety requirement is not proven because raw import errors and full-key test assertions can expose their contents; see F3.
3. **FAIL.** Known-address mismatch hides export, funding copy, deposit, and activation affordances (`perps-onboarding-card.tsx:1231-1243,1353-1366,1378-1404,1475-1500`), and loading waits for the wallet list (`:303-307,967-974`; test `perps-onboarding-card.test.tsx:226-250`). Missing stored master is not treated as mismatch/recovery and remains actionable; see F1.
4. **FAIL.** Same-master idempotency and an already-existing different-master conflict are implemented (`hyperliquid.ts:273-305`; test `hyperliquid-enable-upsert.test.ts:120-143`), and persisted master/agent/balance are not updated. The concurrent path can provision before conflict; see F2. The conflict message is constant and contains neither address (`hyperliquid.ts:62-77`).
5. **PASS.** No guessed duplicate-key provider parser or full RST-015 recovery was added. The patch does not alter balance calculations or RST-012 session reset/auth mechanics; the assigned restore group passed. The reviewed diff is confined to the identity write set in `plan-wallet-lifecycle.md:36-50`.
6. **PASS.** I read every hunk of the onboarding component diff. The changed wrapping/formatting corresponds to mismatch gates and recovery copy; I found no unrelated behavior churn, duplicated state, inaccessible new controls, or responsive class changes. The new flags are derived values, and no controls were added.
7. **PASS, with additional gaps recorded in F1-F3.** All four specified RED cases are behavioral: absent preferred wallet (`perps-wallet-selection.test.ts:39-46`), export identity (`perps-card-display.test.ts:49-65`), rendered mismatch affordances (`perps-onboarding-card.test.tsx:192-224`), and API conflict/no provisioning for an already-existing row (`hyperliquid-enable-upsert.test.ts:132-143`). They do not cover the enabled/null-master state or the concurrent different-master race.
8. **Applied individually below.**
9. **PASS.** The commit changes exactly the nine authorized files listed by `git diff-tree --name-status`; none is a secret- or env-like path. No additional tracked changes existed after gates. The report is the sole new worktree file.
10. **PASS.** Both assigned focused groups and all canonical gates ran in the required order and passed. Totals are recorded below.

### STRICT Audit Checklist (Round 1)

| Category / item | Result | Current evidence and rationale |
|---|---|---|
| Money-loss / Wrong account | FAIL | F1: `hyperliquid.ts:131-148,182-185`; `perps-onboarding-card.tsx:339-344,819-852,1378-1404`. |
| Money-loss / Size | PASS | Deposit handler rejects non-finite or below-minimum values (`perps-onboarding-card.tsx:828-831`); input and balance gates remain (`:1425-1446`). Funding-instruction tests passed in `perps-onboarding-card.test.tsx`. |
| Money-loss / Side | N/A | No order-side or position-direction behavior is in the authorized identity write set (`plan-wallet-lifecycle.md:36-50`). |
| Money-loss / Leverage | N/A | No leverage inputs, order policy, or leverage implementation is in the authorized identity write set (`plan-wallet-lifecycle.md:36-50`). |
| Money-loss / Consent | PASS | Deposit remains an explicit user action and checks verified session, amount, and mismatch; activation checks session and mismatch before signing (`perps-onboarding-card.tsx:431-465,819-848`). The missing-master identity failure is recorded under Wrong account and Attribution. |
| Money-loss / Attribution | FAIL | F1: with no stored master, the selected fallback address is not bound to the enabled account (`use-perps-wallet.ts:186-190`; `perps-wallet-selection.ts:41-48`). |
| Parity / Stocks and perps | N/A | No stock/perps execution parity path is changed; scope is the identity-only write set (`plan-wallet-lifecycle.md:36-50`). |
| Parity / Entry behavior | N/A | No order-entry code or order payload is changed (`plan-wallet-lifecycle.md:36-50`). |
| Parity / Exit behavior | N/A | No order-exit code or order payload is changed (`plan-wallet-lifecycle.md:36-50`). |
| Boundaries / Empty state | FAIL | An enabled credential with an empty stored master can fall through to the first/imported EVM wallet; F1. Empty candidate lists do return no selection (`perps-wallet-selection.ts:29-48`), but that does not make the empty stored-master case safe. |
| Boundaries / Malformed state | PASS | A non-null malformed preferred string is still treated as strict and cannot fall back (`perps-wallet-selection.ts:41-45`); new API enable inputs are EVM-address validated (`hyperliquid.ts:263-269`). |
| Boundaries / Missing state | FAIL | Missing stored master is passed as no preference and selects a fallback; F1. |
| Boundaries / Stale state | PASS | When the master exists, selection is strict; linked-account catch-up gates readiness (`use-perps-wallet.ts:192-208`), and mismatch rendering is behavior-tested (`perps-onboarding-card.test.tsx:192-224`). |
| Boundaries / Partial state | FAIL | Enabled/null-master state is actionable (F1); a concurrent different-master row can be found only after provisioning (F2). |
| Duplication / Replay | PASS | Existing same-master calls return without provision or insert (`hyperliquid-enable-upsert.test.ts:120-130`); the agent external ID is reused on retry (`apps/api/src/lib/hyperliquid.ts:231-267`). |
| Duplication / Retries | PASS | Existing same-master retry is idempotent with no new provision/write (`hyperliquid-enable-upsert.test.ts:120-130`). The cross-master race side effect is separately FAIL under Competing workers (F2). |
| Duplication / Reconciliation | N/A | No reconciliation worker or reconciliation state is changed by the identity-only write set (`plan-wallet-lifecycle.md:36-50`). |
| Duplication / Competing workers | FAIL | Concurrent different-master calls can provision before the locked re-read rejects the loser (`hyperliquid.ts:273-279,349-385,415-418`); F2. |

### Commands and Results (Round 1)

1. `bun test apps/web-v2/src/lib/perps-wallet-selection.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-private-key.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx apps/api/src/__tests__/hyperliquid-enable-upsert.test.ts` - 89 pass, 0 fail, 195 expectations.
2. `bun test apps/web-v2/src/lib/perps-onboarding.test.ts apps/web-v2/src/lib/perps-card-display.test.ts apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx` - 66 pass, 0 fail, 148 expectations.
3. `bun test --timeout 30000` - 5,190 pass, 40 skip, 0 fail; 5,230 tests across 324 files. This is baseline 5,184 pass plus six tests added by this commit, with skips unchanged.
4. `bun run check-types` - 11/11 packages successful, all cached; no type errors.
5. `bun run lint` - completed with 23 warnings, matching baseline; no warning points to an authorized changed file.
6. `git diff --check f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2 b543f8e466f22ca56162b0b5d798d1e17ff88579` - clean.

The focused tests and canonical gates were offline; no live Privy/venue access, real key/account, production data, DB mutation, or push was used. The unresolved RST-015 duplicate-key ownership decision and any live export/reconnect proof remain outside this identity slice and are not claimed here.

### Authorized Commit Paths (Round 1)

- `apps/api/src/__tests__/hyperliquid-enable-upsert.test.ts`
- `apps/api/src/routers/hyperliquid.ts`
- `apps/web-v2/src/components/perps/perps-onboarding-card.test.tsx`
- `apps/web-v2/src/components/perps/perps-onboarding-card.tsx`
- `apps/web-v2/src/lib/perps-card-display.test.ts`
- `apps/web-v2/src/lib/perps-card-display.ts`
- `apps/web-v2/src/lib/perps-wallet-selection.test.ts`
- `apps/web-v2/src/lib/perps-wallet-selection.ts`
- `apps/web-v2/src/lib/use-perps-wallet.ts`
