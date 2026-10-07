import { describe, expect, test } from "bun:test";

import { describeSelfStanding, selfRowKey } from "./leaderboard-self";
import type { UserRow, UserSelfStanding } from "./use-leaderboard-view";

const OWN_ROW: UserRow = {
  followTarget: { type: "user", key: "own-key", label: "SwiftFalcon412" },
  displayName: "SwiftFalcon412",
  avatar: "",
  realizedPnl: 1234.5,
  alpacaPnl: 1234.5,
  hyperliquidPnl: 0,
  winRate: 0.62,
  tradeCount: 21,
  lastTradeAt: null,
  hasHyperliquid: false,
};

function standing(overrides: Partial<UserSelfStanding> = {}): UserSelfStanding {
  return {
    row: null,
    rank: null,
    belowRankCap: false,
    standingUnknown: false,
    rankCap: 500,
    ...overrides,
  };
}

describe("describeSelfStanding", () => {
  test("pins the caller's own ranked row", () => {
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ row: OWN_ROW, rank: 12 }),
    });

    expect(presentation.kind).toBe("ranked");
    if (presentation.kind !== "ranked") throw new Error("expected ranked");
    expect(presentation.rank).toBe(12);
    expect(presentation.row.displayName).toBe("SwiftFalcon412");
  });

  test("says WHY an unranked user is unranked, without implying a loss", () => {
    // The users board is reconstructed from SHARED trades only, so a profitable
    // account that never shared shows nothing here. This is the common case and
    // the plan calls it out explicitly.
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing(),
    });

    expect(presentation.kind).toBe("unranked");
    if (presentation.kind !== "unranked") throw new Error("expected unranked");
    expect(presentation.note).toContain("shared");
  });

  test("distinguishes 'ranked but deep' from 'not ranked'", () => {
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ belowRankCap: true, rankCap: 500 }),
    });

    expect(presentation.kind).toBe("below-cap");
    if (presentation.kind !== "below-cap") throw new Error("expected below-cap");
    // The depth comes from the server so the copy cannot drift from the number
    // the lookup actually used.
    expect(presentation.note).toContain("500");
  });

  test("pins nothing while loading, signed out, or with no answer", () => {
    expect(
      describeSelfStanding({ isSignedIn: false, isLoading: false, me: standing() }).kind,
    ).toBe("hidden");
    expect(
      describeSelfStanding({ isSignedIn: true, isLoading: true, me: standing() }).kind,
    ).toBe("hidden");
    expect(
      describeSelfStanding({ isSignedIn: true, isLoading: false, me: null }).kind,
    ).toBe("hidden");
  });

  test("treats a rank of 1 as ranked, never as falsy-absent", () => {
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ row: OWN_ROW, rank: 1 }),
    });

    expect(presentation.kind).toBe("ranked");
  });
});

describe("selfRowKey", () => {
  test("exposes the caller's key so their in-list row can be marked too", () => {
    expect(selfRowKey(standing({ row: OWN_ROW, rank: 3 }))).toBe("own-key");
  });

  test("is null when the caller is not on the board", () => {
    expect(selfRowKey(standing())).toBeNull();
    expect(selfRowKey(null)).toBeNull();
    expect(selfRowKey(undefined)).toBeNull();
  });
});

describe("an unanswerable standing is not 'you have no trades'", () => {
  test("unknown membership says so, instead of claiming no shared trades", () => {
    // The board's membership key set is bounded, so a caller past that bound
    // might be ranked deep or might not be ranked at all. Reporting the second
    // told users with real shared trades that they had none, which is a claim
    // about their activity the server cannot support.
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ standingUnknown: true }),
    });

    expect(presentation.kind).toBe("unknown");
    const note = presentation.kind === "unknown" ? presentation.note : "";
    expect(note).not.toContain("no closed shared trades");
  });

  test("bounded All history says the standing is outside the measured horizon", () => {
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ standingUnknown: true }),
      measurement: {
        complete: false,
        horizonLabel: "the newest 365 days",
      },
    });

    expect(presentation.kind).toBe("unknown");
    if (presentation.kind !== "unknown") throw new Error("expected unknown");
    expect(presentation.note).toContain("newest 365 days");
    expect(presentation.note).not.toContain("no closed shared trades");
  });

  test("unknown outranks the unranked fallback", () => {
    // Order matters: `unranked` is the claim we must not make by accident.
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ standingUnknown: true, belowRankCap: false }),
    });
    expect(presentation.kind).not.toBe("unranked");
  });

  test("a genuinely unranked caller still gets the honest cause", () => {
    // The real case has to survive: this board is built from SHARED trades, so
    // an unshared profitable account legitimately shows nothing.
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      me: standing({ standingUnknown: false }),
    });
    expect(presentation.kind).toBe("unranked");
  });

  test("degraded data keeps self-standing unknown even when the payload is empty", () => {
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      degraded: true,
      me: standing({ standingUnknown: false }),
    });

    expect(presentation.kind).toBe("unknown");
    if (presentation.kind !== "unknown") throw new Error("expected unknown");
    expect(presentation.note).toContain("temporarily unavailable");
    expect(presentation.note).not.toContain("no closed shared trades");
  });

  test("unavailable data with stale query data keeps self-standing unknown", () => {
    const presentation = describeSelfStanding({
      isSignedIn: true,
      isLoading: false,
      degraded: true,
      me: standing({ row: OWN_ROW, rank: 4 }),
    });

    expect(presentation.kind).toBe("unknown");
  });
});
