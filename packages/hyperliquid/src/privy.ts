/**
 * Privy × Hyperliquid glue — the pure pieces that don't need a live Privy
 * client: the withdrawal-DENY policy payload and the wallet-ref shape persisted
 * to `user_api_credentials`. The api/worker factories consume these to build
 * `createViemAccount` signers. Kept here (not in the api app) so it can be unit
 * tested against the real `@privy-io/node` types and reused by the worker.
 *
 * SECRETS: this module never reads or embeds Privy secrets. The authorization
 * key / app secret are supplied by the caller (api factory) from env, by NAME.
 */

import { hyperliquidChain, type HyperliquidNetwork } from "./config.js";

/**
 * Structural shape of a Privy `policies().create` payload. Mirrors
 * `@privy-io/node`'s `PolicyCreateParams`, redefined locally because that type
 * is not re-exported from the package root (its `exports` map only exposes `.`,
 * `/viem`, `/solana-kit`, `/x402`). The api factory passes the result straight
 * to `privy.policies().create`, where it is structurally checked against the
 * SDK's own `PolicyCreateParams`.
 *
 * IMPORTANT — Privy policy evaluation semantics (docs.privy.io/controls/policies):
 *   - DENY takes precedence over ALLOW.
 *   - If NO rule matches a request, it is DENIED by default.
 * Consequently a policy that only DENIES withdrawals would ALSO deny order
 * signing (no matching ALLOW). We therefore include an explicit broad ALLOW for
 * `eth_signTypedData_v4` (so agent order/cancel/leverage signing is never
 * blocked) plus targeted DENY rules for every fund-exit action. DENY-precedence
 * guarantees the exits stay blocked even though the ALLOW is broad.
 */
export interface HyperliquidPolicyParams {
  chain_type: "ethereum";
  name: string;
  version: "1.0";
  rules: HyperliquidPolicyRule[];
}

/** A single policy rule. Privy requires >=1 condition per `eth_signTypedData_v4` rule. */
export interface HyperliquidPolicyRule {
  name: string;
  method: "eth_signTypedData_v4";
  action: "ALLOW" | "DENY";
  conditions: Array<{
    field_source: "ethereum_typed_data_message";
    field: string;
    typed_data: {
      primary_type: string;
      types: Record<string, Array<{ name: string; type: string }>>;
    };
    operator: "in";
    value: string[];
  }>;
}

/**
 * Back-compat alias. The api factory / worker imported `WithdrawalDenyPolicyParams`
 * before the policy was broadened to a full ALLOW-orders + DENY-exits policy.
 * @deprecated Use {@link HyperliquidPolicyParams}.
 */
export type WithdrawalDenyPolicyParams = HyperliquidPolicyParams;

/**
 * A provisioned Privy SERVER wallet reference (has a walletId we can build a
 * server-signing viem account from). Used for the AGENT wallet — which signs
 * every order/cancel/leverage server-side (popup-free) and never signs
 * withdrawals (withdrawal-DENY policy).
 */
export interface PrivyWalletRef {
  /** Privy wallet id (opaque; used to build a server viem account). */
  walletId: string;
  /** 0x-prefixed EVM address. */
  address: `0x${string}`;
}

/**
 * The wallet refs persisted for a user's Hyperliquid account.
 *
 *   - master: the user's Privy EMBEDDED wallet (user-owned, self-custody). It is
 *     the on-chain HL account that holds USDC. We store ONLY its ADDRESS — there
 *     is no server-side walletId, because it is signed CLIENT-SIDE by the
 *     embedded wallet (approveAgent / approveBuilderFee onboarding). Read-only
 *     server-side (positions / clearinghouse state).
 *   - agent : a Privy SERVER wallet (has a walletId) that signs every
 *     order/cancel/leverage server-side. Carries the withdrawal-DENY policy.
 */
export interface HyperliquidWalletRefs {
  /** Embedded master wallet — address only (no server walletId). */
  master: { address: `0x${string}` };
  /** Agent server wallet — walletId + address. */
  agent: PrivyWalletRef;
}

/**
 * The Privy authorization context for offline (no-user-present) server signing.
 * Built from `PRIVY_AUTHORIZATION_KEY` — passed to `createViemAccount` so the
 * agent/master can sign without a popup.
 */
export interface PrivyAuthorizationContext {
  authorization_private_keys: string[];
}

/**
 * Build the authorization context from a raw authorization private key. The
 * Privy recipe prefixes the key with `wallet-auth:`; we accept a value that is
 * either already prefixed or bare and normalize it.
 */
export function authorizationContextFromKey(
  authorizationKey: string,
): PrivyAuthorizationContext {
  const normalized = authorizationKey.startsWith("wallet-auth:")
    ? authorizationKey
    : `wallet-auth:${authorizationKey}`;
  return { authorization_private_keys: [normalized] };
}

/**
 * EIP-712 field definitions for every Hyperliquid fund-exit action we DENY, keyed
 * by the `HyperliquidTransaction:*` primary type. Field arrays match the HL SDK
 * (`@nktkas/hyperliquid`) signing definitions exactly, so the enclave matches the
 * signed typed data. All of these carry a `hyperliquidChain` field, which the
 * DENY condition matches on to cover both networks with one rule.
 */
const FUND_EXIT_TYPED_DATA: Record<
  string,
  Array<{ name: string; type: string }>
