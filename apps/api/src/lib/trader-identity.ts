/**
 * Trader Identity helpers (NON-PII)
 *
 * Single source of truth for deriving NON-PII trader/author identity from
 * server-only inputs (a real user id, or a signal's author metadata):
 *
 *   - traderKey(userId)        — a wide one-way SHA-256 prefix used as the
 *                                copy_trade_follows.target_key for "user" follows
 *                                and as CopyTradeItem.followTarget.key. The
 *                                auto-mirror worker matches follows to source
 *                                trades by THIS key, so it must be
 *                                collision-resistant.
 *   - anonymizeTrader(userId)  — a deterministic pseudonym + DiceBear avatar.
 *   - traderProfileSlug(...)    — the readable, non-unique /lb/users/<slug>
 *                                URL segment (X handle, else the pseudonym).
 *                                Display/routing only — never a follow key.
 *   - traderProfileSlugAliases  — every URL segment that should resolve to a
 *                                trader (canonical slug, stored handle,
 *                                pseudonym, legacy traderKey hash).
 *   - cleanAuthorName(name)    — strips the TweetShift webhook suffix.
 *   - deriveAuthor(metadata)   — pulls the display author + avatar out of a
 *                                signal's (possibly stringified) metadata.
 *
 * These live in a LIB (no @trpc/server, no DB, no router imports) precisely so
 * the auto-mirror worker can import them statically WITHOUT executing a tRPC
 * router module. social.ts / copy-trade.ts / leaderboard.ts re-export or import
 * from here so the hashes/pseudonyms stay byte-identical across the codebase and
 * existing follow keys keep matching.
 */

import { createHash } from "node:crypto";
import {
  readCanonicalAuthorForSource,
  type CanonicalAuthorIdentityKind,
} from "@trade-bot/utils";

/**
 * Deterministic, non-reversible hash of a string (FNV-1a 32-bit).
 * Used to derive a stable pseudonym + avatar seed from a user id so the
 * same user always maps to the same fake identity, while the user's real
 * name/image never leave the server.
 */
function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const PSEUDONYM_ADJECTIVES = [
  "Swift", "Bold", "Quiet", "Lucky", "Sharp", "Calm", "Brave", "Nimble",
  "Steady", "Clever", "Silent", "Rapid", "Stoic", "Vivid", "Keen", "Sly",
];

const PSEUDONYM_NOUNS = [
  "Falcon", "Otter", "Bison", "Heron", "Lynx", "Marlin", "Raven", "Badger",
  "Cobra", "Gecko", "Wolf", "Stag", "Orca", "Hawk", "Mantis", "Tiger",
];

/**
 * Map a user id to a deterministic pseudonym + DiceBear avatar URL.
 * The real user id never reaches the client; only the derived seed does.
 */
export function anonymizeTrader(userId: string): { traderName: string; traderImage: string } {
  const hash = stableHash(userId);
  const adjective = PSEUDONYM_ADJECTIVES[hash % PSEUDONYM_ADJECTIVES.length];
  const noun = PSEUDONYM_NOUNS[(hash >>> 8) % PSEUDONYM_NOUNS.length];
  const number = hash % 1000;
  const seed = `${hash.toString(36)}`;
  return {
    traderName: `${adjective}${noun}${number}`,
    traderImage: `https://api.dicebear.com/9.x/bottts/png?seed=${encodeURIComponent(seed)}`,
  };
}

export interface LinkedTraderProfile {
  twitterLinked: boolean;
  /** General display name (from whichever OAuth provider last wrote users.name). */
  name?: string | null;
  /** Twitter-specific display name stored in users.twitter_name. Preferred over name. */
  twitterName?: string | null;
  /** Twitter @handle stored in users.username. Used for x.com profile links. */
  username?: string | null;
  image?: string | null;
}

/** Prefer a verified linked X profile while retaining the stable anonymous fallback. */
export function resolveTraderIdentity(
  userId: string,
  profile?: LinkedTraderProfile | null,
): {
  traderName: string;
  traderImage: string;
  twitterHandle: string | null;
  twitterLinked: boolean;
} {
  const anonymous = anonymizeTrader(userId);
  if (!profile?.twitterLinked) {
    return { ...anonymous, twitterHandle: null, twitterLinked: false };
  }

  const handle = profile.username?.trim().replace(/^@/u, "") || null;
  // Prefer the Twitter-specific display name (twitter_name column). Fall back to
  // the general users.name field, then the handle, then the anonymous pseudonym.
  const displayName =
    profile.twitterName?.trim() ||
    profile.name?.trim() ||
    (handle ? `@${handle}` : anonymous.traderName);
  return {
    traderName: displayName,
    traderImage: profile.image?.trim() || anonymous.traderImage,
    twitterHandle: handle,
    twitterLinked: true,
  };
}

