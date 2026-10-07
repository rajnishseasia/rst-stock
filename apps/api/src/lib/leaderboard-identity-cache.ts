/**
 * Leaderboard identity cache invalidation.
 *
 * The users leaderboard is cached in Redis per window. Each cache entry
 * includes the resolved display name and avatar for every ranked user at
 * cache-build time. When a user links or unlinks Twitter the cached entry
 * for that user becomes stale: other viewers would see the old anonymous
 * pseudonym until the TTL expires (up to 2 hours).
 *
 * Call `invalidateUserLeaderboardCache` after any event that changes a
 * user's public identity (Twitter link, unlink, or profile refresh) so
 * the next request rebuilds the cache with the current data.
 */

import { getRedisClient } from "@trade-bot/redis";
import { createProductionLogger } from "@trade-bot/logger";

// This module runs from Better Auth database hooks and other cold, non-tRPC
// paths that never touch ctx.logger, so getRedisClient() has no logger to
// reuse on a cold process. It needs its own, module-scoped instance to
// satisfy getRedisClient's "logger required on first call" contract.
const logger = createProductionLogger();

// These must stay in sync with the cacheKey built in leaderboard.ts:
//   const cacheKey = `users:v15:${input.window}`;
//   const fullKey  = `leaderboard:${cacheKey}`;
const USER_LEADERBOARD_CACHE_KEYS = [
  "leaderboard:users:v15:7d",
  "leaderboard:users:v15:30d",
  "leaderboard:users:v15:all",
] as const;

// Bumped on every invalidation so an in-flight background refresh that
// started reading the old identity before invalidation can detect the
// change and skip writing its stale result back to Redis. See
// getUserLeaderboardCacheEpoch / isUserLeaderboardCacheKey below, consumed
// by refreshLeaderboardCache in leaderboard.ts.
const USER_LEADERBOARD_EPOCH_KEY = "leaderboard:users:v15:epoch";
const USER_LEADERBOARD_EPOCH_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Delete all three per-window user leaderboard cache entries from Redis.
 * Non-fatal: a Redis outage is logged and swallowed so the calling mutation
 * still succeeds and the cache just expires naturally after its TTL.
 */
export async function invalidateUserLeaderboardCache(): Promise<void> {
  try {
    const redis = await getRedisClient(logger);
    await Promise.all([
      ...USER_LEADERBOARD_CACHE_KEYS.map((key) => redis.del(key)),
      redis.incrWithTtl(USER_LEADERBOARD_EPOCH_KEY, USER_LEADERBOARD_EPOCH_TTL_SECONDS),
    ]);
    logger.info("leaderboard-identity-cache", "User leaderboard cache invalidated", {
      keys: USER_LEADERBOARD_CACHE_KEYS,
    });
  } catch (err) {
    // Non-fatal: the cache will expire on its own TTL.
    logger.warn("leaderboard-identity-cache", "Failed to invalidate user leaderboard cache", { error: err });
  }
}

/** True when `fullKey` is one of the per-window user leaderboard cache keys. */
export function isUserLeaderboardCacheKey(fullKey: string): boolean {
  return (USER_LEADERBOARD_CACHE_KEYS as readonly string[]).includes(fullKey);
}

/**
 * Current invalidation epoch for the user leaderboard cache. A background
 * refresh should read this before compute and again before writing; if the
 * value changed, an invalidation happened mid-refresh and the write should
 * be skipped so it cannot resurrect a stale identity.
 */
export async function getUserLeaderboardCacheEpoch(
  redis: { get(key: string): Promise<string | null> },
): Promise<string | null> {
  return redis.get(USER_LEADERBOARD_EPOCH_KEY);
}
