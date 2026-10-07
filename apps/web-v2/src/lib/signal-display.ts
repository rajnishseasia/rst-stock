/**
 * Shared display helpers for X / Discord signals, used by BOTH the X Signals
 * feed (components/feed/signal-feed.tsx) and the TradingView chart signal
 * markers (components/charts/tv-datafeed.ts) so author names and tweet bodies
 * render identically on both surfaces.
 *
 * All helpers are pure and framework-free so they can be unit tested directly.
 */

/** Max "Copy $TICKER" chips rendered per tweet card (doc #4). */
export const MAX_TICKER_CHIPS = 3;

/**
 * Caps a tweet's ticker chips at MAX_TICKER_CHIPS. A single tweet can mention a
 * dozen-plus tickers (an INTC signal once carried 14), and rendering a chip for
 * every one floods the card, so we keep only the first few and drop the rest.
 */
export function capTickerChips<T>(tickers: readonly T[]): T[] {
  return tickers.slice(0, MAX_TICKER_CHIPS);
}

// Bullet, middle dot, pipe, en dash, em dash. Kept as escapes so the source
// stays ASCII and carries no literal em dash character. These are unambiguous
// relay separators, so they need no surrounding whitespace to count.
const SEPARATORS = "\\u2022\\u00b7|\\u2013\\u2014";

const SEP_BEFORE = new RegExp(`\\s*[${SEPARATORS}]\\s*tweetshift\\b`, "gi");
const SEP_AFTER = new RegExp(`\\btweetshift\\b\\s*[${SEPARATORS}]\\s*`, "gi");
// A plain hyphen is only a separator when whitespace sets it apart
// ("Serenity - TweetShift"). Without that, it is part of a real word
// ("non-TweetShift tools"), which must survive.
const HYPHEN_BEFORE = /\s+-\s*tweetshift\b/gi;
const HYPHEN_AFTER = /\btweetshift\b\s*-\s+/gi;
// Only at the very start / end of the string, where a relay label actually sits.
const EDGE_TOKEN = /^\s*tweetshift\b\s*|\s*\btweetshift\s*$/gi;
// Anywhere in the string. Author-only: in a tweet body this would maul real
// content (a "tweetshift.com" URL, or a sentence that mentions the tool).
const BARE_TOKEN = /\s*\btweetshift\b\s*/gi;

/**
 * Removes the literal "TweetShift" relay label from a string. The Discord relay
 * leaks the label into the author field ("Serenity {sep} TweetShift") and,
 * occasionally, the tweet body, so both surfaces run their strings through this.
 * A separator glued to the label is consumed with it.
 *
 * By default only separator-glued and string-edge occurrences are removed, which
 * is safe for tweet BODIES: an unanchored strip turned
 * "Relayed via https://tweetshift.com/docs" into "Relayed via https:// .com/docs"
 * and "non-TweetShift tools" into "non tools". Pass `{ anywhere: true }` for
 * author names, where any occurrence is the relay label rather than content.
 */
export function stripTweetShift(
  text: string,
  options?: { anywhere?: boolean },
): string {
  if (typeof text !== "string") return text;
  const stripped = text
    .replace(SEP_BEFORE, "")
    .replace(SEP_AFTER, "")
    .replace(HYPHEN_BEFORE, "")
    .replace(HYPHEN_AFTER, "")
    .replace(EDGE_TOKEN, " ");
  return (options?.anywhere ? stripped.replace(BARE_TOKEN, " ") : stripped).trim();
}

/** True when the author name is a "Don't follow Shardi ..." variant. */
function isShardiVariant(name: string): boolean {
  // Normalize curly / back apostrophes to a straight one before matching.
  const normalized = name.replace(/[‘’`´]/g, "'");
  // Allow leading non-letter junk (emoji, quotes, spaces): X display names
  // routinely carry a leading emoji, e.g. "(rocket) Don't Follow Shardi B ...".
  return /^[^a-z]*don'?t\s+follow\s+shardi\b/i.test(normalized);
}

/**
 * Canonical author display name shared by the feed and the chart:
 *   - strips the "TweetShift" relay label, then
 *   - collapses every "Don't Follow Shardi B If You Hate Money" variant to just
 *     "Shardi".
 * Falls back to the trimmed original if stripping empties the string out.
 */
export function normalizeAuthorName(name: string): string {
  if (typeof name !== "string") return name;
  if (isShardiVariant(name)) return "Shardi";
  // Author names: strip the label wherever it appears.
  const stripped = stripTweetShift(name, { anywhere: true });
  if (isShardiVariant(stripped)) return "Shardi";
  return stripped || name.trim() || name;
}