/**
 * Stable, NON-PII follow key for a user id.
 *
 * A wide (128-bit) one-way SHA-256 prefix — deliberately NOT the 32-bit
 * pseudonym hash. The auto-mirror worker matches a follow to a source trade by
 * THIS key, so it must be collision-resistant: a 32-bit collision would
 * auto-place the WRONG user's real orders on a follower's account. The raw user
 * id is never exposed. Used as CopyTradeItem.followTarget.key (type "user") and
 * stored as copy_trade_follows.target_key — so the Follow button and "Following"
 * filter work without ever handling the real user id.
 */
export function traderKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

/**
 * Human-readable, NON-PII URL slug for a public trader profile.
 *
 * Prefers the linked X handle so `/lb/users/SOL_Decoder` reads as the trader it
 * belongs to, and falls back to the deterministic pseudonym (`SwiftFalcon123`)
 * for a user with no linked X account. Neither form exposes the real user id.
 *
 * Slugs are deliberately NOT collision-proof: a handle can be relinquished and
 * reclaimed by a different account, and the 32-bit pseudonym space repeats.
 * Resolution is deterministic (oldest account wins), which is fine for a public
 * read-only profile page. It is NOT fine for anything that moves money: the
 * collision-resistant `traderKey` remains the follow / auto-mirror key, and a
 * slug must never be substituted for it there.
 */
export function traderProfileSlug(userId: string, twitterHandle?: string | null): string {
  const handle = twitterHandle?.trim().replace(/^@/u, "");
  if (handle) return handle;
  return anonymizeTrader(userId).traderName;
}

/**
 * Every URL segment that should resolve to this trader.
 *
 * The canonical slug is one of several forms a link can be in, and a profile
 * that 404s on a form the user reasonably typed is worse than one that redirects:
 *
 *   - the collision-resistant `traderKey` hash, so already-shared
 *     `/lb/users/<hash>` links keep working;
 *   - the stored X handle, EVEN IF the linked-account row is not visible to the
 *     caller. `resolveTraderIdentity` reports `twitterHandle: null` whenever
 *     `twitterLinked` is false, which is exactly the state a user lands in when
 *     the profile sync wrote `users.username` but the accounts join came back
 *     empty; without this the handle they know themselves by stops resolving;
 *   - the deterministic pseudonym, which stays valid after an X account is
 *     linked so a pseudonym-era link is not orphaned by the linking.
 *
 * All entries are returned in `normalizeTraderSlug` form. Non-unique by design,
 * exactly like `traderProfileSlug`: display/routing only, never a follow key.
 */
export function traderProfileSlugAliases(
  userId: string,
  profile?: LinkedTraderProfile | null,
): string[] {
  const identity = resolveTraderIdentity(userId, profile);
  const storedHandle = profile?.username?.trim().replace(/^@/u, "") || null;
  const aliases = [
    traderKey(userId),
    traderProfileSlug(userId, identity.twitterHandle),
    storedHandle,
    anonymizeTrader(userId).traderName,
  ];
  return [
    ...new Set(
      aliases
        .filter((alias): alias is string => Boolean(alias))
        .map((alias) => normalizeTraderSlug(alias)),
    ),
  ];
}

/**
 * Canonical comparison form for a profile slug: no leading "@", case-folded.
 * X handles are case-insensitive and pseudonyms are ASCII, so a plain
 * lowercase is enough. Also lowercases a legacy 32-hex `traderKey` so old
 * `/lb/users/<hash>` links keep resolving.
 */
export function normalizeTraderSlug(value: string): string {
  return value.trim().replace(/^@/u, "").replace(/\s+/g, "").toLowerCase();
}

/**
 * TweetShift relays tweets into Discord with webhook usernames like
 * "Serenity • TweetShift" — strip the bot suffix so we show the real author.
 * Mirrors apps/web-v2 signal-feed cleanAuthorName.
 */
export function cleanAuthorName(name: string): string {
  return name.replace(/\s*[•·|–-]\s*TweetShift\s*$/i, "").trim() || name;
}

/** Pull display author + avatar out of a signal's (possibly stringified) metadata. */
export function deriveAuthor(metadata: unknown, source?: string | null): {
  authorName: string;
  authorAvatar: string | null;
  authorHandle: string | null;
  canonicalAuthorKey: string | null;
  identityKind: CanonicalAuthorIdentityKind;
  authorAliases: string[];
  authorAliasHistory: string[];
  source: string | null;
  sourceAuthorId: string | null;
} {
  const author = readCanonicalAuthorForSource(metadata, source);
  return {
    authorName: cleanAuthorName(author.authorName),
    authorAvatar: author.authorAvatar,
    authorHandle: author.authorHandle,
    canonicalAuthorKey: author.canonicalAuthorKey,
    identityKind: author.identityKind,
    authorAliases: author.authorAliases,
    authorAliasHistory: author.authorAliasHistory,
    source: author.source,
    sourceAuthorId: author.sourceAuthorId,
  };
}
