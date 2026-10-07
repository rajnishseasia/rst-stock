import { catchError } from "@trade-bot/utils";
import { RedisConnection, type RedisConnectionConfig } from "./connection.js";
import { RedisPubSubClient } from "./pubsub-client.js";
import { RedisStreamClient, type StreamEntry } from "./stream-client.js";
import type Redis from "ioredis";

/**
 * Unified Redis client with data, pub/sub, and stream capabilities
 * Extends RedisConnection for data operations, composes specialized clients
 */
export class RedisClient extends RedisConnection {
  private pubsubClient: RedisPubSubClient;
  private streamClient: RedisStreamClient;

  constructor(config: RedisConnectionConfig) {
    // Data client with lazy connect for efficiency
    super({
      ...config,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    // PubSub client with eager connect for subscriptions
    this.pubsubClient = new RedisPubSubClient({
      ...config,
      lazyConnect: false,
      enableOfflineQueue: true,
    });

    // Stream client with eager connect for durability
    this.streamClient = new RedisStreamClient({
      ...config,
      lazyConnect: false,
      enableOfflineQueue: true,
    });
  }

  // ========== Data Operations ==========

  /**
   * Set a key-value pair with optional expiration in seconds
   */
  async set(key: string, value: string, expireSeconds?: number): Promise<boolean> {
    const [error] = await catchError(
      expireSeconds !== undefined
        ? this.client.setex(key, expireSeconds, value)
        : this.client.set(key, value),
    );

    if (error) {
      this.logger.error("redis", `Error SET key ${key}`, {
        error: error.message,
      });
      return false;
    }

    return true;
  }

  /**
   * Get a value by key
   */
  async get(key: string): Promise<string | null> {
    return (await this.getWithStatus(key)).value;
  }

  /**
   * Get a value while preserving whether Redis completed the operation.
   * Cache callers use this to distinguish a real miss from an unavailable
   * connection without changing the legacy null-on-error get contract.
   */
  async getWithStatus(key: string): Promise<{
    ok: boolean;
    value: string | null;
  }> {
    const [error, value] = await catchError(this.client.get(key));

    if (error) {
      this.logger.error("redis", `Error GET key ${key}`, {
        error: error.message,
      });
      return { ok: false, value: null };
    }

    return { ok: true, value };
  }

  /**
   * Claim a key only if it does not already exist, with a millisecond TTL.
   *
   * `SET key value NX PX ttl` is one round trip and atomic, which a
   * `get`-then-`set` pair is not. Callers use this as a cross-process,
   * cross-restart lease: the winner is the one that gets `true`.
   *
   * Distinguishes "someone else holds it" (`false`) from "Redis could not
   * answer" (`null`) so a caller can decide whether an unreachable Redis
   * should block it or not. Collapsing the two into `false` would silently
   * turn an outage into a permanently held lease.
   */
  async setIfNotExists(
    key: string,
    value: string,
    expireMs: number,
  ): Promise<boolean | null> {
    const [error, result] = await catchError(
      this.client.set(key, value, "PX", expireMs, "NX"),
    );

    if (error) {
      this.logger.error("redis", `Error SET NX key ${key}`, {
        error: error.message,
      });
      return null;
    }

    return result === "OK";
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<boolean> {
    const [error, result] = await catchError(this.client.del(key));

    if (error) {
      this.logger.error("redis", `Error DEL key ${key}`, {
        error: error.message,
      });
      return false;
    }

    return result > 0;
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const [error, result] = await catchError(this.client.exists(key));

    if (error) {
      this.logger.error("redis", `Error EXISTS key ${key}`, {
        error: error.message,
      });
      return false;
    }

    return result > 0;
  }

  /**
   * Set an expiry time for a key
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    const [error] = await catchError(this.client.expire(key, seconds));

    if (error) {
      this.logger.error("redis", `Error EXPIRE key ${key}`, {
        error: error.message,
      });
      return false;
    }

    return true;
  }

  /**
   * Delete all keys matching a pattern
   * Note: Use with caution in production
   */
  async deleteKeysByPattern(pattern: string): Promise<number> {
    const [error, result] = await catchError(async () => {
      const stream = this.client.scanStream({
        match: pattern,
        count: 100,
      });

      const keysToDelete: string[] = [];

      stream.on("data", (keys: string[]) => {
        keysToDelete.push(...keys);
      });

      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      if (keysToDelete.length > 0) {
        return await this.client.del(...keysToDelete);
      }

      return 0;
    });

    if (error) {
      this.logger.error("redis", `Error deleting keys by pattern ${pattern}`, {
        error: error.message,
      });
      return 0;
    }

    return result;
  }

  /**
   * Push an item to the left of a list (queue)
   */
  async lpush(key: string, value: string): Promise<number> {
    const [error, result] = await catchError(this.client.lpush(key, value));

    if (error) {
      this.logger.error("redis", `Error LPUSH key ${key}`, {
        error: error.message,
      });
      throw error;
    }

    return result;
  }

  /**
   * Blocking pop from the right of a list (queue)
   * Waits up to timeoutSeconds for an item to become available
   */
  async brpop(key: string, timeoutSeconds: number = 0): Promise<[string, string] | null> {
    const [error, result] = await catchError(this.client.brpop(key, timeoutSeconds));

    if (error) {
      this.logger.error("redis", `Error BRPOP key ${key}`, {
        error: error.message,
      });
      throw error;
    }

    return result as [string, string] | null;
  }

  /**
   * Pop from the right of a list (non-blocking)
   */
  async rpop(key: string): Promise<string | null> {
    const [error, result] = await catchError(this.client.rpop(key));

    if (error) {
      this.logger.error("redis", `Error RPOP key ${key}`, {
        error: error.message,
      });
      return null;
    }

    return result;
  }

  /**
   * Get the length of a list
   */
  async llen(key: string): Promise<number> {
    const [error, result] = await catchError(this.client.llen(key));

    if (error) {
      this.logger.error("redis", `Error LLEN key ${key}`, {
        error: error.message,
      });
      return 0;
    }

    return result;
  }

  // ========== Sorted Set Operations ==========

  /**
   * Add a member to a sorted set with a score
   */
  async zadd(key: string, score: number, member: string): Promise<number> {
    const [error, result] = await catchError(this.client.zadd(key, score, member));

    if (error) {
      this.logger.error("redis", `Error ZADD key ${key}`, {
        error: error.message,
      });
      return 0;
    }

    return result;
  }

  /**
   * Get the number of members in a sorted set
   */
  async zcard(key: string): Promise<number> {
    const [error, result] = await catchError(this.client.zcard(key));

    if (error) {
      this.logger.error("redis", `Error ZCARD key ${key}`, {
        error: error.message,
      });
      return 0;
    }

    return result;
  }

  /**
   * Remove members with scores between min and max from a sorted set
   */
  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const [error, result] = await catchError(this.client.zremrangebyscore(key, min, max));

    if (error) {
      this.logger.error("redis", `Error ZREMRANGEBYSCORE key ${key}`, {
        error: error.message,
      });
      return 0;
    }

    return result;
  }

  /**
   * Get members in a sorted set by index range with optional scores
   */
  async zrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]> {
    const [error, result] = await catchError(
      withScores
        ? this.client.zrange(key, start, stop, "WITHSCORES")
        : this.client.zrange(key, start, stop),
    );

    if (error) {
      this.logger.error("redis", `Error ZRANGE key ${key}`, {
        error: error.message,
      });
      return [];
    }

    return result;
  }

  /**
   * Execute multiple commands atomically using a pipeline
   * Returns results array where each element is [error, result]
   */
  async pipeline(
    commands: Array<{ cmd: string; args: (string | number)[] }>,
  ): Promise<Array<[Error | null, unknown]>> {
    const pipe = this.client.pipeline();

    for (const { cmd, args } of commands) {
      (pipe as any)[cmd](...args);
    }

    const [error, results] = await catchError(pipe.exec());

    if (error) {
      this.logger.error("redis", "Error executing pipeline", {
        error: error.message,
      });
      return [];
    }

    return results ?? [];
  }

  /**
   * Atomically increment a key and set TTL only on first create.
   * Creates key with value 1 if it doesn't exist.
   * TTL is only set when the key is first created, NOT on subsequent increments.
   * This prevents the TTL from being reset on every increment.
   *
   * @param key - Redis key to increment
   * @param ttlSeconds - Time-to-live in seconds (only applied on first create)
   * @returns New value after increment, or 0 on error
   */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    return this.incrByWithTtl(key, 1, ttlSeconds);
  }

