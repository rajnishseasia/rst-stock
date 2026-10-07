/**
 * Unit tests for the resume-parity guards.
 *
 * A resume re-sends an intent that was clamped and priced on the first attempt.
 * The cases that matter are the ones where the world has moved since: a lowered
 * user ceiling, a coin whose own max leverage was cut, a mark that ran away
 * from the dollar cap, collateral that is no longer there. Every one of those
 * must narrow the order or refuse it, and none of them may widen it.
 */

import { describe, expect, it } from "bun:test";
import {
  clampResumeLeverage,
  decidePerpResumeParity,
} from "../copy-mirror-perp-resume-parity";
import { resolveEffectivePerpLeverage } from "../copy-mirror-perp-leverage";

/** 0.125 BTC at 100 is a $12.5 order: over the $10 venue minimum, under a $1k cap. */
const BASE = {
  storedLeverage: 5,
  storedSizeCoin: "0.125",
  side: "long" as const,
  sourceLeverage: 5,
  stagedUserMaxLeverage: 10,
  stagedFollowMaxLeverage: null,
  currentUserMaxLeverage: 10,
  currentFollowMaxLeverage: null,
  venueMaxLeverage: 50,
  sizeDecimals: 3,
  rawMid: "100",
  freeCollateralUsd: 10_000,
  maxOrderDollars: 1_000,
};

function policy(overrides: Partial<typeof BASE> = {}) {
  return {
    sourceLeverage: BASE.sourceLeverage,
    stagedUserMaxLeverage: BASE.stagedUserMaxLeverage,
    stagedFollowMaxLeverage: BASE.stagedFollowMaxLeverage,
    currentUserMaxLeverage: BASE.currentUserMaxLeverage,
    currentFollowMaxLeverage: BASE.currentFollowMaxLeverage,
    venueMaxLeverage: BASE.venueMaxLeverage,
    ...overrides,
  };
}

describe("clampResumeLeverage", () => {
  it("keeps a stored leverage that is still inside both ceilings", () => {
    expect(clampResumeLeverage(5, policy())).toBe(5);
  });

  it("clamps down to a user ceiling that has since been lowered", () => {
    // The whole point: a queued delivery must not outlive the ceiling it was
    // written under.
    expect(clampResumeLeverage(20, policy({ sourceLeverage: 20, currentUserMaxLeverage: 3 }))).toBe(3);
  });

  it("clamps down to a coin max leverage the venue has since cut", () => {
    expect(clampResumeLeverage(20, policy({ sourceLeverage: 20, currentUserMaxLeverage: 40, venueMaxLeverage: 5 }))).toBe(5);
  });

  it("never raises a stored leverage when a ceiling is lifted", () => {
    expect(clampResumeLeverage(3, policy({ sourceLeverage: 20, currentUserMaxLeverage: 40 }))).toBe(3);
  });

  it("refuses a stored leverage that is not a positive integer", () => {
    expect(clampResumeLeverage(null, policy())).toBeNull();
    expect(clampResumeLeverage(undefined, policy())).toBeNull();
    expect(clampResumeLeverage(0, policy())).toBeNull();
    expect(clampResumeLeverage(-4, policy())).toBeNull();
    expect(clampResumeLeverage(2.5, policy())).toBeNull();
    expect(clampResumeLeverage(Number.NaN, policy())).toBeNull();
  });

  it("fails safely to 1x when a policy ceiling is unusable", () => {
    expect(clampResumeLeverage(5, policy({ currentUserMaxLeverage: Number.NaN }))).toBe(1);
    expect(clampResumeLeverage(5, policy({ currentUserMaxLeverage: 0 }))).toBe(1);
    expect(clampResumeLeverage(5, policy({ venueMaxLeverage: Number.NaN }))).toBe(1);
    expect(clampResumeLeverage(5, policy({ venueMaxLeverage: 0 }))).toBe(1);
    expect(resolveEffectivePerpLeverage({
      ...policy({ currentUserMaxLeverage: Number.NaN }),
    })).toBe(1);
  });

  it("agrees with the fresh-open clamp whenever every input is usable", () => {
    const cases: Array<[number, number, number]> = [
      [5, 10, 50],
      [20, 3, 50],
      [20, 40, 5],
      [1, 1, 1],
      [7, 7, 7],
    ];
    for (const [stored, currentUserMaxLeverage, venueMaxLeverage] of cases) {
      const values = policy({
        sourceLeverage: Math.max(stored, currentUserMaxLeverage),
        currentUserMaxLeverage,
        venueMaxLeverage,
      });
      expect(clampResumeLeverage(stored, values)).toBe(
        resolveEffectivePerpLeverage({ ...values, storedOrderLeverage: stored }),
      );
    }
  });
});

