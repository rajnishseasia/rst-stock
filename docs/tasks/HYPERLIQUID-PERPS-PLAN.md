# Hyperliquid Perps — Integration Plan (v1)

Status: Draft for review · Branch: off `main`

## Decisions locked in

| Decision | Choice | Consequence |
| --- | --- | --- |
| Product framing | **"Just a wrapper"** — UI + signing orchestration + builder-fee cut | We never run a matching engine or custody funds. HL's L1 order book is the venue. |
| Login / identity | **Keep Better Auth** (existing Google/email) | Privy is **wallet infra only**, not an auth provider. No second login system. Wallets key off the existing Better Auth `userId`. |
| Wallets & custody | **Privy server wallets** (Wallet API), master + agent split, **server-signed** | Keys live in Privy's secure **enclave — never in our DB**. Backend signs via Privy *authorization keys*. Master holds USDC + can withdraw; agent signs orders and is policy-locked (no withdraw). |
| Seamlessness | **Zero popups after signup + funding** | Every HL action is server-signed. User clicks Buy; no wallet modal. Worker can act with no user present → enables order-sync + future auto-exit. |
| Monetization | **Builder codes** (from starter kit) | `builder: { b, f }` on every order + one-time `approveBuilderFee`. Cap 0.1% perps. |
| v1 scope | **Trading core only** | Order submit/cancel (market + limit), leverage & margin mode, live perp positions (PnL / liquidation / funding), close. Copy-trade, perp signals, Smart-Exit TP/SL deferred. |
| Network | **Mainnet from the start** | Real funds. Env-driven base URL so local/dev can still point at testnet. |

**De-risker:** Privy ships an **official Hyperliquid recipe** (`docs.privy.io/recipes/hyperliquid`) covering `createViemAccount` → `ExchangeClient`, plus **policies and offline (server-side, no-user-present) actions**. We follow it rather than improvising.

## 1. Guiding principle — a thin venue seam, not a rewrite

Today there is **no broker abstraction**: `@trade-bot/alpaca` is imported and instantiated directly in `orders.ts`, `positions.ts`, `quotes.ts`, `charts.ts`, `order-sync.ts`, and `copy-mirror.ts`, all keyed to `provider: "alpaca"`.

We will **not** force a universal `BrokerInterface` across equities/options and perps — their domain models genuinely differ (integer shares vs. decimal size + leverage + funding). Instead:

- Add a **new `@trade-bot/hyperliquid` package** mirroring the shape of `@trade-bot/alpaca`.
- **Route by asset type / venue** at the entry points. A perp order (`assetType: "PERP"`) takes the Hyperliquid path; everything else stays on the untouched Alpaca path.

This keeps existing equities/options flows byte-for-byte unchanged and confines risk to new code.

## 2. Data model changes (`packages/db/src/schema/orders.ts`)

Perps break three assumptions: integer `quantity`, no leverage, equity-only enums.

**Enum additions**
- `assetTypeEnum`: add `"PERP"`.
- `orderTypeEnum`: reuse `"Market"`, `"Limit"`. (Trigger/stop deferred with Smart-Exit.)
- `tradeActionEnum`: reuse `"Buy"` / `"Sell"` — perp direction rides `direction` (`long`/`short`) + `reduceOnly`.
- API-layer time-in-force must add `"Alo"` (post-only). HL market orders = IoC + aggressive price (HL has **no native market order**).

**New nullable columns (additive — safe `db:push`)**
- `size` `decimal(38, 8)` — perp order size in coin units (keep integer `quantity` for equities untouched).
- `leverage` `integer`, `marginMode` `text` (`"cross" | "isolated"`), `reduceOnly` `boolean default false`.
- `venue` `text default 'alpaca'` (`'alpaca' | 'hyperliquid'`) — explicit venue tag for queries/workers.
- Perp fills can be sub-cent → store perp `executedPrice` at `decimal(38, 8)` (new column or widened scale on a perp-specific field).

**Notes**
- `brokerOrderId` holds the HL numeric **oid** (as text); `brokerAccountId` holds the **master wallet address**.
- Follow CLAUDE.md DB workflow: edit schema → `bun run db:push` against `DATABASE_URL_DIRECT`, review statements. Add the "production schema update required" PR checklist items.

## 3. New package — `@trade-bot/hyperliquid`

Mirror `packages/alpaca/`: `client.ts`, `config.ts`, `types.ts`, `index.ts`, tests.

**Dependencies**: `@nktkas/hyperliquid` (typed TS SDK, Bun-compatible) + `viem` + `@privy-io/node` (server wallets + `createViemAccount`). The client is constructed from a **Privy viem account**, not a raw key.

