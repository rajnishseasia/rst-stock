/**
 * H1 wrong-wallet-binding: server-side master-address ownership check.
 *
 * Real-module tests for `privyUserOwnsEmbeddedAddress`, the pure predicate
 * behind `verifyEmbeddedMasterOwnership` (which `hyperliquid.enable` runs
 * before persisting a NEW credential row). The fixtures mirror the wire shape
 * of Privy's `linked_accounts` (snake_case, `type: "wallet"`,
 * `wallet_client_type: "privy"`, `connector_type: "embedded"`).
 */

import { describe, expect, test } from "bun:test";
import type { LinkedAccount } from "@privy-io/node";
import { privyUserOwnsEmbeddedAddress } from "../lib/hyperliquid.js";

const MASTER = "0xAbCd000000000000000000000000000000001234";

function embeddedEthWallet(address: string): LinkedAccount {
  return {
    id: "wallet-1",
    address,
    chain_id: "eip155:42161",
    chain_type: "ethereum",
    connector_type: "embedded",
    delegated: false,
    first_verified_at: null,
    imported: false,
    latest_verified_at: null,
    recovery_method: "privy",
    type: "wallet",
    verified_at: 1,
    wallet_client: "privy",
    wallet_client_type: "privy",
    wallet_index: 0,
  } as LinkedAccount;
}

describe("privyUserOwnsEmbeddedAddress", () => {
  test("matches the user's ethereum embedded wallet, case-insensitively", () => {
    const accounts = [embeddedEthWallet(MASTER)];
    expect(privyUserOwnsEmbeddedAddress(accounts, MASTER)).toBe(true);
    expect(privyUserOwnsEmbeddedAddress(accounts, MASTER.toLowerCase())).toBe(true);
    expect(
      privyUserOwnsEmbeddedAddress([embeddedEthWallet(MASTER.toLowerCase())], MASTER),
    ).toBe(true);
  });

  test("rejects an address the user does not own", () => {
    expect(
      privyUserOwnsEmbeddedAddress(
        [embeddedEthWallet(MASTER)],
        "0x9999999999999999999999999999999999999999",
      ),
    ).toBe(false);
    expect(privyUserOwnsEmbeddedAddress([], MASTER)).toBe(false);
  });

  test("only EMBEDDED ethereum wallets count", () => {
    // Externally linked EOA (not an embedded wallet): connector_type differs.
    const externalWallet = {
      address: MASTER,
      chain_type: "ethereum",
      connector_type: "injected",
      wallet_client_type: "metamask",
      first_verified_at: null,
      latest_verified_at: null,
      type: "wallet",
      verified_at: 1,
    } as unknown as LinkedAccount;
    expect(privyUserOwnsEmbeddedAddress([externalWallet], MASTER)).toBe(false);

    // Non-wallet linked accounts never match.
    const customAuth = {
      custom_user_id: "user-1",
      first_verified_at: null,
      latest_verified_at: null,
      type: "custom_auth",
      verified_at: 1,
    } as unknown as LinkedAccount;
    expect(privyUserOwnsEmbeddedAddress([customAuth], MASTER)).toBe(false);
  });
});
