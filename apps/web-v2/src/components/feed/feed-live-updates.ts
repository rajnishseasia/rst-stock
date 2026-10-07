/**
 * What the signal feed's 10s poll is allowed to cost, and what it is allowed to
 * do to the list under the reader's thumb (plan A12).
 *
 * Two separate problems, one cause: `signals.list` is an infinite query, and
 * React Query refetches EVERY loaded page on each interval tick. At the
 * 5-page auto-fetch cap that is five requests every ten seconds per viewer,
 * and each tick can silently prepend rows, shifting whatever the user was
 * reading down the screen.
 *
 * Background tabs are already handled upstream: React Query's focus manager
 * listens to `visibilitychange` and `refetchIntervalInBackground` defaults to
 * false, so an interval never fires while `document.visibilityState` is
 * "hidden". Nothing here needs to re-implement that.
 */

/** Cadence for a feed showing only page 1: the live-tape case. */
export const FEED_POLL_BASE_MS = 10_000;

/** Slowest cadence a deep feed drops to. */
export const FEED_POLL_MAX_MS = 60_000;

/**
 * Poll interval for a feed with `loadedPages` pages loaded.
 *
 * The budget being held constant is REQUESTS PER TICK, not ticks: one page at
 * 10s and five pages at 50s both cost about one request every ten seconds. A
 * reader who has paged 150 signals deep is reading history, not watching the
 * tape, and still has the refresh button and the new-signals pill.
 */
export function feedPollIntervalMs(loadedPages: number): number {
  const pages =
    Number.isFinite(loadedPages) && loadedPages > 1 ? Math.floor(loadedPages) : 1;
  return Math.min(FEED_POLL_MAX_MS, FEED_POLL_BASE_MS * pages);
}

/**
 * How many groups arrived above the one the reader has acknowledged as the top
 * of their list. `orderedKeys` is newest-first, matching the rendered order.
 *
 * An unknown key (the author filter changed, the venue narrowed, a group was
 * re-keyed) means the frontier no longer describes this list, so it reports
 * zero pending and the caller renders everything. Failing open is the right
 * failure: a stale frontier must never hide signals permanently.
 */
export function pendingSignalCount(
  orderedKeys: readonly string[],
  acknowledgedKey: string | null,
): number {
  if (!acknowledgedKey) return 0;
  const index = orderedKeys.indexOf(acknowledgedKey);
  return index < 0 ? 0 : index;
}

/** The groups the reader has actually accepted, newest-first. */
export function acknowledgedGroups<T>(
  groups: readonly T[],
  pending: number,
): T[] {
  if (pending <= 0) return [...groups];
  return groups.slice(pending);
}

/**
 * Distance from the top of the scroller, in pixels, within which new signals
 * are accepted automatically. Someone sitting at the top of the feed wants the
 * tape, not a button; the pill exists for someone who has scrolled away and
 * would otherwise have the page shift under them.
 */
export const FEED_AUTO_ACCEPT_SCROLL_PX = 24;

/**
 * The frontier key to store on this render, given the list the reader is
 * actually looking at.
 *
 * `pendingSignalCount` fails OPEN when the acknowledged key is missing, so no
 * signal is ever hidden by a stale frontier. But failing open is not the same as
 * recovering: a reader who is scrolled away and then narrows or mutes callers
 * can remove the very group their frontier points at, and a frontier that only
 * re-adopts at the top of the feed then stays invalid across every later poll.
 * Pending stays zero forever, so each matching signal is prepended UNDER the
 * reader instead of being held behind the new-signals pill, which is the jump
 * the pill exists to prevent.
 */
export function resolveAcknowledgedKey({
  orderedKeys,
  acknowledgedKey,
  atTopOfFeed,
}: {
  /** Rendered order, newest-first. */
  orderedKeys: readonly string[];
  acknowledgedKey: string | null;
  atTopOfFeed: boolean;
}): string | null {
  const headKey = orderedKeys[0] ?? null;
  // Nothing to point at yet: an empty list must not clear a frontier that a
  // later poll will still need.
  if (!headKey) return acknowledgedKey;
  if (acknowledgedKey === null) return headKey;
  // A reader at the top is looking at the head by definition.
  if (atTopOfFeed) return headKey;
  // The acknowledged group is gone from this list, so the frontier describes
  // nothing. Re-anchor on the current head rather than keep a dead key.
  if (!orderedKeys.includes(acknowledgedKey)) return headKey;
  return acknowledgedKey;
}

/**
 * Whether the feed should say it is having trouble rather than say the traders
 * have posted nothing.
 *
 * Two different failures read identically to someone looking at an empty list:
 *
 * 1. The request ANSWERED but the API could not reach its source, so it flags
 *    the page `degraded` (audit M13).
 * 2. The request FAILED outright, so there are no pages to carry a flag. This
 *    was the gap: `degraded` was false, the list was empty, and the feed
 *    rendered "No signals found yet", telling the reader that the people they
 *    follow had gone quiet when the truth was that we could not reach the API.
 */
export function isFeedUnavailable({
  requestFailed,
  pages,
}: {
  requestFailed: boolean;
  pages: ReadonlyArray<{ degraded?: boolean }> | null | undefined;
}): boolean {
  if (requestFailed) return true;
  return (pages ?? []).some((page) => page.degraded === true);
}