describe("decidePerpResumeParity", () => {
  it("resumes an intent that still clears every current guard", () => {
    const decision = decidePerpResumeParity(BASE);
    expect(decision).toMatchObject({
      action: "resume",
      leverage: 5,
      leverageWasClamped: false,
      markPrice: "100",
    });
  });

  it("hands back the clamped leverage and flags that the row is now stale", () => {
    const decision = decidePerpResumeParity({
      ...BASE,
      storedLeverage: 20,
      sourceLeverage: 20,
      currentUserMaxLeverage: 3,
    });
    expect(decision).toMatchObject({
      action: "resume",
      leverage: 3,
      leverageWasClamped: true,
    });
  });

  it("refuses when the stored leverage cannot be re-clamped", () => {
    expect(decidePerpResumeParity({ ...BASE, storedLeverage: null })).toEqual({
      action: "skip",
      reason: "leverage-unconfirmed",
    });
  });

  it("refuses when the mark has carried the stored size past the dollar cap", () => {
    // 0.125 coin at 100k is $12.5k against a $1k cap. The fresh open would never
    // have sized this; the resume must not place it either.
    expect(decidePerpResumeParity({ ...BASE, rawMid: "100000" })).toEqual({
      action: "skip",
      reason: "dollar-cap",
    });
  });

  it("checks the cap against the worst fill the IoC can produce, not the mid", () => {
    // 0.125 at 7619 is $952.375 at the mid and $1000.00 at the top of the 5%
    // band, so a cap check against the mid alone would let it through.
    const decision = decidePerpResumeParity({
      ...BASE,
      rawMid: "7619",
      maxOrderDollars: 960,
    });
    expect(decision).toEqual({ action: "skip", reason: "dollar-cap" });
  });

  it("uses the exact venue price when a coarse tick widens the IoC buffer", () => {
    expect(decidePerpResumeParity({
      ...BASE,
      storedSizeCoin: "1",
      side: "long",
      sizeDecimals: 6,
      rawMid: "11.4",
      maxOrderDollars: 11.99,
    })).toEqual({ action: "skip", reason: "dollar-cap" });
  });

  it("refuses when the mark has dropped the stored size under the venue minimum", () => {
    expect(decidePerpResumeParity({ ...BASE, rawMid: "50" })).toEqual({
      action: "skip",
      reason: "below-min-notional",
    });
  });

  it("refuses when free collateral can no longer back the worst-case fill", () => {
    expect(decidePerpResumeParity({ ...BASE, freeCollateralUsd: 1 })).toEqual({
      action: "skip",
      reason: "insufficient-margin",
    });
  });

  it("reports unreadable collateral separately from insufficient collateral", () => {
    // An operator has to be able to tell "we could not read the account" from
    // "the account cannot afford this".
    expect(decidePerpResumeParity({ ...BASE, freeCollateralUsd: null })).toEqual({
      action: "skip",
      reason: "margin-unavailable",
    });
  });

  it("re-checks the margin gate at the CLAMPED leverage, not the stored one", () => {
    // $12.5k order, $1.3k free. At the stored 20x the initial margin is $656 and
    // it fits; at the 5x ceiling in force now it is $2.6k and it does not.
    const input = {
      ...BASE,
      storedSizeCoin: "0.125",
      rawMid: "100000",
      maxOrderDollars: 100_000,
      freeCollateralUsd: 1_300,
      storedLeverage: 20,
    };
    expect(decidePerpResumeParity({
      ...input,
      sourceLeverage: 20,
      stagedUserMaxLeverage: 20,
      currentUserMaxLeverage: 20,
    })).toMatchObject({
      action: "resume",
      leverage: 20,
    });
    expect(decidePerpResumeParity({
      ...input,
      sourceLeverage: 20,
      stagedUserMaxLeverage: 20,
      currentUserMaxLeverage: 5,
    })).toEqual({
      action: "skip",
      reason: "insufficient-margin",
    });
  });

  it("refuses every mid shape it does not understand", () => {
    for (const rawMid of [undefined, null, "", " ", "abc", "1e5", "-100", "0", 100, Number.NaN]) {
      expect(decidePerpResumeParity({ ...BASE, rawMid })).toEqual({
        action: "skip",
        reason: "no-qty",
      });
    }
  });

  it("refuses every stored size it cannot re-price", () => {
    for (const storedSizeCoin of [undefined, null, "", "abc", "-0.125", "0", "1e-3"]) {
      expect(decidePerpResumeParity({ ...BASE, storedSizeCoin })).toEqual({
        action: "skip",
        reason: "no-qty",
      });
    }
  });

  it("accepts the shared boundary and refuses a stored size just above it", () => {
    expect(decidePerpResumeParity({
      ...BASE,
      storedSizeCoin: "90071992.54740991",
      sizeDecimals: 8,
      rawMid: "1",
      maxOrderDollars: 200_000_000,
      freeCollateralUsd: 200_000_000,
    }).action).toBe("resume");
    expect(decidePerpResumeParity({
      ...BASE,
      storedSizeCoin: "90071992.54740992",
      sizeDecimals: 8,
      rawMid: "1",
      maxOrderDollars: 200_000_000,
      freeCollateralUsd: 200_000_000,
    })).toEqual({ action: "skip", reason: "no-qty" });
    expect(decidePerpResumeParity({
      ...BASE,
      storedSizeCoin: "1",
      rawMid: "90071992.54740992",
      maxOrderDollars: 200_000_000,
      freeCollateralUsd: 200_000_000,
    })).toEqual({ action: "skip", reason: "no-qty" });
  });

  it("fails closed on an unusable dollar cap rather than treating it as no cap", () => {
    for (const maxOrderDollars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decidePerpResumeParity({ ...BASE, maxOrderDollars })).toEqual({
        action: "skip",
        reason: "dollar-cap",
      });
    }
  });
});

