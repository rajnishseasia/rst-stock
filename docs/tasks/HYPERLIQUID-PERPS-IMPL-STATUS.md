# Hyperliquid Perps — Implementation Status

Branch: `feat/hyperliquid-perps`. This document is the implementation receipt for the
Hyperliquid perpetuals feature. It records what was built, the exact commands + env
still required to reach a live/testnet trade, and known gaps.

Status at time of writing: **code-complete and green on typecheck/lint/tests**, but
**not yet exercised against a live or testnet endpoint** — that requires real Privy
credentials, a `db:push`, and a funded testnet wallet (see "Go-live checklist").

---

## What was built (by area)

### `packages/db` — schema
- Added `PERP` to `assetTypeEnum` (`EQUITY | OPTION | PERP`).
- Added **nullable** perp columns to the orders table (existing equity/option paths
  untouched, existing INTEGER `quantity`/`executedQuantity` unchanged):
  - `quantityDecimal` `decimal(24,8)` — perp sizes are DECIMAL and MUST write here, never the INTEGER `quantity`.
  - `leverage` `integer`
  - `marginMode` `text` (`cross | isolated`)
  - `reduceOnly` `boolean default false`
  - `fundingPaid` `decimal`
  - `venue` `text default 'alpaca'` (`alpaca | hyperliquid`)
- Migration is **edit-only** in this branch. The columns/enum still need to be applied
  to a real DB via `db:push` before any perp insert works.

### `packages/hyperliquid` — new workspace (`@trade-bot/hyperliquid`)
Mirrors `@trade-bot/alpaca`. Wraps `@nktkas/hyperliquid` + `@privy-io/node`.
- `client.ts` — InfoClient/ExchangeClient wrapper: rounding via SDK formatSize/formatPrice,
  leverage clamp, deterministic cloid from `clientOrderId`, builder-code attachment on
  every order, market-order IoC synthesis (aggressive limit), reduce-only marketClose
  side inversion, cancel/updateLeverage payloads, keyless `userFills()`/`openOrders()`
  read methods, clearinghouse -> `PerpPosition` mapping.
- `config.ts` — `builderCodeFromEnv`, `networkFromEnv`.
- `privy.ts` — `authorizationContextFromKey`, `buildWithdrawalDenyPolicy` (DENY on
  `eth_signTypedData_v4` for `HyperliquidTransaction:Withdraw`).
- Client is intentionally NOT bound to Privy: it accepts an injected viem
  `AbstractWallet`. The API factory wires Privy.
- Tests: real-module unit tests (`bun test`, 29 pass).

### `apps/api`
- `lib/credentials.ts` — `CredentialProvider` widened to `alpaca | hyperliquid`.
  For `hyperliquid`: `accessToken`=Privy master walletId (encrypted),
  `refreshToken`=Privy agent walletId (encrypted), `accountId`+`username`=master 0x
  address, `baseUrl`=agent 0x address (reuses existing `DecryptedCredentials`, no table change).
- `lib/hyperliquid.ts` — factory that wires Privy `createViemAccount` (master+agent) +
  `authorizationContext` and injects the account as the client `wallet`. Also exposes a
  keyless `createHyperliquidInfoClient`.
- `lib/perp-orders.ts` — pure, tested mapping: schema validation (decimal-size guard,
  Limit/postOnly rules), `toPlacePerpOrderRequest` (long/short, string size, cloid reuse),
  `toPerpOrderRow` (writes `quantityDecimal` + `quantity=0` placeholder, `venue=hyperliquid`,
  `assetType=PERP`), clearinghouse -> row.
- `lib/hyperliquid-order-sync.ts` — pure `reconcilePerpOrder`/`orderCloid`/`vwap`/
  `sumDecimals`/`isMeaningfulUpdate` (shared with the worker).
- `routers/hyperliquid.ts` — `status`/`enable`/`meta`/`candleSnapshot`/`allMids`.
  `enable` provisions master+agent Privy wallets + the DENY-Withdraw policy and persists
  refs.
- `routers/orders.ts` — sibling perp procedures `submitPerp`/`setLeverage`/`cancelPerp`
  (equity `orders.submit` untouched).
- `routers/positions.ts` — sibling `listPerps`.
- Tests: `perp-orders.test.ts` (16) + `hyperliquid-order-sync.test.ts` (15), real modules.
- `tsconfig.json` `moduleResolution` switched `node` -> `bundler` so tsc resolves the
  SDK exports-map subpaths; whole existing api still typechecks 0 errors.

### `apps/worker`
- `services/hyperliquid-order-sync.ts` — `HyperliquidOrderSyncPoller`, **inert behind
  `HYPERLIQUID_SYNC_ENABLED`**, read-only reconcile of open perp orders from HL
  `userFills`/`openOrders` into the orders table via the shared package + keyless
  info client. No ExchangeClient/placeOrder/cancel/close/withdraw/Privy signing.
  Registered alongside `CopyMirrorPoller` in `index.ts` (inert by default).