**`HyperliquidClient` responsibilities**
- Construct `ExchangeClient` from a Privy-backed viem account (agent wallet) + `HttpTransport`; construct a keyless `InfoClient` for reads.
- Trading: `placeOrder` (wraps `exchange.order({ orders:[{a,b,p,s,r,t:{limit:{tif}}}], grouping:"na", builder:{ b, f } })` — **builder code always attached**), `cancelOrder`, `updateLeverage`, `marketClose` (reduce-only IoC at aggressive price).
- Reads (keyed by **master** address, never agent): `clearinghouseState` (positions, PnL, leverage, liquidationPx, cumFunding, margin), `openOrders`, `userFills`, `allMids`, `metaAndAssetCtxs` (funding).
- **Asset index + rounding**: use the SDK's `SymbolConverter` + `formatPrice`/`formatSize` (`@nktkas/hyperliquid/utils`) — HL enforces tick size and `szDecimals` per asset; unrounded orders reject. Central `resolveAssetIndex(coin)` cache from `meta().universe`.
- **Idempotency**: attach a deterministic `cloid` (128-bit hex) per order so a retried submit dedupes broker-side — the HL analogue of Alpaca's `client_order_id` discipline (CLAUDE.md).

## 4. Wallets & credentials (Privy server wallets)

**No raw keys in our DB.** Privy holds keys in its enclave; we store references + Privy wallet metadata.

- **Provision** on first perp use (server-side, Privy Wallet API, `provider_user_id = <Better Auth userId>`): create a **master** server wallet, then create an **agent** server wallet.
- **What we persist** (extend `user_api_credentials` with `provider = "hyperliquid"`, reusing existing columns; no key material stored):
  - `username` = master wallet address (the HL account we read state for).
  - `accountId` / `brokerAccountId` = master address; store **Privy `walletId`s** for master + agent (in `encryptedAccessToken`/a small JSON, or a dedicated nullable column — decide at build).
  - The **Privy authorization key** is an app-level secret in env, not per-user.
- **API factory** `apps/api/src/lib/hyperliquid.ts` (mirrors `lib/alpaca.ts`): resolves the user's Privy wallet ids → `createViemAccount(privy, { walletId, address, authorizationContext })` → `new HyperliquidClient(...)`. Reads use a keyless `InfoClient` (HL public data is unauthenticated — no master secret needed, unlike Alpaca).
- Extend `CredentialProvider` in `lib/credentials.ts` to `"alpaca" | "hyperliquid"`.

