/**
 * Plan A11 - what the pinned "you" row on the users leaderboard says.
 *
 * Pure, so the honest-copy decisions below are testable without rendering the
 * board or reaching a database. Nothing here touches order construction.
 *
 * Why the row exists at all: `leaderboard.users` returns rows anonymized by
 * `anonymizeTrader()` (e.g. "SwiftFalcon412") and pages at 25, so a signed-in
 * user cannot locate themselves on the board by name OR by scrolling. The
 * pinned row is the only way they see their own standing.
 *
 * Why it has four states: "you are rank 12", "you are ranked but deeper than
 * the board tracks", and "you have no shared trades in this window" are three
 * genuinely different facts, and the users board is built from SHARED trades
 * only, so the third is the common case and must not read as "you lost".
 */

import type { UserRow, UserSelfStanding } from "./use-leaderboard-view";

export type SelfStandingPresentation =
  /** Nothing to pin: signed out, still loading, or the query has no answer. */
  | { kind: "hidden" }
  /** On the board, at a real 1-based rank. */
  | { kind: "ranked"; rank: number; row: UserRow }
  /** Ranked, but past the depth the server retains for the lookup. */
  | { kind: "below-cap"; note: string }
  /** Not on the board at all: no closed, shared lots in this window. */
  | { kind: "unranked"; note: string }
  /**
   * The server could not determine membership: the board is larger than the
   * bounded key set used to answer the question, and this caller was past it.
   */
  | { kind: "unknown"; note: string };

export function describeSelfStanding(input: {
  isSignedIn: boolean;
  isLoading: boolean;
  me: UserSelfStanding | null | undefined;
  degraded?: boolean;
  measurement?: { complete: boolean; horizonLabel: string } | null;
}): SelfStandingPresentation {
  // The tab already renders a sign-in prompt and a skeleton; a second placeholder
  // pinned above them would just be noise.
  if (!input.isSignedIn || input.isLoading || !input.me) return { kind: "hidden" };

  if (input.degraded) {
    return {
      kind: "unknown",
      note: "Leaderboard data is temporarily unavailable, so your standing is unknown.",
    };
  }

  const { row, rank, belowRankCap, standingUnknown, rankCap } = input.me;
  if (row && rank != null) return { kind: "ranked", rank, row };

  // Checked BEFORE the unranked fallback, which is a claim about the user's
  // ACTIVITY ("you have no closed shared trades"). We must not make it on a
  // board too large for the membership lookup to answer.
  if (standingUnknown) {
    return {
      kind: "unknown",
      note: input.measurement && !input.measurement.complete
        ? `This standing is unknown because the board only measured ${input.measurement.horizonLabel}.`
        : `This board is deeper than the top ${rankCap} it can look up, so your standing is not available here.`,
    };
  }

  if (belowRankCap) {
    return {
      kind: "below-cap",
      note: `You are ranked outside the top ${rankCap} this board tracks.`,
    };
  }

  return {
    kind: "unranked",
    // Deliberately states the CAUSE. This board is reconstructed from shared
    // trades, so an unshared, profitable account legitimately shows nothing
    // here, and "no trades yet" alone would read as an accusation.
    note: "You have no closed shared trades in this window yet. Share a trade to appear here.",
  };
}

/**
 * The caller's own row key, so a caller who IS inside the rendered page is
 * marked in the list as well as pinned above it. Without this the same person
 * appears twice with no indication that both rows are them, and the in-list
 * copy still carries a Follow button pointed at their own traderKey.
 */
export function selfRowKey(me: UserSelfStanding | null | undefined): string | null {
  return me?.row?.followTarget.key ?? null;
}
