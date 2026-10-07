/**
 * Reusable Caching Service
 *
 * Provides a generic cache utility that can be used with any Redis client.
 * Supports getOrFetch pattern, TTL-based expiration, and cache invalidation.
 *
 * @example
 * ```typescript
 * const cache = new CacheService(redisClient);
 *
 * // Get from cache or fetch if not present
 * const data = await cache.getOrFetch(
 *   'wallet:0x123:stats',
 *   () => fetchWalletStats('0x123'),
 *   { ttlSeconds: 300, prefix: 'wallet-stats' }
 * );
 *
 * // Invalidate by pattern
 * await cache.invalidate('wallet:0x123:*');
 * ```
 */

import { catchError } from "@trade-bot/utils";

/**
 * Cache options for getOrFetch operations
 */
export interface CacheOptions {
  /** Time-to-live in seconds */
  ttlSeconds: number;
  /** Optional prefix for the cache key */
  prefix?: string;
}

/**
 * Redis client interface - minimal contract for cache operations
 * Matches the @trade-bot/redis RedisDataClient interface
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expireSeconds?: number): Promise<boolean>;
  del(key: string): Promise<boolean>;
  deleteKeysByPattern(pattern: string): Promise<number>;
}

/**
 * Cache Service
 *
 * Generic caching utility that wraps Redis operations with type-safe methods.
 * Implements the getOrFetch pattern to avoid cache stampede.
 *
 * Supports both synchronous and Promise-based Redis clients.
 */
export class CacheService {
  private redisPromise: Promise<RedisCacheClient>;

  constructor(redis: RedisCacheClient | Promise<RedisCacheClient>) {
    this.redisPromise = Promise.resolve(redis);
  }

  /**
   * Get the Redis client (resolves promise if needed)
   */
  private async getRedis(): Promise<RedisCacheClient> {
    return this.redisPromise;
  }

  /**
   * Build cache key with optional prefix
   */
  private buildKey(key: string, prefix?: string): string {
    return prefix ? `${prefix}:${key}` : key;
  }

  /**
   * Get a value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const redis = await this.getRedis();
    const [error, value] = await catchError(redis.get(key));

    if (error || !value) {
      return null;
    }

    const [parseError, parsed] = catchError(() => JSON.parse(value) as T);

    if (parseError) {
      return null;
    }

    return parsed;
  }

  /**
   * Set a value in cache with TTL
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    const [stringifyError, serialized] = catchError(() => JSON.stringify(value));

    if (stringifyError) {
      return false;
    }

    const redis = await this.getRedis();
    const [error, result] = await catchError(redis.set(key, serialized, ttlSeconds));

    if (error) {
      return false;
    }

    return result;
  }

  /**
   * Delete a specific key from cache
   */
  async del(key: string): Promise<boolean> {
    const redis = await this.getRedis();
    const [error, result] = await catchError(redis.del(key));

    if (error) {
      return false;
    }

    return result;
  }

  /**
   * Invalidate cache keys by pattern
   */
  async invalidate(pattern: string): Promise<number> {
    const redis = await this.getRedis();
    const [error, count] = await catchError(redis.deleteKeysByPattern(pattern));

    if (error) {
      return 0;
    }

    return count;
  }

  /**
   * Get from cache or fetch from source
   *
   * Main caching pattern - checks cache first, fetches from source if miss,
   * then caches the result for future requests.
   */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, options: CacheOptions): Promise<T> {
    const cacheKey = this.buildKey(key, options.prefix);

    // Try cache first
    const cached = await this.get<T>(cacheKey);

    if (cached !== null) {
      return cached;
    }

    // Cache miss - fetch from source
    const [error, data] = await catchError(fetcher());

    if (error) {
      throw error;
    }

    // Cache the result (non-blocking)
    this.set(cacheKey, data, options.ttlSeconds).catch(() => {
      // Silently ignore cache set failures
    });

    return data;
  }

  /**
   * Get or fetch multiple items in parallel
   *
   * Optimized for batch operations - checks cache for all keys,
   * fetches missing items in parallel, and caches results.
   */
  async getOrFetchMany<T>(
    keys: string[],
    fetcher: (key: string) => Promise<T>,
    options: CacheOptions,
  ): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const missingKeys: string[] = [];

    // Check cache for all keys in parallel
    const cacheResults = await Promise.all(
      keys.map(async (key) => {
        const cacheKey = this.buildKey(key, options.prefix);
        const cached = await this.get<T>(cacheKey);
        return { key, cached };
      }),
    );

    // Separate hits and misses
    for (const { key, cached } of cacheResults) {
      if (cached !== null) {
        result.set(key, cached);
      } else {
        missingKeys.push(key);
      }
    }

    // Fetch missing items in parallel
    if (missingKeys.length > 0) {
      const fetchResults = await Promise.allSettled(
        missingKeys.map(async (key) => {
          const data = await fetcher(key);
          return { key, data };
        }),
      );

      // Process fetch results
      for (const fetchResult of fetchResults) {
        if (fetchResult.status === "fulfilled") {
          const { key, data } = fetchResult.value;
          result.set(key, data);

          // Cache the result (non-blocking)
          const cacheKey = this.buildKey(key, options.prefix);
          this.set(cacheKey, data, options.ttlSeconds).catch(() => {
            // Silently ignore cache set failures
          });
        }
      }
    }

    return result;
  }
}