  /**
   * Same as `incrWithTtl` but increments by an arbitrary positive amount in
   * one atomic INCRBY. Used by rate limiters that need to charge a single
   * request for multiple units of work (e.g. one OCO submission placing one
   * broker order per take-profit leg).
   *
   * @param key - Redis key to increment
   * @param amount - Amount to add to the key's value
   * @param ttlSeconds - Time-to-live in seconds (only applied on first create)
   * @returns New value after increment, or 0 on error
   */
  async incrByWithTtl(
    key: string,
    amount: number,
    ttlSeconds: number,
  ): Promise<number> {
    // First pipeline: INCRBY + TTL check
    const results = await this.pipeline([
      { cmd: "incrby", args: [key, amount] },
      { cmd: "ttl", args: [key] },
    ]);

    if (results.length < 2) {
      return 0;
    }

    const [incrError, incrResult] = results[0] ?? [null, 0];
    const [, ttlResult] = results[1] ?? [null, -1];

    if (incrError) {
      this.logger.error("redis", `Error INCRBY key ${key}`, {
        error: incrError.message,
      });
      return 0;
    }

    const newCount = (incrResult as number) ?? 0;
    const currentTtl = (ttlResult as number) ?? -1;

    // Only set TTL if not already set
    // TTL returns -2 if key doesn't exist, -1 if key exists but has no TTL
    // After INCR, key exists, so we check for -1 (no TTL set)
    if (currentTtl < 0) {
      await this.expire(key, ttlSeconds);
    }

    return newCount;
  }

