import { describe, expect, test } from "bun:test";
import { selectPerpsEmbeddedWallet, type PerpsWalletCandidate } from "./perps-wallet-selection";

const generatedEvm: PerpsWalletCandidate = {
  address: "0x1111111111111111111111111111111111111111",
  chainType: "ethereum",
  walletClientType: "privy",
  imported: false,
};

const importedEvm: PerpsWalletCandidate = {
  address: "0x2222222222222222222222222222222222222222",
  chainType: "ethereum",
  walletClientType: "privy",
  imported: true,
};

describe("selectPerpsEmbeddedWallet", () => {
  test("selects the EVM Privy wallet and ignores non-EVM wallets", () => {
    expect(
      selectPerpsEmbeddedWallet([
        {
          address: "0x3333333333333333333333333333333333333333",
          chainType: "solana",
          walletClientType: "privy",
          imported: false,
        },
        generatedEvm,
      ]),
    ).toEqual(generatedEvm);
  });

  test("prefers the server-bound address over another EVM wallet", () => {
    expect(
      selectPerpsEmbeddedWallet([generatedEvm, importedEvm], importedEvm.address),
    ).toEqual(importedEvm);
  });

  test("does not fall back when the preferred stored master is missing", () => {
    expect(
      selectPerpsEmbeddedWallet(
        [generatedEvm],
        "0x9999999999999999999999999999999999999999",
      ),
    ).toBeUndefined();
  });

  test("does not select another wallet for an enabled account without a stored master", () => {
    expect(
      Boolean(
        selectPerpsEmbeddedWallet([generatedEvm], null, {
          requirePreferredAddress: true,
        }),
      ),
    ).toBe(false);
  });

  test("does not select a wallet when an enabled account has an invalid stored master", () => {
    expect(
      Boolean(
        selectPerpsEmbeddedWallet([generatedEvm], "not-an-address", {
          requirePreferredAddress: true,
        }),
      ),
    ).toBe(false);
  });

  test("restores an imported EVM wallet when no server address is available", () => {
    expect(selectPerpsEmbeddedWallet([generatedEvm, importedEvm])).toEqual(
      importedEvm,
    );
  });

  test("falls back to the first EVM wallet when no imported wallet exists", () => {
    expect(selectPerpsEmbeddedWallet([generatedEvm])).toEqual(generatedEvm);
  });

  test("does not fall back to a wallet explicitly marked as another chain type", () => {
    expect(
      selectPerpsEmbeddedWallet([
        {
          address: "0x3333333333333333333333333333333333333333",
          chainType: "solana",
          walletClientType: "privy",
          imported: false,
        },
      ]),
    ).toBeUndefined();
  });

  test("falls back to a Privy wallet with unknown chain type metadata", () => {
    const legacyWallet: PerpsWalletCandidate = {
      address: "0x4444444444444444444444444444444444444444",
      walletClientType: "privy",
      imported: false,
    };
    expect(selectPerpsEmbeddedWallet([legacyWallet])).toEqual(legacyWallet);
  });
});
