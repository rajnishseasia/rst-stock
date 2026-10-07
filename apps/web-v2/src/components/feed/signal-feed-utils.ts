import {
  normalizeAuthorName,
  stripTweetShift,
} from "@/lib/signal-display";
import {
  readCanonicalAuthorForSource,
  sourceAuthorAliasKey,
} from "@trade-bot/utils";

export interface SignalDisplayMetadata {
  authorName: string;
  authorAvatar: string | null;
  imageUrl: string | null;
  /**
   * Plan S2. The server's follow / leaderboard key for this author, or null when
   * the row has no attributable author. NOT derived from `authorName`: see
   * `signalAuthorKey`.
   */
  authorKey: string | null;
}

/**
 * Canonical author display name. Delegates to the shared normalizer so the feed
 * and the chart signal markers agree: it strips the "TweetShift" relay label and
 * renames the "Don't Follow Shardi ..." variants to just "Shardi".
 */
export function cleanAuthorName(name: string): string {
  return normalizeAuthorName(name);
}

/**
 * Plan S2. The key the SERVER uses to identify this author, derived from the RAW
 * stored name.
 *
 * This deliberately does NOT reuse `cleanAuthorName` above. The display name is
 * allowed to be friendlier than the key: `normalizeAuthorName` strips the
 * TweetShift relay label wherever it appears and renames the "Don't Follow
 * Shardi ..." variants to just "Shardi". The server does neither. Its key is
 * `normalizeAuthorKey(cleanAuthorName(raw))` where `cleanAuthorName` strips only
 * a TRAILING TweetShift suffix (apps/api/src/lib/trader-identity.ts:88), and the
 * `xCallerProfile` lookup compares against exactly that expression in SQL
 * (leaderboard.ts:403).
 *
 * So keying off the display name would 404 the caller sheet for every Shardi
 * variant, and worse, would write a Follow row under a key no feed item ever
 * matches: a follow that silently never fires.
 *
 * Mirror of the server rules, in order: strip a trailing TweetShift suffix,
 * collapse whitespace, trim, lowercase. "unknown" and empty are not authors.
 */
export function signalAuthorKey(rawAuthorName: unknown): string | null {
  if (typeof rawAuthorName !== "string") return null;
  const withoutRelay = rawAuthorName
    .replace(/\s*[•·|–-]\s*TweetShift\s*$/i, "")
    .trim();
  const source = withoutRelay || rawAuthorName;
  const normalized = source.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || normalized === "unknown") return null;
  return normalized;
}

/** A populated batch result is not enough to prove stock availability because
 * failed snapshot lookups are represented by zero-valued placeholder quotes. */
export function hasValidStockQuote(
  quote: { last?: string | null } | undefined,
): boolean {
  const last = Number(quote?.last);
  return Number.isFinite(last) && last > 0;
}

export function normalizeSignalContent(content: string): string {
  // Mirror the worker's stripLeadingTweeted so legacy rows ingested before that
  // existed render identically: consume the whole leading "Tweeted" label
  // regardless of how many spaces/colons follow it. Then strip any leaked
  // "TweetShift" relay label from the body (doc #9a).
  const withoutTweeted = content.replace(/^tweeted\b[\s:]*/i, "");
  return stripTweetShift(withoutTweeted);
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

export function parseSignalMetadata(
  metadata: unknown,
  source?: string | null,
): SignalDisplayMetadata {
  try {
    const parsed =
      typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid signal metadata");
    }

    const value = parsed as Record<string, unknown>;
    const canonicalAuthor = readCanonicalAuthorForSource(value, source);
    const rawAuthorName = canonicalAuthor.authorName !== "Unknown"
      ? canonicalAuthor.authorName
      : null;
    const authorName = rawAuthorName ? cleanAuthorName(rawAuthorName) : "Unknown";
    // Prefer the server-issued immutable key. Legacy rows still use the exact
    // normalized-name compatibility key until the API can safely resolve them.
    const authorKey = canonicalAuthor.identityKind === "relay"
      ? null
      : canonicalAuthor.canonicalAuthorKey
        ? canonicalAuthor.canonicalAuthorKey
        : rawAuthorName
          ? canonicalAuthor.source ?? source
            ? sourceAuthorAliasKey(
                canonicalAuthor.source ?? source,
                signalAuthorKey(rawAuthorName),
              )
            : signalAuthorKey(rawAuthorName)
          : null;
    const authorAvatar =
      typeof value.authorAvatar === "string" && value.authorAvatar.trim()
        ? value.authorAvatar
        : null;
    const imageUrl = normalizeHttpUrl(value.imageUrl);

    return { authorName, authorAvatar, imageUrl, authorKey };
  } catch {
    return {
      authorName: "Unknown",
      authorAvatar: null,
      imageUrl: null,
      authorKey: null,
    };
  }
}

