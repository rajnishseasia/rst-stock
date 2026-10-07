import Redis from "ioredis";
import { catchError } from "@trade-bot/utils";
import { RedisConnection, type RedisConnectionConfig } from "./connection.js";

/** Message handler type for channel subscriptions */
export type MessageHandler = (message: string) => void | Promise<void>;

/**
 * Redis Pub/Sub Client
 *
 * Handles publishing and subscribing to Redis channels.
 * Manages separate subscriber connections for pub/sub operations.
 */
export class RedisPubSubClient extends RedisConnection {
  private subscribers: Map<string, Redis> = new Map();
  private channelHandlers: Map<string, MessageHandler> = new Map();
  private dedicatedSubscriber: Redis | null = null;

  constructor(config: RedisConnectionConfig) {
    super(config);
  }

  /**
   * Publish a message to a channel
   */
  async publish(channel: string, message: string): Promise<number> {
    const [error, result] = await catchError(this.client.publish(channel, message));

    if (error) {
      this.logger.error("redis", "Failed to publish message", {
        channel,
        error: error.message,
      });
      throw error;
    }

    if (this.logger.debug) {
      this.logger.debug("redis", "Published message", {
        channel,
        subscribers: result,
      });
    }

    return result;
  }

  /**
   * Create a subscriber client for pub/sub
   * This creates a separate Redis connection dedicated to subscriptions
   */
  createSubscriber(): Redis {
    const logger = this.logger;

    const subscriber = new Redis(this.url, {
      connectTimeout: 10000,
      lazyConnect: false,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null, // Required for pub/sub mode
      retryStrategy: (times) => {
        const delay = Math.min(times * 1000, 5000);
        logger.warn("redis-subscriber", `Retrying connection (attempt ${times})`, { delay });
        return delay;
      },
      showFriendlyErrorStack: true,
    });

    subscriber.on("connect", () => {
      logger.info("redis-subscriber", "Subscriber connected");
    });

    subscriber.on("ready", () => {
      logger.info("redis-subscriber", "Subscriber ready");
    });

    subscriber.on("error", (error) => {
      logger.error("redis-subscriber", "Subscriber error", {
        error: error.message,
      });
    });

    subscriber.on("close", () => {
      logger.warn("redis-subscriber", "Subscriber connection closed");
    });

    subscriber.on("reconnecting", () => {
      logger.info("redis-subscriber", "Subscriber reconnecting...");
    });

    // Track subscriber for cleanup
    const subscriberId = Math.random().toString(36).substring(7);
    this.subscribers.set(subscriberId, subscriber);

    return subscriber;
  }

  /**
   * Subscribe to a channel with a message handler.
   * Creates a dedicated subscriber connection if not already created.
   *
   * @param channel - The channel name to subscribe to
   * @param handler - Callback function to handle incoming messages
   */
  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    // Create dedicated subscriber if needed
    if (!this.dedicatedSubscriber) {
      this.dedicatedSubscriber = this.createSubscriber();

      // Set up message handler
      this.dedicatedSubscriber.on("message", async (ch, message) => {
        const channelHandler = this.channelHandlers.get(ch);
        if (channelHandler) {
          const [error] = await catchError(Promise.resolve(channelHandler(message)));
          if (error) {
            this.logger.error("redis-subscriber", "Error in message handler", {
              channel: ch,
              error: error.message,
            });
          }
        }
      });
    }

    // Store the handler
    this.channelHandlers.set(channel, handler);

    // Subscribe to the channel
    const [error] = await catchError(this.dedicatedSubscriber.subscribe(channel));

    if (error) {
      this.channelHandlers.delete(channel);
      this.logger.error("redis-subscriber", "Failed to subscribe to channel", {
        channel,
        error: error.message,
      });
      throw error;
    }

    this.logger.info("redis-subscriber", "Subscribed to channel", { channel });
  }

  /**
   * Unsubscribe from a channel.
   *
   * @param channel - The channel name to unsubscribe from
   */
  async unsubscribe(channel: string): Promise<void> {
    if (!this.dedicatedSubscriber) {
      return;
    }

    this.channelHandlers.delete(channel);

    const [error] = await catchError(this.dedicatedSubscriber.unsubscribe(channel));

    if (error) {
      this.logger.error("redis-subscriber", "Failed to unsubscribe from channel", {
        channel,
        error: error.message,
      });
      throw error;
    }

    this.logger.info("redis-subscriber", "Unsubscribed from channel", {
      channel,
    });
  }

  /**
   * Disconnect the pub/sub client including dedicated subscriber.
   */
  async disconnect(): Promise<void> {
    // Close dedicated subscriber
    if (this.dedicatedSubscriber) {
      const [error] = await catchError(this.dedicatedSubscriber.quit());
      if (error) {
        this.logger.error("redis-subscriber", "Error closing dedicated subscriber", {
          error: error.message,
        });
      }
      this.dedicatedSubscriber = null;
      this.channelHandlers.clear();
    }

    // Close main client
    await this.close();
  }

  /**
   * Close all connections including subscribers.
   */
  override async close(): Promise<void> {
    // Close all subscribers first
    const entries = Array.from(this.subscribers.entries());
    for (const [id, subscriber] of entries) {
      const [error] = await catchError(subscriber.quit());

      if (error) {
        this.logger.error("redis-subscriber", "Error closing subscriber", {
          error: error.message,
        });
      }

      this.subscribers.delete(id);
    }

    // Close main client
    await super.close();
  }
}
