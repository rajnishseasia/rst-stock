/**
 * The feed's pure data pipeline: raw signal rows in, one card per upstream post
 * out. Extracted from signal-feed.tsx (audit H7) so the grouping and filtering
 * rules are unit-testable against the real module.
 *
 * The ingest layer writes ONE row per (post, ticker) so per-ticker charts and
 * filters still work, which means a tweet naming five tickers arrives as five
 * rows. The feed shows one card per post with a chip per ticker.
 */

import {
  normalizeSignalContent,
  parseSignalMetadata,
  signalGroupKey,
  type SignalDisplayMetadata,
} from "./signal-feed-utils";
import { isPerpSignal, perpCopyPayload, type PerpCopyPayload } from "./signal-perp";
import {
  signalDirectionFromMetadata,
  type SignalDirection,
} from "./signal-thesis";

/** The subset of a signals-list row the feed pipeline reads. */
export interface RawFeedSignal {
  id: string;
  source?: string | null;
  symbol: string;
  content: string;
  url: string | null;
  timestamp: string | number | Date;
  metadata?: unknown;
}

/** A raw row with its metadata parsed and its content normalized. */
export type NormalizedFeedSignal<T extends RawFeedSignal = RawFeedSignal> = T &
  SignalDisplayMetadata;

/** One ticker chip on a card. `perp` is null for a plain equity mention. */
export interface FeedTicker {
  signalId: string;
  symbol: string;
  perp: PerpCopyPayload | null;
  /**
   * Plan S1. The direction the caller STATED, or null when they stated none.
   *
   * Not derivable from `perp.side`: that field defaults an absent direction to
   * "long" because a perp copy has to open SOME side, which is right for an
   * order and wrong for a claim about what someone said. Kept per ticker rather
   * than per group because metadata is stored per (post, ticker) row.
   */
  direction: SignalDirection | null;
}

/** One card: an upstream post plus every ticker it mentioned. */
export interface FeedGroup {
  key: string;
  /** Card identity comes from the first ticker row seen for this post, which
   *  keeps the newest-first sort and the React key stable. */
  primaryId: string;
  timestamp: string | number | Date;
  content: string;
  url: string | null;
  imageUrl: string | null;
  authorName: string;
  authorAvatar: string | null;
  /** Plan S2. The server's follow / leaderboard key for this author, or null. */
  authorKey: string | null;
  tickers: FeedTicker[];
  /** Membership test so the selection ring lights up no matter which of the
   *  post's ticker rows is the currently-selected signal. */
  signalIds: Set<string>;
}

/**
 * Drops rows whose id was already seen. Infinite-scroll pages can overlap at a
 * boundary when new signals land between fetches.
 */
export function dedupeSignalsById<T extends { id: string }>(
  signals: readonly T[],
): T[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    if (seen.has(signal.id)) return false;
    seen.add(signal.id);
    return true;
  });
}

/** Parses each row's metadata and normalizes its display content once. */
export function normalizeFeedSignals<T extends RawFeedSignal>(
  signals: readonly T[],
): Array<NormalizedFeedSignal<T>> {
  return signals.map((signal) => ({
    ...signal,
    ...parseSignalMetadata(signal.metadata, signal.source),
    content: normalizeSignalContent(signal.content),
  })) as Array<NormalizedFeedSignal<T>>;
}

/** An author entry for the feed's filter menu. */
export interface FeedAuthor {
  name: string;
  avatar: string | null;
  count: number;
  /** Plan S2. The server's follow / leaderboard key, or null when unattributable. */
  key: string | null;
}