> = {
  // On-chain withdrawal to an external address (the primary theft vector).
  "HyperliquidTransaction:Withdraw": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
  // Send USD (perp collateral) to another HL account.
  "HyperliquidTransaction:UsdSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
  // Send a spot token to another HL account.
  "HyperliquidTransaction:SpotSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
  // Move funds between the spot and perp wallets (can strip perp collateral).
  "HyperliquidTransaction:UsdClassTransfer": [
    { name: "hyperliquidChain", type: "string" },
    { name: "amount", type: "string" },
    { name: "toPerp", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
  // Cross-DEX / subaccount asset transfer (newer send action).
  "HyperliquidTransaction:SendAsset": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationDex", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fromSubAccount", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
};

/**
 * The EIP-712 domain type. `@nktkas/hyperliquid` (via viem) ALWAYS includes an
 * `EIP712Domain` entry in the `types` of every `eth_signTypedData_v4` request.
 * Privy's policy engine matches the request's typed-data STRUCTURE against the
 * rule's `typed_data.types`, so every rule MUST declare `EIP712Domain` too —
 * otherwise the real request (which carries it) fails to match the rule and, with
 * the allowlist's deny-by-default, agent signing is denied (`policy_violation`).
 * Empirically confirmed: an Agent action signed WITH `EIP712Domain` in `types` was
 * denied until the rule declared it. VERBATIM field defs from the EIP-712 spec.
 */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

function denyRule(primaryType: string): HyperliquidPolicyRule {
  const fields = FUND_EXIT_TYPED_DATA[primaryType]!;
  return {
    name: `DENY ${primaryType}`,
    method: "eth_signTypedData_v4",
    action: "DENY",
    conditions: [
      {
        field_source: "ethereum_typed_data_message",
        field: "hyperliquidChain",
        typed_data: {
          types: { EIP712Domain: EIP712_DOMAIN_TYPE, [primaryType]: fields },
          primary_type: primaryType,
        },
        // Match both chains so the rule stays valid regardless of the env toggle.
        operator: "in",
        value: ["Testnet", "Mainnet"],
      },
    ],
  };
}

/**
 * Build the Hyperliquid trading Privy policy for a given network. The enclave
 * evaluates every rule BEFORE submission.
 *
 * The policy does TWO things (both required — see the type doc for why a
 * DENY-only policy would break signing):
 *   1. ALLOW `eth_signTypedData_v4` broadly so the agent can sign L1 orders /
 *      cancels / leverage updates (which are `eth_signTypedData_v4` under the
 *      hood). Without this, Privy's default-DENY would block ALL signing.
 *   2. DENY every fund-exit action — Withdraw, UsdSend, SpotSend,
 *      UsdClassTransfer, SendAsset. DENY takes precedence over the broad ALLOW,
 *      so exits are blocked while trading flows.
 *
 * Returned as `HyperliquidPolicyParams` (structurally a `PolicyCreateParams`)
 * so `privy.policies().create` accepts it directly.
 */
export function buildHyperliquidPolicy(
  network: HyperliquidNetwork,
): HyperliquidPolicyParams {
  // Match both chains so the same policy stays valid if the network toggles.
  void hyperliquidChain(network); // documents the linkage; DENY rules cover both

  const rules: HyperliquidPolicyRule[] = [
    // (1) ALLOW the AGENT's L1 actions (orders / cancels / leverage). Every L1
    // exchange action is signed as the HL "Agent" phantom typed data
    // (primaryType "Agent", fields source + connectionId; source "a"=mainnet,
    // "b"=testnet — see @nktkas/hyperliquid signing/_l1). Privy requires
    // eth_signTypedData_v4 rules to carry >=1 condition, so we match the Agent
    // action's `source` field (both networks). Without this, Privy's default-DENY
    // would block ALL agent signing. (approveAgent / approveBuilderFee are signed
    // CLIENT-SIDE by the embedded master, so this policy is agent-only.)
    {
      name: "ALLOW L1 Agent actions",
      method: "eth_signTypedData_v4",
      action: "ALLOW",
      conditions: [
        {
          field_source: "ethereum_typed_data_message",
          field: "source",
          typed_data: {
            // EIP712Domain MUST be declared here — the SDK sends it in every
            // request and Privy matches on the full types structure (see
            // EIP712_DOMAIN_TYPE). Without it the ALLOW rule never matches and
            // deny-by-default blocks all agent trading.
            types: {
              EIP712Domain: EIP712_DOMAIN_TYPE,
              Agent: [
                { name: "source", type: "string" },
                { name: "connectionId", type: "bytes32" },
              ],
            },
            primary_type: "Agent",
          },
          operator: "in",
          value: ["a", "b"],
        },
      ],
    },
    // (2) DENY every fund-exit action (defense-in-depth). DENY precedence
    // overrides ALLOW; the agent never legitimately signs these anyway.
    denyRule("HyperliquidTransaction:Withdraw"),
    denyRule("HyperliquidTransaction:UsdSend"),
    denyRule("HyperliquidTransaction:SpotSend"),
    denyRule("HyperliquidTransaction:UsdClassTransfer"),
    denyRule("HyperliquidTransaction:SendAsset"),
  ];

  return {
    chain_type: "ethereum",
    // Privy requires policy + rule names under 50 chars.
    name: "RST Hyperliquid agent policy",
    version: "1.0",
    rules,
  };
}

/**
 * Back-compat wrapper. The api factory / worker call `buildWithdrawalDenyPolicy`
 * today; it now returns the broadened ALLOW-orders + DENY-exits policy. Kept as
 * an alias so no caller breaks; prefer {@link buildHyperliquidPolicy}.
 * @deprecated Use {@link buildHyperliquidPolicy}.
 */
export function buildWithdrawalDenyPolicy(
  network: HyperliquidNetwork,
): HyperliquidPolicyParams {
  return buildHyperliquidPolicy(network);
}