- Perp writes go to DECIMAL columns (`quantityDecimal`/`executedPrice`/`fundingPaid`),
  never INTEGER `quantity`/`executedQuantity`.

### `apps/web-v2`
- UI primitives: `ui/dialog.tsx` (radix), `ui/slider.tsx` (radix, charcoal+gold tokens),
  `ui/binary-toggle.tsx` (extracted).
- Venue plumbing: `lib/venue-storage.ts`, `lib/venue-context.tsx`,
  `components/terminal/venue-switch.tsx`.
- Perps surface: `components/perps/*` (overlay + terminal + symbol universe),
  `components/trade/perp-trade-form.tsx` (RHF+Zod, BinaryToggle direction/margin/order-type,
  Slider+preset chips clamped to `maxLeverage`, dual coin<->USD size synced via mark,
  reduce/post-only, `submitPerp` with client cloid, AlertDialog review gate at
  leverage>=10x or notional>=$10k), `components/trade/perp-positions-panel.tsx`
  (`positions.listPerps` 30s poll; reduce-only market Close), `components/trade/perp-form-math.ts`
  (pure, tested).
- Chart datafeed HL branch: `charts/tv-datafeed.ts` + `charts/advanced-chart.tsx`
  (candleSnapshot bars, allMids ticks, 24x7/Etc-UTC/decimals-pricescale). Alpaca path unchanged.
- Settings: `settings/page.tsx` `PerpsSettingsCard` (Enable Perps -> `hyperliquid.enable`,
  deposit address + HL balance + fund flow + network badge; polls `hyperliquid.status`).
- Tests: `perp-form-math.test.ts` (21) + `venue-storage.test.ts` (7), real modules.

---

## Verification (whole repo, this branch)

Typecheck — **all pass**:
```
bun --cwd packages/db run check-types        # tsc -b, exit 0
bun --cwd packages/hyperliquid run typecheck  # exit 0
bun --cwd apps/api run typecheck              # exit 0
bun --cwd apps/worker run typecheck           # exit 0
bun --cwd apps/web-v2 run typecheck           # exit 0
```

Lint — **pass**: `bun run lint` (oxlint) — 0 errors, 83 warnings (all pre-existing).

Tests — **all perp tests pass**:
```
bun --cwd packages/hyperliquid test           # 29 pass / 0 fail
bun test apps/api                             # perp: perp-orders 16 + order-sync 15 all pass
bun --cwd apps/web-v2 test src/components/trade/perp-form-math.test.ts src/lib/venue-storage.test.ts  # 28 pass
```

Pre-existing failures (verified identical on the base with perps changes stashed — NOT
regressions, NOT touched by this work):
- `apps/api`: `copy-trade.test.ts > mapUserTradeToItem > maps a buy trade and prefixes the id` (1).
  Also 2 cwd-dependent migration tests that read `packages/db/migrations`; they PASS when
  the api suite is run from the repo root and only fail if run with cwd=`apps/api`.
- `apps/web-v2` (7): `smart-exit computeTrailPercent` MIN clamp, plus readFileSync+regex
  source-assertion tests (`page-layout`, `ticker-chart-navigation`, `copy-trade-panel`,
  `copy-trade-follow`). All are the brittle source-assertion style flagged in CLAUDE.md
  and belong to earlier feature work, not perps.

---

## Go-live checklist (exact steps to a working testnet trade)

All of the following require secrets/live services and were NOT run in this branch.
Reference env vars by NAME only — never commit real values.

1. **Privy dashboard** — create the app and server keys, then set in the root `.env`
   (NOT `.env.example`):
   - `PRIVY_APP_ID`
   - `PRIVY_APP_SECRET`
   - `PRIVY_AUTHORIZATION_KEY` (wallet-API authorization signing key)
   - `HL_BUILDER_ADDRESS` (your builder-code address)
   - `HL_BUILDER_FEE_BPS` (builder fee, basis points)
   - `HYPERLIQUID_NETWORK=testnet` (for validation; `mainnet` for prod)
   All are already documented in `apps/api/.env.example` and `apps/worker/.env.example`.

2. **Install workspace links** (so `@trade-bot/hyperliquid` symlink is materialized for
   the running worker/api, not just tsc `paths`):
   ```
   bun install
   ```

3. **Apply the DB schema** to the target Postgres (the perp enum + nullable columns):
   ```
   bun run db:push        # runs drizzle-kit push against DATABASE_URL_DIRECT
   ```
   Note: `db:generate` is reported broken in this repo; `db:push` is the path used.
   This is an operator/PR-checklist item — a `submitPerp` insert fails until it runs.

4. **Enable perps for a user** (web UI Settings -> Enable Perps, or call
   `hyperliquid.enable`). This provisions master+agent Privy wallets and attaches the
   DENY-Withdraw policy, and persists the wallet refs to the credential row.

5. **Fund the master wallet** — deposit USDC to the displayed Hyperliquid deposit address
   (testnet faucet for testnet). Poll `hyperliquid.status` until it shows a funded balance.

