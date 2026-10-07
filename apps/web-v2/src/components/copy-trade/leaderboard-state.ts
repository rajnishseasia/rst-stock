/**
 * Display-state decisions for leaderboard surfaces.
 *
 * These are deliberately pure. A missing row set can mean a healthy empty
 * window, a failed request, or a capped/degraded measurement, and those are
 * materially different claims to make in the UI.
 */

export interface LeaderboardStateInput {
  isSignedIn: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  rowCount: number;
  degraded: boolean;
}

export type LeaderboardDisplayState =
  | { kind: "signed_out"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "degraded"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready" };

export function describeLeaderboardState({
  isSignedIn,
  isLoading,
  isError,
  errorMessage,
  rowCount,
  degraded,
}: LeaderboardStateInput): LeaderboardDisplayState {
  if (!isSignedIn) {
    return { kind: "signed_out", message: "Sign in to see this leaderboard." };
  }
  if (isLoading) {
    return { kind: "loading", message: "Loading leaderboard." };
  }
  if (isError) {
    return {
      kind: "error",
      message: errorMessage ?? "Could not load the leaderboard. Try again.",
    };
  }
  if (degraded && rowCount === 0) {
    return {
      kind: "degraded",
      message: "The leaderboard is incomplete or temporarily unavailable.",
    };
  }
  if (rowCount === 0) {
    return {
      kind: "empty",
      message: "No calls are available in this window yet.",
    };
  }
  return { kind: "ready" };
}
export interface ProfileStateInput {
  isSignedIn: boolean;
  isLoading: boolean;
  errorCode: string | null;
  hasProfile: boolean;
  callCount: number;
}

export type ProfileDisplayState =
  | { kind: "signed_out"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready" };

export function describeProfileState({
  isSignedIn,
  isLoading,
  errorCode,
  hasProfile,
  callCount,
}: ProfileStateInput): ProfileDisplayState {
  if (!isSignedIn) {
    return { kind: "signed_out", message: "Sign in to inspect caller history." };
  }
  if (isLoading) {
    return { kind: "loading", message: "Loading caller profile." };
  }
  if (errorCode !== null && errorCode !== "NOT_FOUND") {
    return {
      kind: "error",
      message: "Could not load this caller profile. Try again.",
    };
  }
  if (errorCode === "NOT_FOUND" || !hasProfile) {
    return { kind: "not_found", message: "Caller profile not found." };
  }
  if (callCount === 0) {
    return {
      kind: "empty",
      message: "No calls are available for this profile in this window yet.",
    };
  }
  return { kind: "ready" };
}