/**
 * Whether a signal's `url` identifies ONE upstream post, so it can be used to
 * group the several ticker rows the ingest writes per post.
 *
 * A site-root URL cannot: the paste.trade poller stamps every row with the same
 * board root (`https://paste.trade`), so grouping on it collapsed every
 * paste.trade signal, from every author, into a single card that showed the
 * first-loaded row's author and thesis while accumulating everyone else's coin
 * chips (and dropped duplicate symbols entirely). Only a URL with a real path
 * or query is post-specific.
 */
export function isPostSpecificUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    return path.length > 0 || parsed.search.length > 0;
  } catch {
    // Not a parseable absolute URL. Treat a non-empty value as specific only if
    // it carries a path separator beyond a bare host.
    const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, "");
    const slash = withoutScheme.indexOf("/");
    return slash >= 0 && withoutScheme.slice(slash + 1).replace(/\/+$/, "").length > 0;
  }
}

/**
 * Grouping key that collapses the per-ticker rows of ONE upstream post into one
 * feed card. Prefers the post URL when it is post-specific; otherwise falls back
 * to timestamp + author + content, which distinguishes separate posts that share
 * a site-root URL.
 */
export function signalGroupKey(signal: {
  url?: string | null;
  timestamp: string | number | Date;
  authorName: string;
  content: string;
}): string {
  if (isPostSpecificUrl(signal.url)) return `url::${signal.url}`;
  const iso = new Date(signal.timestamp).toISOString();
  return `fallback::${iso}::${signal.authorName}::${signal.content}`;
}

/**
 * The same URL, but only when it is SAFE TO LINK: an absolute http(s) URL that
 * identifies one post. Returns null otherwise.
 *
 * Deliberately stricter than `isPostSpecificUrl`, and deliberately separate
 * from it. That predicate answers "is this a distinct post IDENTITY", used for
 * grouping, where a lenient fallback for an unparseable value is fine because
 * nothing is rendered from it. This one answers "may this externally ingested
 * string go into an href", where leniency is not fine: `mailto:user@example.com`
 * and `data:text/html,...` both have a path and would have passed, and a
 * relative `/post/1` would have pointed at our own app while claiming to be the
 * caller's original site.
 *
 * Mirrors `postSpecificHttpUrl` in the leaderboard router, which already
 * required an absolute http(s) URL for exactly this reason.
 */
export function safeExternalPostUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    // No base: a relative URL must FAIL here rather than resolve against the
    // current page, which is how "/post/1" would have become an app link
    // presented as the caller's source.
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname.toLowerCase().replace(/\.$/, "") === "paste.trade") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return path.length > 0 || parsed.search.length > 0 ? trimmed : null;
}

/**
 * The feed card's sizing contract, kept as a pure function so it is testable
 * without rendering the feed.
 *
 *  - Terminal panel: a fixed 600px card, or natural height while collapsed.
 *  - Embedded and bounded (the desktop drawer, the phone chart screen's feed
 *    box): `h-full min-h-0` fills whatever box the parent gives it and the
 *    list scrolls inside.
 *  - Embedded and `scrollsWithPage` (the phone Feed screen): the card sizes to
 *    its content and grows into free space (`flex-1` with min-height auto), so
 *    the page's `main` stays the only scroller and an empty state can center
 *    in the slack instead of leaving it as a block underneath. `overflow-visible`
 *    is load-bearing: a scroll container's automatic minimum size is zero, so
 *    an `overflow-hidden` card in a flex column could be squeezed below its
 *    content and turn its inner list into a nested scroller.
 */
export function signalFeedCardClassName({
  embedded,
  collapsed,
  scrollsWithPage,
}: {
  embedded: boolean;
  collapsed: boolean;
  scrollsWithPage: boolean;
}): string {
  const base = "terminal-signal-feed w-full flex flex-col";
  if (!embedded) return collapsed ? base : `${base} h-[600px]`;
  const chrome = "gap-0 rounded-none bg-transparent py-0 ring-0";
  return scrollsWithPage
    ? `${base} flex-1 overflow-visible ${chrome}`
    : `${base} h-full min-h-0 overflow-hidden ${chrome}`;
}