6. **One-time master-signed HL setup** — see gap (G1) below: `registerAgent` (link the
   agent wallet) and `approveBuilderFee` are NOT yet called by `enable`. Until an operator
   or a follow-up mutation runs these master-signed calls, agent-signed orders are rejected
   by Hyperliquid.

7. **Manual testnet trade validation** (`HYPERLIQUID_NETWORK=testnet`):
   - `setLeverage` on a coin, place a **market long**, confirm `PerpPositionsPanel`
     (`positions.listPerps`) shows mark / liq / funding.
   - Flip `HYPERLIQUID_SYNC_ENABLED=true` on the worker and confirm the poller transitions
     rows `SUBMITTED -> FILLED/PARTIAL` and `CANCELLED` with correct executed size/price/funding.
   - Place a **limit** order and `cancelPerp` it.
   - Do a **reduce-only Close**.
   - Attempt a withdrawal and confirm it is **DENIED** by the Privy withdrawal policy.

---

## Known gaps / TODOs

- **(G1) One-time master-signed HL setup not wired.** `registerAgent` (agent linking) and
  `approveBuilderFee` (`maxFeeRate` as a `"${n}%"` string) are intentionally NOT called by
  `hyperliquid.enable` — they need funded master creds and belong in a follow-up within
  `enable` or a separate mutation, validated on testnet. Orders WILL be rejected until done.
- **(G2) Privy SDK shape drift from Appendix A.** Installed `@privy-io/node@0.24.0` uses
  `privy.wallets().create(...)` (not `createWallet`) and supports `policy_ids` at
  create-time (used here). `buildWithdrawalDenyPolicy` returns a locally-defined param type
  because Privy does not re-export `PolicyCreateParams` from the package root; it is
  structurally checked at the `privy.policies().create()` call site. Confirm the
  create-time policy attachment satisfies the enclave requirement, or switch to an
  update()-based attach.
- **(G3) Packaging defect in `@trade-bot/hyperliquid`.** No `rootDir` pin -> it builds to
  nested `dist/hyperliquid/src/*` and `dist/utils/src/*`, so `package.json` main/types
  (`./dist/index.js|.d.ts`) do not resolve to the emitted files. Consumers currently
  typecheck via tsconfig `paths` -> `src`. A runtime/build consumer relying on dist
  resolution would break. Fix `rootDir`/`exports` before any dist-based consumption.
- **(G4) SDK major versions.** `@nktkas/hyperliquid@0.33.1`, `viem@2.54.6`,
  `@privy-io/node@0.24.0` resolved higher than the original pins. Confirm acceptable.
- **(G5) tradeAction mapping.** Perp long/short map onto the existing `Buy/Sell`
  `tradeAction` enum (no perp-native member); `venue='hyperliquid'` disambiguates. Revisit
  if downstream branches on `tradeAction` assuming equity semantics.
- **(G6) fundingPaid semantics.** The order-sync reconciler currently maps `fill.closedPnl`
  into `fundingPaid` as a summed realized-pnl proxy; validate against a real testnet fill
  whether a dedicated funding field is preferred.
- **(G7) submitPerp leverage UX.** `submitPerp` calls `updateLeverage` before each order and
  swallows failures (leverage may already be set). Confirm this vs. a hard failure.
- **(G8) Balance source.** `hlBalanceUsd` uses `marginSummary.accountValue` (full equity);
  switch to `state.withdrawable` if the funding UI should show free USDC.
- **(G9) Deposit copy.** `PerpsSettingsCard` says "USDC (Arbitrum)"; confirm the exact
  bridge/network instructions with the HL deposit flow before mainnet.
- **(G10) Perp chart tick cadence.** `subscribeBars` polls `allMids` on the shared 30s
  stock-datafeed timer; add a perps-specific interval if tighter updates are wanted.
- **(G11) PerpSymbolUniverse is minimal** (coin + maxLeverage); live mids/funding/favorites
  were deferred.

## Fixes applied (Fable-5 review) — 2026-07-06

All 11 findings addressed. Typecheck clean across packages/db, packages/hyperliquid, apps/api, apps/worker, apps/web-v2; perp tests pass (hyperliquid 41, api perp 33, web perp/venue 50); lint 0 errors.

