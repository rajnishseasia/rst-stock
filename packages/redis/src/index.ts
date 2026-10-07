/**
 * @trade-bot/redis
 *
 * Type-safe Redis client with data, pub/sub, and streams support.
 */

import { getRedisClient, closeRedisClient, createRedisClient } from "./factory.js";

// Main API
export { getRedisClient, closeRedisClient, createRedisClient };
export { RedisClient } from "./client.js";

// Low-level clients (for advanced usage)
export { RedisConnection, type RedisConnectionConfig } from "./connection.js";
export { RedisPubSubClient } from "./pubsub-client.js";
export { RedisStreamClient, type StreamEntry, type StreamReadOptions } from "./stream-client.js";

// Caching utilities
export { CacheService, type CacheOptions, type RedisCacheClient } from "./cache/index.js";

// Convenience export for creating a connection
export function createRedisConnection() {
  return getRedisClient();
}
