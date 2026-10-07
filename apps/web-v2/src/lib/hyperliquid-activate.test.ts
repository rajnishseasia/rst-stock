import { describe, expect, it } from "bun:test";

import {
  activateAgentWithReuseRecovery,
  ensureUnifiedAccount,
  isReusedHyperliquidAgentError,
  shouldWarnHip3ModeChange,
} from "./hyperliquid-activate";

describe("isReusedHyperliquidAgentError", () => {
  it("recognizes only Hyperliquid's definitive reused-agent refusal", () => {
    expect(isReusedHyperliquidAgentError(new Error("Extra agent already used."))).toBe(true);
    expect(isReusedHyperliquidAgentError({ message: " extra AGENT already USED " })).toBe(true);
  });

  it("does not rotate on ambiguous transport, signing, or unrelated API failures", () => {
    expect(isReusedHyperliquidAgentError(new Error("request timed out"))).toBe(false);
    expect(isReusedHyperliquidAgentError(new Error("User rejected the request"))).toBe(false);
    expect(
      isReusedHyperliquidAgentError(new Error("API request failed: Extra agent already used.")),
    ).toBe(false);
    expect(
      isReusedHyperliquidAgentError(new Error("Extra agent already used. Please retry")),
    ).toBe(false);
    expect(isReusedHyperliquidAgentError("Extra agent already used")).toBe(false);
    expect(isReusedHyperliquidAgentError(null)).toBe(false);
  });
});

describe("activateAgentWithReuseRecovery", () => {
  it("uses the prepared agent without rotating when approval succeeds", async () => {
    const activations: string[] = [];
    let rotations = 0;

    const result = await activateAgentWithReuseRecovery({
      initial: "old-agent",
      activate: async (agent) => {
        activations.push(agent);
      },
      rotate: async (failedAgent) => {
        expect(failedAgent).toBe("old-agent");
        rotations += 1;
        return "new-agent";
      },
    });

    expect(result).toBe("old-agent");
    expect(activations).toEqual(["old-agent"]);
    expect(rotations).toBe(0);
  });

  it("rotates once and approves the replacement after a definitive reuse refusal", async () => {
    const activations: string[] = [];
    let rotations = 0;

    const result = await activateAgentWithReuseRecovery({
      initial: "old-agent",
      activate: async (agent) => {
        activations.push(agent);
        if (agent === "old-agent") throw new Error("Extra agent already used.");
      },
      rotate: async (failedAgent) => {
        expect(failedAgent).toBe("old-agent");
        rotations += 1;
        return "new-agent";
      },
    });

    expect(result).toBe("new-agent");
    expect(activations).toEqual(["old-agent", "new-agent"]);
    expect(rotations).toBe(1);
  });

  it("does not rotate on an ambiguous failure or retry rotation recursively", async () => {
    let rotations = 0;
    await expect(
      activateAgentWithReuseRecovery({
        initial: "old-agent",
        activate: async () => {
          throw new Error("request timed out");
        },
        rotate: async () => {
          rotations += 1;
          return "new-agent";
        },
      }),
    ).rejects.toThrow("request timed out");
    expect(rotations).toBe(0);

    let calls = 0;
    await expect(
      activateAgentWithReuseRecovery({
        initial: "old-agent",
        activate: async () => {
          calls += 1;
          throw new Error("Extra agent already used.");
        },
        rotate: async () => {
          rotations += 1;
          return "new-agent";
        },
      }),
    ).rejects.toThrow("Extra agent already used");
    expect(calls).toBe(2);
    expect(rotations).toBe(1);
  });
});

