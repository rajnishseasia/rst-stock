import { describe, it, expect } from "bun:test";
import {
  authorizationContextFromKey,
  buildHyperliquidPolicy,
  buildWithdrawalDenyPolicy,
} from "./privy.js";

describe("authorizationContextFromKey", () => {
  it("prefixes a bare key with wallet-auth:", () => {
    const ctx = authorizationContextFromKey("MIGHAgEA...");
    expect(ctx.authorization_private_keys).toEqual(["wallet-auth:MIGHAgEA..."]);
  });

  it("leaves an already-prefixed key untouched", () => {
    const ctx = authorizationContextFromKey("wallet-auth:MIGHAgEA...");
    expect(ctx.authorization_private_keys).toEqual(["wallet-auth:MIGHAgEA..."]);
  });
});

describe("buildHyperliquidPolicy", () => {
  it("is a valid PolicyCreateParams shell (ethereum, v1.0)", () => {
    const policy = buildHyperliquidPolicy("mainnet");
    expect(policy.chain_type).toBe("ethereum");
    expect(policy.version).toBe("1.0");
    expect(policy.rules.length).toBeGreaterThan(1);
  });

  it("ALLOWs the L1 Agent action (source a/b) so agent order/cancel/leverage signing is never blocked", () => {
    // Privy defaults to DENY when no rule matches, so an explicit ALLOW is
    // REQUIRED or the agent could not sign L1 orders at all. Privy also requires
    // >=1 condition on eth_signTypedData_v4 rules, so the ALLOW matches HL's L1
    // "Agent" phantom typed data (source "a"=mainnet, "b"=testnet).
    const policy = buildHyperliquidPolicy("mainnet");
    const allow = policy.rules.find((r) => r.action === "ALLOW");
    expect(allow).toBeDefined();
    expect(allow!.method).toBe("eth_signTypedData_v4");
    expect(allow!.conditions.length).toBeGreaterThan(0);
    const cond = allow!.conditions[0]!;
    expect(cond.typed_data.primary_type).toBe("Agent");
    expect(cond.field).toBe("source");
    expect(cond.value).toEqual(["a", "b"]);
    // Every rule name (and the policy name) must stay under Privy's 50-char limit.
    expect(policy.name.length).toBeLessThan(50);
    for (const r of policy.rules) expect(r.name.length).toBeLessThan(50);
  });

  it("declares EIP712Domain in EVERY rule's types (the SDK always sends it; Privy matches on structure)", () => {
    // REGRESSION LOCK: without EIP712Domain in typed_data.types, the real
    // @nktkas/hyperliquid eth_signTypedData_v4 request (which carries an
    // EIP712Domain entry) fails to match the rule and deny-by-default blocks ALL
    // agent signing (`policy_violation`). Empirically confirmed on mainnet.
    for (const rule of buildHyperliquidPolicy("mainnet").rules) {
      for (const cond of rule.conditions) {
        const domain = cond.typed_data.types["EIP712Domain"];
        expect(domain).toBeDefined();
        expect(domain).toEqual([
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ]);
      }
    }
  });

  it("DENYs every fund-exit action (Withdraw, UsdSend, SpotSend, UsdClassTransfer, SendAsset)", () => {
    const policy = buildHyperliquidPolicy("mainnet");
    const deniedPrimaryTypes = policy.rules
      .filter((r) => r.action === "DENY")
      .map((r) => r.conditions[0]!.typed_data.primary_type);
    expect(deniedPrimaryTypes).toEqual(
      expect.arrayContaining([
        "HyperliquidTransaction:Withdraw",
        "HyperliquidTransaction:UsdSend",
        "HyperliquidTransaction:SpotSend",
        "HyperliquidTransaction:UsdClassTransfer",
        "HyperliquidTransaction:SendAsset",
      ]),
    );
  });

  it("scopes every DENY to eth_signTypedData_v4 on the hyperliquidChain field for both chains", () => {
    const policy = buildHyperliquidPolicy("mainnet");
    for (const rule of policy.rules.filter((r) => r.action === "DENY")) {
      expect(rule.method).toBe("eth_signTypedData_v4");
      const cond = rule.conditions[0]!;
      expect(cond.field_source).toBe("ethereum_typed_data_message");
      expect(cond.field).toBe("hyperliquidChain");
      expect(cond.operator).toBe("in");
      expect(cond.value).toEqual(["Testnet", "Mainnet"]);
      // The typed_data.types map must include the rule's primary type definition.
      expect(cond.typed_data.types[cond.typed_data.primary_type]).toBeDefined();
    }
  });

  it("emits the same policy for testnet and mainnet (DENY covers both chains)", () => {
    expect(buildHyperliquidPolicy("testnet")).toEqual(buildHyperliquidPolicy("mainnet"));
  });
});

describe("buildWithdrawalDenyPolicy (back-compat alias)", () => {
  it("delegates to buildHyperliquidPolicy", () => {
    expect(buildWithdrawalDenyPolicy("mainnet")).toEqual(buildHyperliquidPolicy("mainnet"));
  });
});
