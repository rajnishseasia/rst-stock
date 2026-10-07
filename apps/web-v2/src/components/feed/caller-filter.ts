/**
 * Plan S2. The feed's author filter, as a model rather than a set.
 *
 * Before this it was hide-only: a Set of hidden author names, surfaced as 28px
 * checkbox rows inside a dropdown that scrolled inside a scroller. There was no
 * way to say "only this caller", which is the thing you actually want after
 * reading one good call, and no way to mute from the row you are reading.
 *
 * The model has two mutually exclusive modes because they answer different
 * questions and cannot be composed coherently:
 *
 *   - `hide`: show everyone EXCEPT these names. Open by default, so a caller who
 *     starts posting tomorrow shows up without the user doing anything.
 *   - `only`: show ONE name. Closed by default, so a caller who starts posting
 *     tomorrow does NOT leak in. Expressing this as "hide everyone else" would
 *     silently break the moment a new author appears, which is the bug that made
 *     the naive version unshippable.
 *
 * PURE. No React, no localStorage access (the serializers here are string in /
 * string out so the storage effect stays a two-liner in the component).
 */

/** Show everyone except `hidden`, or show exactly one caller. */
export type CallerFilter =
  | { mode: "hide"; hidden: ReadonlySet<string> }
  | { mode: "only"; author: string };

/** The open, nothing-filtered starting state. */
export const NO_CALLER_FILTER: CallerFilter = {
  mode: "hide",
  hidden: new Set<string>(),
};

/** Apply the filter to feed rows. The only place the two modes are compared. */
export function applyCallerFilter<T extends { authorName: string }>(
  signals: readonly T[],
  filter: CallerFilter,
): T[] {
  if (filter.mode === "only") {
    return signals.filter((signal) => signal.authorName === filter.author);
  }
  return signals.filter((signal) => !filter.hidden.has(signal.authorName));
}

/** Whether this author is currently visible under the filter. */
export function isAuthorVisible(filter: CallerFilter, author: string): boolean {
  return filter.mode === "only"
    ? filter.author === author
    : !filter.hidden.has(author);
}

/** Whether the feed is currently narrowed to exactly this author. */
export function isOnlyAuthor(filter: CallerFilter, author: string): boolean {
  return filter.mode === "only" && filter.author === author;
}

/** True when the filter is doing nothing, so the UI can hide the reset. */
export function isCallerFilterEmpty(filter: CallerFilter): boolean {
  return filter.mode === "hide" && filter.hidden.size === 0;
}

/**
 * Toggle one author's hidden state. From `only` mode this returns to the open
 * `hide` mode: "mute Alice" while narrowed to Alice means "stop showing me only
 * Alice", not "narrow to Alice and also hide her", which would be an empty feed
 * with no visible cause.
 */
export function toggleHiddenAuthor(
  filter: CallerFilter,
  author: string,
): CallerFilter {
  if (filter.mode === "only") {
    return filter.author === author
      ? { mode: "hide", hidden: new Set([author]) }
      : { mode: "hide", hidden: new Set<string>() };
  }
  const hidden = new Set(filter.hidden);
  if (hidden.has(author)) hidden.delete(author);
  else hidden.add(author);
  return { mode: "hide", hidden };
}

/** Narrow the feed to one caller. Tapping the caller already narrowed to
 *  releases the narrowing, so the same control is its own undo. */
export function toggleOnlyAuthor(
  filter: CallerFilter,
  author: string,
): CallerFilter {
  return isOnlyAuthor(filter, author)
    ? NO_CALLER_FILTER
    : { mode: "only", author };
}

/** Clear everything: every caller visible again. */
export function clearCallerFilter(): CallerFilter {
  return NO_CALLER_FILTER;
}

/**
 * The one-line status shown above the feed, or null when the filter is doing
 * nothing. It names the CAUSE, because an empty or short feed with no stated
 * reason reads as "the product is broken".
 */
export function describeCallerFilter(filter: CallerFilter): string | null {
  if (filter.mode === "only") return `Showing only ${filter.author}`;
  const count = filter.hidden.size;
  if (count === 0) return null;
  return count === 1
    ? "1 caller muted"
    : `${count} callers muted`;
}

/** Action label for the mute control on a caller. */
export function muteActionLabel(filter: CallerFilter, author: string): string {
  return isAuthorVisible(filter, author)
    ? `Mute ${author}`
    : `Unmute ${author}`;
}

/** Action label for the narrow control on a caller. */
export function onlyActionLabel(filter: CallerFilter, author: string): string {
  return isOnlyAuthor(filter, author)
    ? "Show all callers"
    : `Only show ${author}`;
}

// ---------------------------------------------------------------------------
// Persistence (string in / string out, so the effect that touches localStorage
// stays trivial and this stays testable)
// ---------------------------------------------------------------------------

/** Serialized shape written to localStorage. */
interface StoredCallerFilter {
  mode?: unknown;
  hidden?: unknown;
  author?: unknown;
}

export function serializeCallerFilter(filter: CallerFilter): string {
  return filter.mode === "only"
    ? JSON.stringify({ mode: "only", author: filter.author })
    : JSON.stringify({ mode: "hide", hidden: [...filter.hidden] });
}

/**
 * Parse a stored filter, tolerating the LEGACY shape: the previous release
 * wrote a bare `string[]` of hidden names under the same key. Someone with
 * callers already muted must not silently get them all back, so a plain array
 * is read as hide-mode. Anything unparseable falls back to the open state.
 */
export function parseCallerFilter(raw: string | null): CallerFilter {
  if (!raw) return NO_CALLER_FILTER;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_CALLER_FILTER;
  }

  if (Array.isArray(parsed)) {
    return { mode: "hide", hidden: new Set(parsed.filter(isNonEmptyString)) };
  }
  if (!parsed || typeof parsed !== "object") return NO_CALLER_FILTER;

  const value = parsed as StoredCallerFilter;
  if (value.mode === "only" && isNonEmptyString(value.author)) {
    return { mode: "only", author: value.author };
  }
  if (Array.isArray(value.hidden)) {
    return { mode: "hide", hidden: new Set(value.hidden.filter(isNonEmptyString)) };
  }
  return NO_CALLER_FILTER;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