describe("decidePerpResumeParity staged and current user policy", () => {
  const POLICY_BASE = {
    storedLeverage: 8,
    storedSizeCoin: "0.125",
    side: "long" as const,
    sourceLeverage: 10,
    stagedUserMaxLeverage: 2,
    stagedFollowMaxLeverage: null,
    currentUserMaxLeverage: 2,
    currentFollowMaxLeverage: null,
    venueMaxLeverage: 50,
    sizeDecimals: 3,
    rawMid: "100",
    freeCollateralUsd: 10_000,
    maxOrderDollars: 1_000,
  };

  it("applies the staged and current policy while never raising stored intent", () => {
    const decision = decidePerpResumeParity(POLICY_BASE);
    expect(decision).toMatchObject({
      action: "resume",
      leverage: 2,
      leverageWasClamped: true,
    });
  });

  it("refuses a resume when current venue precision would change the quantity", () => {
    expect(decidePerpResumeParity({
      ...BASE,
      storedSizeCoin: "0.125",
      sizeDecimals: 2,
    })).toEqual({ action: "skip", reason: "no-qty" });
  });

  it("allows trailing-zero normalization at current venue precision", () => {
    expect(decidePerpResumeParity({
      ...BASE,
      storedSizeCoin: "0.120",
      sizeDecimals: 2,
    })).toMatchObject({ action: "resume", markPrice: "100" });
  });

  it("lets a lower current follow cap win over every higher staged value", () => {
    const decision = decidePerpResumeParity({
      ...POLICY_BASE,
      stagedUserMaxLeverage: 8,
      stagedFollowMaxLeverage: 7,
      currentUserMaxLeverage: 6,
      currentFollowMaxLeverage: 1,
      storedLeverage: 5,
    });
    expect(decision).toMatchObject({ action: "resume", leverage: 1 });
  });

  it("keeps a stored ceiling when staged and current policy values are raised", () => {
    const decision = decidePerpResumeParity({
      ...POLICY_BASE,
      stagedUserMaxLeverage: 20,
      stagedFollowMaxLeverage: 15,
      currentUserMaxLeverage: 30,
      currentFollowMaxLeverage: 25,
      storedLeverage: 3,
    });
    expect(decision).toMatchObject({ action: "resume", leverage: 3 });
  });
});