describe("ensureUnifiedAccount", () => {
  it("uses the principal signer to move a standard account into unified mode", async () => {
    let readCount = 0;
    const transitions: Array<{
      user: `0x${string}`;
      abstraction: "unifiedAccount";
    }> = [];
    const user = "0x1111111111111111111111111111111111111111" as const;

    await ensureUnifiedAccount({
      user,
      readAbstraction: async () => {
        readCount += 1;
        return readCount < 3 ? "disabled" : "unifiedAccount";
      },
      setAbstraction: async (params) => {
        transitions.push(params);
      },
      waitForPropagation: async () => {},
    });

    expect(transitions).toEqual([{ user, abstraction: "unifiedAccount" }]);
    expect(readCount).toBe(3);
  });

  it.each(["unifiedAccount", "portfolioMargin", "dexAbstraction"] as const)(
    "does not sign a transition for an account already ready in %s mode",
    async (mode) => {
      let transitionCount = 0;

      await ensureUnifiedAccount({
        user: "0x2222222222222222222222222222222222222222",
        readAbstraction: async () => mode,
        setAbstraction: async () => {
          transitionCount += 1;
        },
      });

      expect(transitionCount).toBe(0);
    },
  );

  it("surfaces a failed transition when the account remains in standard mode", async () => {
    await expect(
      ensureUnifiedAccount({
        user: "0x3333333333333333333333333333333333333333",
        readAbstraction: async () => "disabled",
        setAbstraction: async () => {
          throw new Error("transition rejected");
        },
        waitForPropagation: async () => {},
        maxReadyChecks: 2,
      }),
    ).rejects.toThrow("transition rejected");
  });

  it("accepts a lost transition response when the account changed", async () => {
    let readCount = 0;

    await ensureUnifiedAccount({
      user: "0x4444444444444444444444444444444444444444",
      readAbstraction: async () =>
        readCount++ === 0 ? "disabled" : "unifiedAccount",
      setAbstraction: async () => {
        throw new Error("response lost");
      },
      waitForPropagation: async () => {},
    });

    expect(readCount).toBe(2);
  });

  it("does not continue until a successful transition is visible to readers", async () => {
    let readCount = 0;

    await ensureUnifiedAccount({
      user: "0x5555555555555555555555555555555555555555",
      readAbstraction: async () => {
        readCount += 1;
        return readCount < 5 ? "disabled" : "unifiedAccount";
      },
      setAbstraction: async () => {},
      waitForPropagation: async () => {},
    });

    expect(readCount).toBe(5);
  });

  it("blocks submission when a successful transition never becomes readable", async () => {
    await expect(
      ensureUnifiedAccount({
        user: "0x6666666666666666666666666666666666666666",
        readAbstraction: async () => "disabled",
        setAbstraction: async () => {},
        waitForPropagation: async () => {},
        maxReadyChecks: 3,
      }),
    ).rejects.toThrow("not yet visible");
  });
});

describe("shouldWarnHip3ModeChange", () => {
  it("warns only an account we CONFIRMED is still in Standard mode", () => {
    expect(
      shouldWarnHip3ModeChange({ isHip3Coin: true, modeReady: false }),
    ).toBe(true);
  });

  it("says nothing to an account already in a compatible mode", () => {
    // The complaint this fixes: the notice was gated on the coin alone, so
    // every HIP-3 review showed it, including to accounts for which confirming
    // changes nothing and prompts no signature.
    expect(
      shouldWarnHip3ModeChange({ isHip3Coin: true, modeReady: true }),
    ).toBe(false);
  });

  it("says nothing while the mode is unknown, rather than hedging", () => {
    // null covers both "the read has not landed" and "the read failed". An
    // unverified warning aimed at everyone is exactly what this replaces, and
    // the submit path re-reads the mode authoritatively and drives the change,
    // so silence here cannot walk anyone into an unprompted signature.
    expect(
      shouldWarnHip3ModeChange({ isHip3Coin: true, modeReady: null }),
    ).toBe(false);
  });

  it("never warns on an ordinary main-dex coin", () => {
    for (const modeReady of [true, false, null]) {
      expect(shouldWarnHip3ModeChange({ isHip3Coin: false, modeReady })).toBe(
        false,
      );
    }
  });
});