**Env** (`apps/api/.env.example`, `apps/worker/.env.example`):
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` (server signing).
- `HYPERLIQUID_ENV=mainnet` (→ `api.hyperliquid.xyz`; testnet → `api.hyperliquid-testnet.xyz`).
- `HL_BUILDER_ADDRESS`, `HL_BUILDER_MAX_FEE_RATE` (e.g. `"0.1%"`), `HL_BUILDER_FEE_TENTHS_BP` (e.g. `50` = 0.05%). **Approve a higher max than you charge** so fee changes don't force per-user re-onboarding.

## 5. Onboarding flow (all server-signed → silent)

Happens once per user, entirely without wallet popups:

1. User is already logged in via Better Auth. On entering Perps, the app calls a new `hyperliquid.enable` tRPC mutation.
2. Server **provisions** master + agent Privy wallets (§4), keyed to the userId.
3. Server signs, with the **master** wallet (via Privy authorization key — no user interaction):
   - `approveAgent({ agentAddress, agentName: "readysettrade" })`
   - `approveBuilderFee({ builder: HL_BUILDER_ADDRESS, maxFeeRate: HL_BUILDER_MAX_FEE_RATE })`
4. Apply a **Privy policy** to the wallets restricting signable actions (block withdrawals / scope to HL trading) — enclave-side firewall on top of the agent's native no-withdraw property.
5. Mark the connection active. From here, all trading is agent-signed and silent.
6. **Funding**: the one on-chain step. Prompt the user to deposit USDC to their master wallet (min ~5 USDC) → HL bridge. Detect funded via `clearinghouseState.marginSummary.accountValue`. Optionally wire Privy's fiat on-ramp so users card-fund directly into the master wallet.

## 6. API routers

- **`orders.ts`**: branch `submit` on `assetType === "PERP"`. Add perp fields to `orderSubmitSchema` (`leverage`, `marginMode`, `reduceOnly`, decimal `size`, tif incl. `Alo`). Perp path: resolve asset index → `updateLeverage` if changed → `placeOrder` (builder code attached) → persist with `venue`, `size`, `leverage`, `marginMode`, HL `oid`, `cloid`. Alpaca path untouched. Add HL `cancel` branch.
- **New `orders.setLeverage`** mutation.
- **`positions.ts`**: add `positions.listPerps` from `clearinghouseState` (distinct shape: leverage, liquidationPx, funding) rather than overloading `PositionListResponse`.
- **Market data**: perp mark + funding via keyless `InfoClient` (`allMids`, `metaAndAssetCtxs`).
- Reuse existing Redis rate-limit + friendly-error patterns.

## 7. Worker

- **New `HyperliquidOrderSyncPoller`** (separate class from the Alpaca one): for users with HL creds + open perp orders, read `openOrders` + `userFills`, map to our status enum, persist fills. Grouped per user; signs via Privy viem account (server-side, no user present).
- Register in `apps/worker/src/index.ts` behind an env flag defaulting **off** until validated on mainnet (matches the copy-mirror "ships inert" convention).
- **Copy-mirror / signals**: explicitly out of scope for v1; no changes.

## 8. Frontend (`apps/web-v2`)

Wallets are greenfield here (no wagmi/viem/Privy currently installed → no conflicts).

- Add `@privy-io/react-auth` for the client wallet UX, configured **without** replacing Better Auth (Privy as wallet layer over the existing session).
- **Perp trade mode** in `components/trade/trade-form.tsx` / `terminal/`: leverage slider (1×–asset max), cross/isolated toggle, size (coin) + USD notional helper, reduce-only, post-only (Alo). Hide equity/option-only fields.
- **Perp positions panel**: size, entry, mark, unrealized PnL, **liquidation price**, **funding**, leverage/margin mode, + reduce-only "Close" button.
- **Enable Perps + Fund** flow (§5): a short "activate + deposit USDC" step; everything else popup-free.
- Symbol autocomplete sources perp coins from `meta().universe`. Follow `DESIGN.md` / `design.tokens.json`; add tests alongside existing `__tests__`.

## 9. Security & real-money guardrails (mainnet)

- **No raw private keys in our infra** — Privy enclave holds them; our server presents an authorization key (an app-level secret; store in env / secrets manager, never in DB or logs, per repo rule).
- **Two withdrawal firewalls**: HL agent wallet cannot withdraw (native) **and** Privy policy restricts signable actions (enclave-side). Worst-case compromise = unauthorized trading, not fund theft.
- Deterministic `cloid` on every order; never re-submit without it; keep CLAUDE.md's "once broker call succeeds, never mark failed locally" rule.
- Tick/lot rounding via SDK utils before submit; clamp leverage to asset `maxLeverage`.
- HL worker poller ships **inert** behind a flag; enable only after a live minimal-size smoke test.
- Reuse Redis rate-limiter; respect HL's weight-based rate limits.
- **Legal**: self-custodial perps must stay clearly separated from the regulated stock side; **geofence restricted jurisdictions**.

## 10. Testing

- Unit: asset-index resolution, tick/size rounding, order-payload mapping (domain → HL `order` shape), leverage clamping, `cloid` determinism, builder-fee field. Import real modules (repo rule — no source-regex tests).
- Integration (testnet): provision Privy wallets → approveAgent → place → read state → cancel → close against `hyperliquid-testnet.xyz`. Gate behind env-provided Privy test creds so CI skips by default.
- Manual mainnet smoke: one minimal-size position end-to-end before flipping the feature flag for users.

## 11. Rough sequencing (one PR off `main` — no stacked PRs per CLAUDE.md)

1. `@trade-bot/hyperliquid` package (client, config, types, asset-index + rounding, builder code) + unit tests.
2. Privy server-wallet plumbing (`lib/hyperliquid.ts` factory, provisioning, `createViemAccount`) + `CredentialProvider` extension + DB schema additions (`db:push`).
3. `hyperliquid.enable` mutation (provision + approveAgent + approveBuilderFee + policy) — server-signed.
4. `orders.submit` perp branch + `orders.setLeverage` + HL `cancel`.
5. `positions.listPerps` + perp market data (mids/funding).
6. Frontend: Privy provider, perp trade mode, positions panel, enable+fund flow.
7. `HyperliquidOrderSyncPoller` (worker), registered inert behind flag.
8. Docs + `.env.example` + PR checklist (schema update, mainnet smoke, geofencing).

If too large for one review: ship steps 1–3 (package + wallet plumbing + enable) first, then the rest (CLAUDE.md "foundation then follow-up").

## 12. Explicitly out of scope for v1 (deferred)

- Copy-trade mirroring of perps · signal-driven perp entries · Smart-Exit (TP / trailing) via HL trigger orders · Spot HL markets.

## 13. Open items to confirm at build time

- ✅ **Resolved** — Privy policy schema to block withdrawals while allowing HL actions. It's a `DENY` policy on `eth_signTypedData_v4` matching the `HyperliquidTransaction:Withdraw` EIP-712 primary type, with `ALLOW` policies for `ApproveAgent` / orders. Policy eval runs automatically in the enclave *before* submission; a denied action never reaches HL. See Appendix A.
- Whether to keep the master+agent split or collapse to a single policy-locked master wallet (defense-in-depth vs. simplicity). Plan assumes the split. *(Note: the withdrawal policy alone now blocks fund theft even on a single wallet — so the agent split is defense-in-depth, not strictly required.)*
- Where to store Privy `walletId`s (reuse a `user_api_credentials` column vs. a small dedicated table).
- Privy fiat on-ramp wiring for USDC funding (nice-to-have, not v1-blocking).
- Guard the **authorization key** as a top-tier secret: per Privy, an authorization-key owner can sign, update policies, export keys, and delete wallets. Scope/rotate it carefully; never in DB or logs.

## Appendix A — Pinned Privy × Hyperliquid code shapes (from the official recipe)

Packages: `@privy-io/node` (server SDK + `@privy-io/node/viem`), `@nktkas/hyperliquid` (as `hl`), `viem`.

```ts
// 1. Provision a server wallet (master or agent), keyed to your Better Auth userId
const privy = new PrivyClient({ appId, appSecret });
const masterWallet = await privy.wallets().createWallet({ chain_type: "ethereum" });

