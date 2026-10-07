import { describe, expect, test } from "bun:test";

import { equityCtaLabel, type EquityCtaState } from "./equity-cta-label";

const ready: EquityCtaState = {
  isSignedIn: true,
  credentialsKnown: true,
  hasCredentials: true,
  hasActiveAccount: true,
  isSubmitting: false,
  actionLabel: "Review buy",
};

describe("equityCtaLabel", () => {
  test("uses the ticket's own action label when nothing blocks it", () => {
    expect(equityCtaLabel(ready)).toBe("Review buy");
    expect(equityCtaLabel({ ...ready, actionLabel: "Review sell + auto-exit" })).toBe(
      "Review sell + auto-exit",
    );
  });

  test("names sign-in before anything else", () => {
    expect(
      equityCtaLabel({
        ...ready,
        isSignedIn: false,
        credentialsKnown: true,
        hasCredentials: false,
        hasActiveAccount: false,
      }),
    ).toBe("Sign in to Trade");
  });

  test("names the missing broker instead of pretending to submit", () => {
    expect(
      equityCtaLabel({ ...ready, hasCredentials: false, hasActiveAccount: false }),
    ).toBe("Connect Broker to Trade");
  });

  test("names account selection once credentials exist", () => {
    expect(equityCtaLabel({ ...ready, hasActiveAccount: false })).toBe(
      "Select an Account to Trade",
    );
  });

  test("does not accuse the user while the credentials query is in flight", () => {
    // A cold mount has credentialsKnown=false and hasCredentials=false. Reading
    // that as "no broker" would flash a false blocker at every signed-in user.
    expect(
      equityCtaLabel({
        ...ready,
        credentialsKnown: false,
        hasCredentials: false,
        hasActiveAccount: false,
      }),
    ).toBe("Review buy");
  });

  test("reports an in-flight submit", () => {
    expect(equityCtaLabel({ ...ready, isSubmitting: true })).toBe("Submitting...");
  });

  test("a blocker outranks the in-flight state", () => {
    // A blocked ticket cannot be mid-submit; if both are somehow true the user
    // needs the actionable half.
    expect(
      equityCtaLabel({ ...ready, hasCredentials: false, isSubmitting: true }),
    ).toBe("Connect Broker to Trade");
  });
});
