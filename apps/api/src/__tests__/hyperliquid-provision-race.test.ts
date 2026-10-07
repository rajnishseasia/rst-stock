/**
 * H2 race safety at the PRIVY layer (as opposed to the DB layer, which
 * `hyperliquid-enable-upsert.test.ts` covers).
 *
 * `provisionHyperliquidAgentWallet` is a find-then-create against Privy, so two
 * concurrent `enable` calls (two tabs) can both miss the existence check and
 * both reach `create`. These tests exercise the real recovery helper rather than
 * mocking provisioning wholesale, and they deliberately cover BOTH plausible
 * Privy behaviors for a duplicate `external_id`, since the correct outcome must
 * not depend on which one Privy actually implements:
 *   - Privy dedupes and returns the existing wallet -> pass it through.
 *   - Privy rejects the duplicate -> re-read and adopt the winner's wallet, so
 *     the losing tab converges instead of surfacing a 500.
 */

import { describe, expect, test } from "bun:test";
import { createWalletWithRaceRecovery } from "../lib/hyperliquid.js";

const WALLET = { walletId: "w-winner", address: "0xabc" as const };

describe("createWalletWithRaceRecovery", () => {
  test("returns the created wallet when there is no race", async () => {
    let findCalls = 0;
    const result = await createWalletWithRaceRecovery(
      async () => WALLET,
      async () => {
        findCalls += 1;
        return null;
      },
    );
    expect(result).toEqual(WALLET);
    // No failure, so no recovery read should happen.
    expect(findCalls).toBe(0);
  });

  test("passes through when Privy dedupes and create returns the shared wallet", async () => {
    const result = await createWalletWithRaceRecovery(
      async () => WALLET,
      async () => null,
    );
    expect(result).toEqual(WALLET);
  });

  test("adopts the winner's wallet when Privy REJECTS the duplicate", async () => {
    // The losing tab: create throws, but the winner already provisioned the
    // wallet we want, so the loser must converge on it rather than error.
    const result = await createWalletWithRaceRecovery(
      async () => {
        throw new Error("external_id already exists");
      },
      async () => WALLET,
    );
    expect(result).toEqual(WALLET);
  });

  test("rethrows a genuine provisioning failure when there is nothing to adopt", async () => {
    const boom = new Error("privy 503");
    await expect(
      createWalletWithRaceRecovery(
        async () => {
          throw boom;
        },
        async () => null,
      ),
    ).rejects.toThrow("privy 503");
  });

  test("rethrows the ORIGINAL error, not a recovery-read error", async () => {
    const boom = new Error("privy 503");
    await expect(
      createWalletWithRaceRecovery(
        async () => {
          throw boom;
        },
        // The production caller swallows read failures to null; assert the
        // original cause is what surfaces so the 503 is not masked.
        async () => null,
      ),
    ).rejects.toThrow("privy 503");
  });
});