| # | Finding | Fix | Where |
|---|---|---|---|
| 1 | enable never linked the agent | enable now calls master-signed `approveAgent` (+ `approveBuilderFee` only when a builder is configured) before persisting creds | `apps/api/src/lib/hyperliquid.ts`, `routers/hyperliquid.ts` |
| 2 | builder code mandatory | builder attached conditionally; factory + placeOrder no longer throw when `HL_BUILDER_ADDRESS` unset | `packages/hyperliquid/src/client.ts`, `apps/api/src/lib/hyperliquid.ts` |
| 3 | retry double-fill | removed `withRetry` from all state-changing calls (order/cancel/updateLeverage/approveAgent/approveBuilderFee/marketClose); reads keep retry | `packages/hyperliquid/src/client.ts` |
| 4 | policy could block all signing | Privy is deny-by-default (confirmed); added explicit ALLOW for `eth_signTypedData_v4` signing | `packages/hyperliquid/src/privy.ts` |
| 5 | withdraw-DENY too narrow | added DENY for Withdraw + UsdSend + SpotSend + UsdClassTransfer + SendAsset | `packages/hyperliquid/src/privy.ts` |
| 6 | cloid regenerated per click | cloid generated once per order/close intent, reused across retries; idempotency hit no longer reports a REJECTED order as success | `perp-trade-form.tsx`, `perp-positions-panel.tsx`, `apps/api/src/routers/orders.ts` |
| 7 | leverage-mismatch swallowed | submitPerp fails hard when `updateLeverage` errors (isolated + cross) | `apps/api/src/routers/orders.ts` |
| 8 | reconciler clobbered requested size | new nullable `executedSizeDecimal` column; reconciler writes executed size there and leaves `quantityDecimal` (requested) intact | `packages/db/src/schema/orders.ts`, `apps/api/src/lib/hyperliquid-order-sync.ts`, `apps/worker/src/services/hyperliquid-order-sync.ts` |
| 9 | false-CANCEL on transient response | CANCELLED only when the account snapshot is non-empty AND the order is older than a 45s min-age guard | `apps/api/src/lib/hyperliquid-order-sync.ts` |
| 10 | close failed without mark price | `placeOrder` (and `marketClose`) now source a fresh mid via `allMids` when no mark/limit price is supplied | `packages/hyperliquid/src/client.ts`; client omits markPrice when null |
| 11 | env admitted testnet silently | mainnet hard default; testnet requires explicit `HYPERLIQUID_ALLOW_TESTNET=true`, else warns + falls back to mainnet | `packages/hyperliquid/src/config.ts` |

### Remaining manual steps to a first mainnet trade
1. Apply the new perp columns to the DB: `bun run db:push` against `DATABASE_URL_DIRECT` (adds quantityDecimal, executedSizeDecimal, leverage, marginMode, reduceOnly, fundingPaid, venue + PERP enum).
2. Finish local `.env` (DATABASE_URL / DATABASE_URL_DIRECT, REDIS_URL, ENCRYPTION_KEY, better-auth, Alpaca master vars). Privy vars are already set.
3. **Verify the Privy DENY policy blocks a withdrawal attempt BEFORE funding beyond a few dollars** — the money-safety gate.
4. Smoke: enable → fund a few $ → minimal-size order → confirm position (mark/liq/funding) → reduce-only close. Keep `HYPERLIQUID_SYNC_ENABLED=false` and `NEXT_PUBLIC_PERPS_ENABLED` off until this passes.