  /**
   * Scan for keys matching a pattern
   */
  async scanKeys(pattern: string, count: number = 100): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";

    do {
      const [error, result] = await catchError(
        this.client.scan(cursor, "MATCH", pattern, "COUNT", count),
      );

      if (error) {
        this.logger.error("redis", `Error SCAN pattern ${pattern}`, {
          error: error.message,
        });
        break;
      }

      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== "0");

    return keys;
  }

  // ========== Pub/Sub Operations ==========

  /**
   * Publish a message to a channel
   */
  async publish(channel: string, message: string): Promise<number> {
    return this.pubsubClient.publish(channel, message);
  }

  /**
   * Create a subscriber client for pub/sub
   * This creates a separate Redis connection dedicated to subscriptions
   */
  createSubscriber(): Redis {
    return this.pubsubClient.createSubscriber();
  }

  // ========== Stream Operations ==========

  /**
   * Add an event to a stream (durable message delivery).
   *
   * @param streamKey - Stream name (e.g., "stream:user:123:events")
   * @param fields - Event data as key-value pairs
   * @param maxLen - Optional max length for auto-trimming
   * @returns The generated entry ID
   */
  async xadd(streamKey: string, fields: Record<string, string>, maxLen?: number): Promise<string> {
    return this.streamClient.xadd(streamKey, fields, maxLen);
  }

  /**
   * Read entries from a stream in a range (for replay).
   *
   * @param streamKey - Stream name
   * @param start - Start ID (use "-" for beginning, or lastEventId)
   * @param end - End ID (use "+" for latest)
   * @param count - Max entries to return
   * @returns Array of stream entries
   */
  async xrange(
    streamKey: string,
    start: string,
    end: string = "+",
    count: number = 100,
  ): Promise<StreamEntry[]> {
    return this.streamClient.xrange(streamKey, start, end, count);
  }

  /**
   * Blocking read for new stream entries.
   *
   * @param streamKey - Stream name
   * @param lastId - Last seen ID (use "$" for only new entries)
   * @param options - Read options (count, blockMs)
   * @returns Array of stream entries
   */
  async xread(
    streamKey: string,
    lastId: string = "$",
    options?: { count?: number; blockMs?: number },
  ): Promise<StreamEntry[]> {
    return this.streamClient.xread(streamKey, lastId, options);
  }

  /**
   * Trim a stream to a maximum length.
   *
   * @param streamKey - Stream name
   * @param maxLen - Maximum entries to keep
   * @returns Number of entries removed
   */
  async xtrim(streamKey: string, maxLen: number): Promise<number> {
    return this.streamClient.xtrim(streamKey, maxLen);
  }

  /**
   * Get the length of a stream.
   */
  async xlen(streamKey: string): Promise<number> {
    return this.streamClient.xlen(streamKey);
  }

  // ========== Connection Management ==========

  /**
   * Explicitly connect to Redis (automatically called when needed)
   */
  override async connect(): Promise<void> {
    await Promise.all([super.connect(), this.pubsubClient.connect(), this.streamClient.connect()]);
  }

  /**
   * Check if all Redis connections are healthy
   */
  override async isHealthy(): Promise<boolean> {
    const [dataHealthy, pubsubHealthy, streamHealthy] = await Promise.all([
      super.isHealthy(),
      this.pubsubClient.isHealthy(),
      this.streamClient.isHealthy(),
    ]);
    return dataHealthy && pubsubHealthy && streamHealthy;
  }

  /**
   * Close all Redis connections gracefully
   */
  override async close(): Promise<void> {
    await Promise.all([super.close(), this.pubsubClient.close(), this.streamClient.close()]);
  }
}
