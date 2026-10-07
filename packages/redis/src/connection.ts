import type { Logger } from "@trade-bot/logger";
import Redis from "ioredis";

/**
 * Redis connection configuration
 */
export interface RedisConnectionConfig {
  url: string;
  logger: Logger;
  connectTimeout?: number;
  maxRetriesPerRequest?: number | null;
  lazyConnect?: boolean;
  enableOfflineQueue?: boolean;
}

/**
 * Redis Connection
 * Foundation for both data operations and pub/sub functionality
 * Provides connection management, health checks, and event handling
 */
export class RedisConnection {
  protected client: Redis;
  protected logger: Logger;
  protected url: string;

  constructor(config: RedisConnectionConfig) {
    this.logger = config.logger;
    this.url = config.url;

    this.client = new Redis(config.url, {
      connectTimeout: config.connectTimeout ?? 10000,
      lazyConnect: config.lazyConnect ?? false,
      enableOfflineQueue: config.enableOfflineQueue ?? true,
      maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 1000, 5000);
        this.logger.warn("redis", `Retrying connection (attempt ${times})`, {
          delay,
        });
        return delay;
      },
      showFriendlyErrorStack: true,
    });

    this.setupEventHandlers();
  }

  /**
   * Set up event handlers for Redis lifecycle
   */
  private setupEventHandlers(): void {
    this.client.on("connect", () => {
      this.logger.info("redis", "Connected to Redis");
    });

    this.client.on("ready", () => {
      this.logger.info("redis", "Redis client ready");
    });

    this.client.on("error", (error) => {
      this.logger.error("redis", "Redis error", { error: error.message });
    });

    this.client.on("close", () => {
      this.logger.warn("redis", "Redis connection closed");
    });

    this.client.on("reconnecting", () => {
      this.logger.info("redis", "Reconnecting to Redis...");
    });
  }

  /**
   * Explicitly connect to Redis (only needed if lazyConnect is true)
   */
  async connect(): Promise<void> {
    if (this.client.status === "ready") {
      return;
    }

    // If already connecting, wait for ready
    if (this.client.status === "connecting") {
      await this.waitForReady();
      return;
    }

    // Connect and wait for ready status
    await this.client.connect();
    await this.waitForReady();
  }

  /**
   * Wait for Redis client to be ready
   * @private
   */
  private async waitForReady(): Promise<void> {
    if (this.client.status === "ready") {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.client.removeListener("ready", onReady);
        this.client.removeListener("error", onError);
        reject(new Error("Redis connection timeout - client did not become ready"));
      }, 10000);

      const onReady = () => {
        clearTimeout(timeout);
        this.client.removeListener("error", onError);
        resolve();
      };

      const onError = (error: Error) => {
        clearTimeout(timeout);
        this.client.removeListener("ready", onReady);
        reject(error);
      };

      this.client.once("ready", onReady);
      this.client.once("error", onError);
    });
  }

  /**
   * Check if Redis connection is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      if (!this.client || this.client.status !== "ready") {
        return false;
      }
      await this.client.ping();
      return true;
    } catch (error) {
      this.logger.error("redis", "Health check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Close the Redis connection gracefully
   */
  async close(): Promise<void> {
    this.logger.info("redis", "Closing Redis connection...");

    if (this.client && this.client.status !== "end") {
      await this.client.quit();
      this.logger.info("redis", "Redis connection closed");
    }
  }
}
