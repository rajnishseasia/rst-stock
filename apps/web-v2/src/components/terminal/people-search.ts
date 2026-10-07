/**
 * Plan S3, the People half. Search the CALLERS, not just the markets.
 *
 * Bullpen's equivalent tab is Wallets: type an address, see what it holds. Ours
 * is People: type a name, see who they are and what their calls have actually
 * done. That is the asymmetry the whole product rests on, and it belongs on the
 * search screen because "who is this person everyone keeps quoting" is a search.
 *
 * SCOPE, stated honestly because the UI has to state it too: this searches the
 * callers the X-caller leaderboard already ranks for the last 30 days, capped at
 * `PEOPLE_SEARCH_UNIVERSE`. It is not a directory of everyone who has ever
 * posted. The empty state says so rather than implying the person does not
 * exist.
 *
 * PURE. No React, no IO.
 */

/**
 * How many callers the People tab searches over. The leaderboard procedure caps
 * `limit` at 100, and one server-cached page is the entire cost of this tab.
 */
export const PEOPLE_SEARCH_UNIVERSE = 100;

/** Rows per People result list, so the surface stays scrollable to the end. */
export const PEOPLE_SEARCH_ROWS = 20;

/** The subset of an X-caller leaderboard row this module ranks. */
export interface PeopleSearchCandidate {
  displayName: string;
  callCount: number;
}

/**
 * Callers whose display name matches the query, best match first.
 *
 * Ranking, in order: a prefix match beats a substring match (typing "sha" should
 * surface "Shardi" above "Alpha Signals"), then call volume descending, then
 * alphabetical so the order is deterministic in a test and stable on screen.
 *
 * An empty query returns the whole universe in the order the server ranked it,
 * which is the browse state: the most active callers of the last 30 days.
 */
export function matchCallers<T extends PeopleSearchCandidate>(
  callers: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...callers];

  const scored: Array<{ caller: T; rank: number }> = [];
  for (const caller of callers) {
    const name = caller.displayName.trim().toLowerCase();
    if (!name) continue;
    const at = name.indexOf(needle);
    if (at === -1) continue;
    scored.push({ caller, rank: at === 0 ? 0 : 1 });
  }

  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.caller.callCount - a.caller.callCount ||
        a.caller.displayName.localeCompare(b.caller.displayName),
    )
    .map((entry) => entry.caller);
}

/** What the People tab says when it has no rows to show. */
export type PeopleSearchNotice =
  | { kind: "rows" }
  | { kind: "notice"; message: string };

/**
 * The People tab's state as a single decision, so the four reasons the list can
 * be empty stay distinguishable. "No results" for a signed-out user, a loading
 * query, an empty universe and a genuine miss are four different facts, and only
 * one of them is about the person being searched for.
 */
export function describePeopleSearch({
  isSignedIn,
  isLoading,
  hasError = false,
  query,
  universeSize,
  matchCount,
}: {
  isSignedIn: boolean;
  isLoading: boolean;
  /**
   * The caller-universe query failed. Distinct from an empty universe: with
   * `retry: false` a failed query settles with no rows and `isLoading` false,
   * which is indistinguishable from a real empty result unless it is passed in.
   */
  hasError?: boolean;
  query: string;
  /** How many callers the leaderboard returned to search over. */
  universeSize: number;
  matchCount: number;
}): PeopleSearchNotice {
  if (!isSignedIn) {
    return { kind: "notice", message: "Sign in to search callers." };
  }
  if (isLoading) {
    return { kind: "notice", message: "Loading callers…" };
  }
  // Checked BEFORE the empty-universe branch. A failed request tells us nothing
  // about who has been posting, and "no callers have posted in 30 days" is a
  // claim about the whole platform that an outage does not license.
  if (hasError) {
    return {
      kind: "notice",
      message: "Could not load callers just now. Try again in a moment.",
    };
  }
  if (universeSize === 0) {
    return {
      kind: "notice",
      message: "No callers have posted in the last 30 days yet.",
    };
  }
  if (matchCount === 0) {
    const trimmed = query.trim();
    // Name the SCOPE. "No callers found" invites the reader to conclude the
    // person is not on the platform, when the truth is that this tab searches
    // the recently active ones.
    return {
      kind: "notice",
      message: trimmed
        ? `No match for "${trimmed}" among the ${universeSize} callers active in the last 30 days.`
        : "No callers to show.",
    };
  }
  return { kind: "rows" };
}

/**
 * The one-line record under a caller's name in the results.
 *
 * Never renders a bare "-" where a percentage goes: an unmeasured caller and a
 * caller who lost money must not look the same in a list someone is about to
 * pick a person to follow from.
 */
export function describeCallerSummary({
  callCount,
  measuredCallCount,
  hitRate,
  horizonDays,
}: {
  callCount: number;
  measuredCallCount: number;
  hitRate: number | null;
  horizonDays: number;
}): string {
  const calls = callCount === 1 ? "1 call" : `${callCount} calls`;
  if (measuredCallCount === 0 || hitRate === null || !Number.isFinite(hitRate)) {
    return `${calls} in 30d · not yet measured`;
  }
  return `${calls} in 30d · ${Math.round(hitRate * 100)}% hit rate at ${horizonDays}D`;
}