/** Unique authors with signal counts, most-frequent first then alphabetical. */
export function collectFeedAuthors(
  signals: readonly {
    authorName: string;
    authorAvatar: string | null;
    authorKey?: string | null;
  }[],
): FeedAuthor[] {
  const map = new Map<string, FeedAuthor>();
  for (const signal of signals) {
    // Canonical server keys collapse a rename into one filter entry. Legacy
    // rows without one retain the historical display-name grouping.
    const groupingKey = signal.authorKey ?? signal.authorName;
    let current = map.get(groupingKey);
    if (!current && signal.authorKey) {
      current = map.get(signal.authorName);
      if (current) {
        map.delete(signal.authorName);
        map.set(groupingKey, current);
      }
    }
    if (current) {
      current.count += 1;
      if (!current.avatar && signal.authorAvatar) {
        current.avatar = signal.authorAvatar;
      }
      if (!current.key && signal.authorKey) current.key = signal.authorKey;
      continue;
    }
    map.set(groupingKey, {
      name: signal.authorName,
      avatar: signal.authorAvatar,
      count: 1,
      key: signal.authorKey ?? null,
    });
  }
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

/**
 * Collapses the per-(post, ticker) rows into one group per post, preserving the
 * input order of first appearance. Grouping is by post, not by host: a site-root
 * URL (every paste.trade row carries the same board root) is not post-specific,
 * so those rows fall back to timestamp + author + content instead of collapsing
 * every paste.trade call into one card.
 */
export function groupFeedSignals(
  signals: readonly NormalizedFeedSignal[],
): FeedGroup[] {
  const byKey = new Map<string, FeedGroup>();
  const order: string[] = [];

  for (const signal of signals) {
    const key = signalGroupKey(signal);
    const perp = perpCopyPayload(signal.metadata);
    const direction = signalDirectionFromMetadata(signal.metadata);
    // A perp row with no copyable coin gets NO chip, not an equity chip.
    // Everything downstream reads venue off `perp`, so a null payload otherwise
    // means "equity" and the row would render a Copy that prefills the Alpaca
    // ticket for the colliding listing (SOL is Solana on Hyperliquid and
    // ReneSola on Nasdaq, "GOOGL" is a whole different market from
    // "xyz:GOOGL"). Refusing to name the perp market only helps if it does not
    // silently reroute the reader to an equity one. The card itself stays, so
    // the post is still readable, it just carries no trade action.
    const chippable = perp !== null || !isPerpSignal(signal.metadata);
    const existing = byKey.get(key);
    if (existing) {
      // Same post, additional ticker. Skip a duplicate ticker in case the
      // upstream ever emits one (cheap safety net, not currently expected).
      if (
        chippable &&
        !existing.tickers.some((ticker) => ticker.symbol === signal.symbol)
      ) {
        existing.tickers.push({
          signalId: signal.id,
          symbol: signal.symbol,
          perp,
          direction,
        });
      }
      existing.signalIds.add(signal.id);
      continue;
    }

    byKey.set(key, {
      key,
      primaryId: signal.id,
      timestamp: signal.timestamp,
      content: signal.content,
      url: signal.url,
      imageUrl: signal.imageUrl,
      authorName: signal.authorName,
      authorAvatar: signal.authorAvatar,
      authorKey: signal.authorKey,
      tickers: chippable
        ? [{ signalId: signal.id, symbol: signal.symbol, perp, direction }]
        : [],
      signalIds: new Set([signal.id]),
    });
    order.push(key);
  }

  return order.map((key) => byKey.get(key)!);
}

/**
 * The direction a CARD may claim for its post: the one direction every stated
 * ticker agrees on, or null.
 *
 * A card summarizes several (post, ticker) rows, so a card-level badge is a
 * claim about the whole post. It is only honest when every ticker that stated
 * a direction stated the same one; a mixed post (long NVDA, short AMD) gets no
 * card badge and leaves direction to the per-ticker chips. Tickers with no
 * stated direction are ignored rather than treated as disagreement, and a post
 * where nobody stated any direction returns null: this must NEVER invent a
 * direction (see signal-thesis.ts for why a defaulted side is a fabricated
 * claim under a named author).
 */
export function groupStatedDirection(
  tickers: readonly { direction: SignalDirection | null }[],
): SignalDirection | null {
  let agreed: SignalDirection | null = null;
  for (const { direction } of tickers) {
    if (direction === null) continue;
    if (agreed === null) {
      agreed = direction;
    } else if (agreed !== direction) {
      return null;
    }
  }
  return agreed;
}

/**
 * Perps-venue narrowing. Filters the TICKERS too, not just the groups: a mixed
 * post (a perp call plus an equity mention) would otherwise render equity Copy
 * chips under the "Perps" header, and tapping one flips the venue back to
 * stocks.
 */
export function filterPerpGroups(
  groups: readonly FeedGroup[],
  perpsOnly: boolean,
): FeedGroup[] {
  if (!perpsOnly) return [...groups];
  return groups
    .filter((group) => group.tickers.some((ticker) => ticker.perp))
    .map((group) => ({
      ...group,
      tickers: group.tickers.filter((ticker) => ticker.perp),
    }));
}

export type SignalVenueFilter = "all" | "stocks" | "perps";

/** Applies the terminal's All / Stocks / Perps market filter to feed cards. */
export function filterGroupsByVenue(
  groups: readonly FeedGroup[],
  filter: SignalVenueFilter,
): FeedGroup[] {
  if (filter === "all") return [...groups];
  const wantsPerps = filter === "perps";
  return groups
    .map((group) => ({
      ...group,
      tickers: group.tickers.filter((ticker) => Boolean(ticker.perp) === wantsPerps),
    }))
    .filter((group) => group.tickers.length > 0);
}