### Residual notes
- The policy uses a broad ALLOW on `eth_signTypedData_v4` + explicit DENYs (relies on Privy's DENY-precedence). A NEW HL fund-exit action type added in future would be ALLOWed until a matching DENY is added — smoke-test both an order (signs) and a withdraw (denied).
- `apps/api/src/lib/hyperliquid.ts` still calls the back-compat `buildWithdrawalDenyPolicy` alias (works); can migrate to `buildHyperliquidPolicy` later.

## Second Fable-5 pass fixes (A–D) — 2026-07-06

All new issues from the re-review addressed. Typecheck clean (api/worker/web-v2); tests pass (hyperliquid 41, api perp 33, web 43); lint 0 errors.

- **A (enable deadlock) — FIXED.** `hyperliquid.enable` is now two-phase: it provisions + persists the wallets as `accountType="PENDING"` and returns the deposit address immediately, WITHOUT `approveAgent`. The master-signed `approveAgent` runs lazily on the first order/leverage call via `ensureHyperliquidAgentRegistered` (`apps/api/src/lib/hyperliquid.ts`), by which point the master is funded; flips `accountType` to `"LIVE"`. `submitPerp` + `setLeverage` call it first (no-op once registered). `status`/`enable` now return `agentReady`.
- **B (wallet sprawl / wrong-master) — FIXED.** `provisionHyperliquidWallets` now looks up existing wallets by `external_id` (`privy.wallets().list({ external_id })`) and REUSES them; a policy is only created when a wallet is actually new. Retried enable can't mint duplicate masters.
- **C (green toast on rejection) — FIXED.** Both `perp-trade-form.tsx` and `perp-positions-panel.tsx` `onSuccess` now check `data.success`; a `success:false` (REJECTED-idempotency) response shows an error toast and drops the stale cloid instead of a success toast.
- **D (stranded PENDING) — FIXED.** The worker sweep now includes `PENDING` (`apps/worker/src/services/hyperliquid-order-sync.ts`); the reconciler's min-age + non-empty-snapshot guards protect a fresh mid-submit PENDING from a false cancel.
- **E (executedPrice precision) — deferred (INFO).** `executedPrice` stays `decimal(12,4)`; revisit if trading sub-$0.0001 assets.

### First-mainnet-trade path (updated for two-phase enable)
1. `db:push` the perp columns (now incl. `executedSizeDecimal`).
2. Finish local `.env`.
3. Enable Perps → shows deposit address (no agent call yet). Fund the master with a few $ USDC.
4. **Verify the DENY policy blocks a withdrawal attempt** before funding more.
5. Place a minimal order — this triggers `approveAgent` (agent→LIVE) then the order. Confirm position → reduce-only close. Keep worker + feature flag off until it passes.

## Embedded-wallet migration — 2026-07-06

Switched the perps wallet layer to **Privy embedded wallets** (embedded master + kept server agent). Typecheck clean (all 5 workspaces); tests pass (hyperliquid 45, api 33, web 50); lint 0 errors.

**Frontend**
- `@privy-io/react-auth` v3 installed. `PrivyProvider` mounted in `components/providers.tsx` (outermost; passthrough when `NEXT_PUBLIC_PRIVY_APP_ID` is absent so CI still builds). Config is v3 shape: `embeddedWallets.ethereum.createOnLogin='users-without-wallets'`, `loginMethods:['email']`, `showWalletUIs:false`. **No app-wide forced login** — Privy login is triggered only in the perps flow.
- `lib/use-perps-wallet.ts` — hook: `login/logout`, embedded `address`, `getWalletClient()` (viem WalletClient on Arbitrum from the embedded EIP-1193 provider), `fundWallet`, `exportWallet`.
- `lib/hyperliquid-activate.ts` — client-side one-time activation: embedded wallet signs `approveAgent` (+ `approveBuilderFee` when configured) against HL, then calls `markAgentRegistered`.
- Settings card reworked: Connect → view address + balance → **Fund** → **Export key** → **Activate** → trade.

**Backend**
- Master = the user's **embedded wallet address** (no server master wallet). `HyperliquidWalletRefs.master` narrowed to `{ address }`.
- `provisionHyperliquidAgentWallet` provisions **only the agent** server wallet (idempotent); withdraw-DENY policy is on the **agent only** (the master is self-custody — user can fund/export/withdraw).
- `enable({ masterAddress })` provisions the agent + persists (master addr + agent refs, `PENDING`); returns `agentAddress` + `builderConfigured`/`builderAddress`/`builderMaxFeeRate` for the client to sign with. `markAgentRegistered` flips to `LIVE`.
- Removed the server-side master-signed `registerHyperliquidAgent`/`ensureHyperliquidAgentRegistered`. `orders.submitPerp`/`setLeverage` now call `assertHyperliquidAgentReady` (refuse if still `PENDING`).
- Orders remain **agent-signed server-side** (popup-free) — reused unchanged.

**New onboarding flow:** Better Auth login → open Perps → Connect Perps Wallet (Privy email) → embedded wallet → fund it → **Activate** (one signature) → trade (no popups).

**Remaining to first mainnet trade:** `db:push`; verify the **agent** policy blocks a withdrawal; minimal-size order → close. (Master withdrawals are intentionally allowed — it's the user's self-custody wallet.)

## Deposit + NEW-1/NEW-3 fixes — 2026-07-06

Closed the funding gap (embedded wallet → HL) and two safety gaps found in the embedded-wallet migration. Typecheck clean (all 5 workspaces, `tsErrors=0`); perp tests pass (hyperliquid 50, api 33, web deposit+perp-math+venue 36); lint 0 errors / 83 pre-existing warnings.

**What changed**

- **On-chain agent verification (fixes the A/B mismatch + blind flip).** `hyperliquid.markAgentRegistered` now reads HL `extraAgents(master)` and only flips `PENDING → LIVE` when the stored agent is actually among the master's approved agents — case-insensitive. If the user activated with a different embedded wallet (B) than they enabled with (A), `extraAgents(A)` won't contain the agent and LIVE never flips; an HL read failure throws `INTERNAL_SERVER_ERROR` (no blind flip). New read wrapper `HyperliquidClient.extraAgents(address)` (keyless InfoClient, retry on reads) + `ExtraAgent` type + pure exported `isAgentApproved(agents, agentAddress)`.
  - `apps/api/src/routers/hyperliquid.ts:217` (markAgentRegistered), `apps/api/src/routers/hyperliquid.ts:251` (extraAgents read), `:264` (reject on not-approved).
  - `packages/hyperliquid/src/client.ts:68` (isAgentApproved), `:251` (extraAgents wrapper); `packages/hyperliquid/src/types.ts:135` (ExtraAgent). Test: `packages/hyperliquid/src/client.test.ts`.

- **DEPOSIT — native-USDC → HL Bridge2 (Arbitrum mainnet).** New `apps/web-v2/src/lib/hyperliquid-deposit.ts` exports the fund-critical constants **VERBATIM**: `HL_BRIDGE_ARBITRUM = 0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` (`:43`), `USDC_ARBITRUM = 0xaf88d065e77c8cc2239327c5edb3a432268e5831` (native USDC, **not** USDC.e; `:50`), `HL_MIN_DEPOSIT_USDC = 5` (`:53`). `depositUsdcToHyperliquid` validates `amount >= min` (finite, positive), reads `balanceOf` and reverts early on insufficient funds, then a plain `USDC.transfer(bridge, parseUnits(amt, 6))` (no retry — a blind resubmit could double-deposit). `readPerpsWalletBalances` returns USDC + ETH (human + raw) so the UI can gate the button and warn on zero ETH gas. Colocated test `hyperliquid-deposit.test.ts` locks the exact lowercase literals (and asserts USDC ≠ USDC.e), plus validation / early-revert / transfer-shaping / balance-read using REAL viem `erc20Abi` + `parseUnits`.

- **defaultChain = Arbitrum.** `PrivyProvider` config sets `defaultChain: arbitrum` + `supportedChains: [arbitrum]` (`apps/web-v2/src/components/providers.tsx:37`) so the embedded wallet is on the right chain for the bridge deposit and the `approveAgent` EIP-712 signature without a per-call chain switch.

- **NEW-3 — env-gate so a missing `NEXT_PUBLIC_PRIVY_APP_ID` can't crash `/settings`.** `apps/web-v2/src/lib/perps-config.ts:15` exports `PERPS_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID`. `PerpsSettingsCard` is a gate wrapper that renders a "Perps unavailable — not configured" placeholder and NEVER mounts the `usePerpsWallet`-calling `PerpsSettingsCardInner` unless enabled (`settings/page.tsx:572`). `providers.tsx:23` passes children through un-wrapped when the app ID is absent, so no Privy-hook component can mount without a provider. `VenueSwitch` returns null (`venue-switch.tsx:24`) and `PerpsOverlay` forces `open=false` (`perps-overlay.tsx:39`) when disabled — covers a stale persisted `venue=perps`.

- **NEW-1 — wallet-match guard blocks activate on mismatch.** `handleActivate` blocks BEFORE signing when `walletAddress(storedMaster).toLowerCase() !== embeddedAddress.toLowerCase()` with an actionable message (`settings/page.tsx:694`); `handleDeposit` re-asserts the same guard (`:820`). A persistent destructive banner renders whenever `walletMismatch` (`:658`, `:899`), and the address field now always reflects the live connected `embeddedAddress`.

**Funding flow (end to end):** Better Auth login → open Perps → Connect Perps Wallet (Privy email → embedded wallet, pinned to Arbitrum) → **Fund** (Privy onramp / export key) → **Deposit** (native USDC → HL Bridge2, min 5 USDC, gated on USDC + ETH-for-gas; polls `hyperliquid.status` until `hlBalanceUsd` rises) → **Activate** (one embedded-wallet signature: `approveAgent`, verified server-side via `extraAgents`, flips LIVE) → **Trade** (orders agent-signed server-side, popup-free).

**Remaining / open:**
- Privy **onramp (fund) config** still needs dashboard setup before the Fund button reaches a real onramp.
- **Arbitrum gas UX for deposits** — a fresh embedded wallet has native USDC but zero ETH; the transfer can't broadcast without gas. The UI warns (amber "you need a little ETH on Arbitrum for gas" when `walletEth === 0`) but there is no in-app ETH-for-gas acquisition path — the user must fund gas out-of-band. Worth a dedicated gas top-up flow.
- Deposit balance reads + the post-deposit status poll are best-effort (try/catch); a persistently failing Arbitrum RPC just leaves the deposit button gated with no explicit RPC-error surface.
- Minimal-size **mainnet trade** still pending live validation (funded embedded wallet + `db:push`), per the go-live checklist.

## Live local testing (2026-07-07)

Ran the full non-money flow against a local stack (Docker Postgres/Redis, `db:push`, mainnet HL market data, real Privy dev app). Validated end-to-end: dev login → terminal → Perps overlay (live HL universe + BTC-PERP chart) → Connect Perps Wallet (Privy email OTP → embedded wallet) → Enable Perps (agent provisioned) → wallet UI (address / balance / Export / Deposit / Activate) → Export key modal → Fund guidance.

**Bugs caught live + fixed (missed by unit tests + 2 Fable reviews):**
1. **Privy policy format** — `Enable Perps` was rejected by the Privy API (`invalid_policy_format`): policy/rule names ≥50 chars, and the broad ALLOW rule had empty conditions (Privy requires ≥1 condition per `eth_signTypedData_v4` rule). Fixed in `packages/hyperliquid/src/privy.ts`: the ALLOW now matches HL's L1 `Agent` phantom typed data (`primary_type: "Agent"`, `field: "source"`, `value: ["a","b"]`) and names are shortened. Enable now returns 200.
2. **Fund Wallet button** — Privy card on-ramp isn't enabled for the app (`useFundWallet` → "Wallet funding is not enabled"). Changed `Fund Wallet` in the settings card to copy the wallet address + show "send native USDC on Arbitrum + a little ETH for gas" guidance (direct-transfer funding; no on-ramp dependency).

**Decisions:**
- **Deposit gas: user brings ETH (v1).** The USDC→bridge deposit is signed/paid by the embedded wallet, so it needs a little Arbitrum ETH. UI guides this. Gas sponsorship (Privy smart wallets + paymaster) deferred as the seamless-UX upgrade.

**Local-only (NOT for commit):** dev email/password login (`better-auth.ts` gated to `NODE_ENV==='development'`) + `apps/web-v2/src/app/dev-login/` + local `.env`s. Production auth stays Google-only. These are intentionally unstaged.

**Still to do (needs real funds):** send USDC (native, Arbitrum) + ETH → Deposit → Activate (approveAgent, verified via extraAgents) → minimal mainnet order → close.

## Known follow-ups (deferred)

- **Cross-venue perp-position awareness.** Perp positions render only inside the Perps overlay; the Stocks page shows no indication of open perps. Liquidation-awareness gap. Proposed fix (deferred): a persistent badge on the header `Perps` toggle showing open-perp count + unrealized PnL, red/warning near liquidation, click-to-open. (Exit-from-perps already works via the overlay's "Exit Perps" control / Esc.)
- Gas sponsorship (Privy smart wallets + paymaster) for deposits — deferred; v1 is user-brings-ETH.
- Privy card on-ramp not enabled — "Fund Wallet" uses direct-transfer guidance instead.

## UX additions (2026-07-07, live-tested)

- **Perps overlay nav** — the full-bleed overlay was a dead-end (Exit only). Added a **Settings gear** (→ /settings) + the **account menu** (UserMenu) to the overlay header alongside Exit Perps. (`components/perps/perps-overlay.tsx`)
- **Bring your own wallet (import private key)** — `usePerpsWallet` now exposes `createWallet()` + `importWallet(privateKey)` (Privy `useCreateWallet` / `useImportWallet`). `createOnLogin` set to **off** so after the Privy email login the settings card presents an explicit **Create new wallet** / **Import existing wallet** chooser (import = paste a hex key → sealed in Privy's enclave, never sent to our server; keeps popup-free signing + export). Live-tested: an imported throwaway key produced a wallet whose address matches the key, and the NEW-1 wrong-wallet guard fired correctly when the connected wallet ≠ the enrolled master. (`use-perps-wallet.ts`, `providers.tsx`, `settings/page.tsx`)

## Trigger orders (stop / TP) — 2026-07-07

Added the full HL order set (StopMarket / StopLimit / TakeProfitMarket / TakeProfitLimit) on top of the existing Market / Limit, plus reduce-only TP/SL on open positions. HL expresses stops/take-profits as TRIGGER orders (`t: { trigger: { isMarket, triggerPx, tpsl } }`). Feature-complete; typecheck + perp tests + lint green (see verification below). No new DB column (trigger price reuses the existing `priceTrigger`), but the `order_type` enum gained two members — a `db:push` is required before a `TakeProfit*` perp insert works.

**Order-type → HL payload mapping** (`packages/hyperliquid/src/client.ts:315` `placeOrder`, dispatched via `triggerSpecForOrderType` in `types.ts:53`):

| UI / server order type | HL `t` field | limit price `p` |
|---|---|---|
| Market | `{ limit: { tif: "Ioc" } }` | aggressive from mark (buy up / sell down) |
| Limit | `{ limit: { tif: "Gtc" } }` (or `"Alo"` post-only) | user limit price |
| StopMarket | `{ trigger: { isMarket: true,  triggerPx, tpsl: "sl" } }` | aggressive from `triggerPx` |
| StopLimit | `{ trigger: { isMarket: false, triggerPx, tpsl: "sl" } }` | user limit price |
| TakeProfitMarket | `{ trigger: { isMarket: true,  triggerPx, tpsl: "tp" } }` | aggressive from `triggerPx` |
| TakeProfitLimit | `{ trigger: { isMarket: false, triggerPx, tpsl: "tp" } }` | user limit price |

`triggerPx` is rounded via the SDK `formatPrice(_, szDecimals)` (same util as Market/Limit); size via `formatSize`. For the `isMarket` triggers `p = aggressivePrice(triggerPx, side, ...)`; `triggerPx` is REQUIRED for all four trigger types (throws otherwise), `limitPrice` REQUIRED for the two `*Limit` triggers. cloid + builder-conditional + NO-retry all inherited unchanged from the Market/Limit path.

**Reduce-only TP/SL on an open position** (`buildTpSlLegs` + `client.setPositionTpSl`, `client.ts:531`/`:470`): places one trigger leg per side on the OPPOSITE side of the position, `r: true` (reduce-only, never flips/increases), full or partial size. SL = tpsl "sl" (StopMarket/StopLimit), TP = tpsl "tp" (TakeProfitMarket/TakeProfitLimit); per-leg cloid `${seed}:sl` / `${seed}:tp`; SL placed before TP. Defaults `isMarket: true`.

**Backend wiring:**
- `perp-orders.ts` — `perpOrderSubmitSchema` orderType enum extended to all 6; `triggerPx` (positive-decimal string) added, with refinements (limitPrice required for Limit/StopLimit/TakeProfitLimit; triggerPx required for all 4 trigger types). `toPlacePerpOrderRequest` passes `triggerPx` through; `toPerpOrderRow` persists it into the existing `priceTrigger` column.
- `orders.ts` — `submitPerp` routes the trigger types through unchanged (via the shared mappers). NEW `orders.setPerpTpSl` mutation (coin + positionSide/size + optional stopLossPx/takeProfitPx, `isMarket` default true, cloid) — gated on `assertHyperliquidAgentReady`, agent-signed, calls `client.setPositionTpSl`.
- `packages/db/src/schema/orders.ts` — `order_type` enum gained `TakeProfitMarket`/`TakeProfitLimit` (StopMarket/StopLimit already present). **Edit-only in this branch** — needs `db:push`.

**Frontend wiring:**
- `perp-form-math.ts` (pure, browser-safe) — `PerpUiOrderType` (5 UI options) + `PerpOrderTypeValue` (6 server types); `resolvePerpOrderType(ui, hasLimitPrice)` is the load-bearing mapper (Take Profit → TakeProfitLimit when a limit price is entered, else TakeProfitMarket; the other four map 1:1). Unit-tested against the real module.
- `perp-trade-form.tsx` — order-type selector exposes **Market / Limit / Stop Market / Stop Limit / Take Profit** (radiogroup); required Trigger Price input for all trigger types; Limit Price input required for Limit/StopLimit, OPTIONAL for Take Profit (its presence upgrades to TP-Limit). `executeSubmit` resolves the UI selection, sends `triggerPx`, sends `limitPrice` only when the resolved type uses one, forces `postOnly=false` for non-Limit, and folds orderType + triggerPx into the cloid signature. Review modal shows the resolved friendly type label + trigger/limit rows.
- `perp-positions-panel.tsx` — per-position **TP/SL** control (Shield button toggles an editor row with Stop Loss + Take Profit inputs → `trpc.orders.setPerpTpSl` with `isMarket: true`, own cloid-per-intent). Reduce-only market **Close** preserved.

**Verify (this pass, 2026-07-07):**
- Typecheck — all 5 workspaces exit 0: `packages/db` `check-types`, `packages/hyperliquid` `typecheck`, `apps/api` `typecheck`, `apps/worker` `typecheck`, `apps/web-v2` `typecheck`.
- Perp tests (real modules; no network) — `packages/hyperliquid` `bun test` 63 pass / 0 fail; `apps/api` perp-orders + hyperliquid-order-sync 40 pass / 0 fail; `apps/web-v2` perp-form-math + venue-storage 38 pass / 0 fail.
- Lint — `bun run lint` (oxlint) 0 errors / 83 warnings (all pre-existing).
- Pre-existing api failures unchanged (NOT regressions, NOT perp-related): `copy-trade.test.ts > mapUserTradeToItem` (1) + 2 cwd-dependent migration tests (`copy_trade_follows migration`, `orders smart-exit migration`) that read `packages/db/migrations` and only fail when the suite runs with cwd=`apps/api`. Full api suite: 339 pass / 3 fail.

**Confirmed still-holding:**
- Market/Limit path unchanged — `resolveTif` (`client.ts:291`) still emits `Ioc`/`Gtc`/`Alo` for the `{ limit }` branch; trigger branch only fires for the 4 trigger types.
- Prior hardening intact: deterministic cloid (`client.ts:45`), NO-retry on all state-changing calls (`client.ts:267–280` + per-method comments), `executedSizeDecimal` reconciler column (`schema/orders.ts:146`), agent-ready gate (`assertHyperliquidAgentReady`, `orders.ts:143`) on submitPerp/setLeverage/setPerpTpSl.
- Equity paths untouched — `orders.submit`/`submitBracket`/`submitOCO`/etc. and the equity `orderSubmitSchema` (`orders.ts:35`, enum still `Market|Limit|StopMarket|StopLimit`) are not branched by the perp additions.

**Open / follow-ups:**
- **`db:push` required** for the two new `order_type` enum members (`TakeProfitMarket`/`TakeProfitLimit`) before a TP* perp insert persists — edit-only in this branch per instructions.
- `setPerpTpSl` from the positions panel hardcodes `isMarket: true` (reduce-only MARKET trigger legs). The backend already accepts `isMarket: false`; a resting-limit TP/SL on a position would need an `isMarket` toggle + limit inputs in the UI.
- Existing resting trigger orders are not surfaced/cancellable in the positions panel — `positions.listPerps` returns clearinghouse positions only, not open trigger orders; a separate `openOrders` read would be needed.
- No live/Playwright validation of the new selector or TP/SL UI (mainnet/Privy network calls prohibited in this branch) — verified via typecheck + real-module unit tests only.
- `priceTrigger` is `decimal(12,4)`; for sub-$0.0001 or very-high-priced trigger assets confirm precision is adequate (same INFO-E limitation as `executedPrice`).
