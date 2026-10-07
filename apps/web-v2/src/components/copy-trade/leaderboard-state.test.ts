import { describe, expect, test } from "bun:test";

import {
  describeLeaderboardState,
  describeProfileState,
} from "./leaderboard-state";

describe("leaderboard display state", () => {
  const base = {
    isSignedIn: true,
    isLoading: false,
    isError: false,
    errorMessage: null,
    rowCount: 0,
    degraded: false,
  };

  test("keeps an API error distinct from a healthy empty result", () => {
    expect(
      describeLeaderboardState({
        ...base,
        isError: true,
        errorMessage: "API unavailable",
      }),
    ).toMatchObject({ kind: "error", message: "API unavailable" });
    expect(describeLeaderboardState(base)).toMatchObject({
      kind: "empty",
      message: "No calls are available in this window yet.",
    });
  });

  test("keeps a degraded empty result distinct from no activity", () => {
    expect(
      describeLeaderboardState({ ...base, degraded: true }),
    ).toMatchObject({
      kind: "degraded",
      message: "The leaderboard is incomplete or temporarily unavailable.",
    });
  });

  test("loading and signed-out states take precedence over row counts", () => {
    expect(
      describeLeaderboardState({ ...base, isSignedIn: false, rowCount: 5 }),
    ).toMatchObject({ kind: "signed_out" });
    expect(
      describeLeaderboardState({ ...base, isLoading: true, rowCount: 5 }),
    ).toMatchObject({ kind: "loading" });
  });
});

describe("caller profile display state", () => {
  const base = {
    isSignedIn: true,
    isLoading: false,
    errorCode: null,
    hasProfile: false,
    callCount: 0,
  };

  test("distinguishes not-found, API error, and empty profile data", () => {
    expect(describeProfileState({ ...base, errorCode: "NOT_FOUND" })).toEqual({
      kind: "not_found",
      message: "Caller profile not found.",
    });
    expect(describeProfileState({ ...base, errorCode: "UNKNOWN_ERROR" })).toEqual({
      kind: "error",
      message: "Could not load this caller profile. Try again.",
    });
    expect(describeProfileState({ ...base, hasProfile: true })).toEqual({
      kind: "empty",
      message: "No calls are available for this profile in this window yet.",
    });
  });

  test("does not turn a non-empty profile into a missing state", () => {
    expect(
      describeProfileState({ ...base, hasProfile: true, callCount: 2 }),
    ).toEqual({ kind: "ready" });
  });
});