// 2. Build a viem account backed by the Privy wallet — offline/server signing
import { createViemAccount } from "@privy-io/node/viem";
const account = createViemAccount(privy, {
  walletId: masterWallet.id,
  address: masterWallet.address as `0x${string}`,
  authorizationContext: { authorization_private_keys: ["wallet-auth:<AUTHORIZATION_PRIVATE_KEY>"] },
});

// 3. Hand it to the HL SDK — no user present, no popup
const masterClient = new hl.ExchangeClient({ transport, wallet: account });
await masterClient.registerAgent({ agentAddress, agentName: "readysettrade" });   // one-time, master-signed
// (approveBuilderFee likewise, master-signed)

// 4. Orders signed by the AGENT wallet (its own createViemAccount), builder code attached
await agentClient.order({ orders: [/* {a,b,p,s,r,t} */], grouping: "na", builder: { b, f } });
```

Withdrawal-blocking policy (attach to the wallet; enclave denies before submission):

```json
{
  "name": "DENY Withdrawal",
  "method": "eth_signTypedData_v4",
  "action": "DENY",
  "conditions": [{
    "field_source": "ethereum_typed_data_message",
    "field": "hyperliquidChain",
    "typed_data": { "types": { "HyperliquidTransaction:Withdraw": [
      {"name": "hyperliquidChain", "type": "string"},
      {"name": "destination", "type": "string"},
      {"name": "amount", "type": "string"},
      {"name": "time", "type": "uint64"}
    ] }, "primary_type": "HyperliquidTransaction:Withdraw" },
    "operator": "in",
    "value": ["Testnet", "Mainnet"]
  }]
}
```

Attach via `privy.wallets().update(walletId, { additional_signers: [{ signer_id, override_policy_ids: [policyId] }] })`. Mirror the pattern with `ALLOW` on `HyperliquidTransaction:ApproveAgent` and the order/leverage actions.

## v1 mainnet decisions (2026-07-06)

- **Mainnet only — no testnet.** `HYPERLIQUID_NETWORK=mainnet`. No fake-money path; first end-to-end run is real USDC at minimal size, done manually.
- **Withdraw-DENY policy is mandatory** — verify it works in `hyperliquid.enable` BEFORE any wallet is funded beyond a few dollars.
- **Privy stays Development mode** (150-user cap; signs mainnet fine). Upgrade to production before scaling past 150 users.
- **Builder codes deferred.** `builder` attachment must be CONDITIONAL on `HL_BUILDER_ADDRESS` being set — never send `builder: undefined`. Add once a builder address is funded (>=100 USDC).
- **Stay dark until validated:** `HYPERLIQUID_SYNC_ENABLED=false` and frontend `NEXT_PUBLIC_PERPS_ENABLED` OFF until the first real mainnet trade is confirmed.
- Local dev now places REAL orders once perps are enabled — no testnet cushion.
