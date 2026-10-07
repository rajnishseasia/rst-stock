import { RedisClient } from "./client.js";
import type { Logger } from "@trade-bot/logger";

/**
 * Redis client factory with environment-based configuration
 * Implements singleton pattern with lazy initialization and proper error handling
 */
class RedisClientFactory {
  private static instance: RedisClient | null = null;
  private static initializationPromise: Promise<RedisClient> | null = null;
  private static logger: Logger | null = null;

  /**
   * Get or create singleton Redis client instance
   * Thread-safe initialization with promise memoization
   *
   * @param logger - Logger instance (required on first call)
   * @returns Redis client instance
   * @throws Error if REDIS_URL is not configured
   * @throws Error if logger not provided on first call
   */
  static async getInstance(logger?: Logger): Promise<RedisClient> {
    // Return existing instance if available
    if (this.instance !== null) {
      return this.instance;
    }

    // If initialization in progress, wait for it
    if (this.initializationPromise !== null) {
      return this.initializationPromise;
    }

    // Validate logger provided on first call
    if (this.logger === null && !logger) {
      throw new Error("Logger must be provided on first call to RedisClientFactory.getInstance()");
    }

    // Store logger for future use
    if (logger) {
      this.logger = logger;
    }

    // Start initialization and memoize promise to prevent race conditions
    this.initializationPromise = this.initialize();

    try {
      this.instance = await this.initializationPromise;
      return this.instance;
    } finally {
      // Clear promise after initialization completes or fails
      this.initializationPromise = null;
    }
  }

  /**
   * Initialize Redis client with environment configuration
   * @private
   */
  private static async initialize(): Promise<RedisClient> {
    const url = process.env.REDIS_URL;

    if (!url) {
      throw new Error("REDIS_URL environment variable is required for Redis client initialization");
    }

    // Non-null assertion safe here due to validation in getInstance
    const logger = this.logger!;

    logger.info("redis-factory", "Initializing Redis client", {
      url: this.sanitizeUrl(url),
    });

    const client = new RedisClient({
      url,
      logger,
      lazyConnect: false,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
    });

    // Ensure connection is established
    await client.connect();

    // Verify health before returning
    const isHealthy = await client.isHealthy();
    if (!isHealthy) {
      throw new Error("Redis client failed health check after initialization");
    }

    logger.info("redis-factory", "Redis client initialized successfully");

    return client;
  }

  /**
   * Close and reset singleton instance
   * Used for graceful shutdown or testing
   */
  static async reset(): Promise<void> {
    if (this.instance) {
      await this.instance.close();
      this.instance = null;
      this.logger?.info("redis-factory", "Redis client reset complete");
    }
  }

  /**
   * Sanitize URL for logging (remove credentials)
   * @private
   */
  private static sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = "***";
      }
      return parsed.toString();
    } catch {
      return url.replace(/:[^:@]+@/, ":***@");
    }
  }
}

/**
 * Get singleton Redis client instance
 * Convenience function wrapping factory
 *
 * @param logger - Logger instance (required on first call)
 * @returns Redis client instance
 */
export async function getRedisClient(logger?: Logger): Promise<RedisClient> {
  return RedisClientFactory.getInstance(logger);
}

/**
 * Close and reset singleton instance
 * For testing or graceful shutdown
 */
export async function closeRedisClient(): Promise<void> {
  return RedisClientFactory.reset();
}

/**
 * Create a new Redis client (non-singleton)
 * For advanced use cases requiring multiple instances
 *
 * @param logger - Logger instance
 * @param url - Optional Redis URL (defaults to REDIS_URL env var)
 * @returns New Redis client instance
 */
export function createRedisClient(logger: Logger, url?: string): RedisClient {
  const redisUrl = url ?? process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable or url parameter required");
  }

  return new RedisClient({
    url: redisUrl,
    logger,
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
  });
}
