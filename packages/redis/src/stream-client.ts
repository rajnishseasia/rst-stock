/**
 * Redis Streams Client
 *
 * Provides message durability for real-time event streaming.
 * Unlike pub/sub, streams persist messages and support replay.
 *
 * Key features:
 * - XADD: Add events to stream with auto-generated IDs
 * - XRANGE: Read events in a range (for replay)
 * - XREAD: Blocking read for new events
 * - XTRIM: Cleanup old events to prevent unbounded growth
 *
 * @module @trade-bot/redis/stream-client
 */

import { catchError } from "@trade-bot/utils";
import { RedisConnection, type RedisConnectionConfig } from "./connection.js";

/**
 * Stream entry as returned by XRANGE/XREAD.
 */
export interface StreamEntry {
  /** Redis stream entry ID (e.g., "1234567890123-0") */
  id: string;
  /** Entry fields as key-value pairs */
  fields: Record<string, string>;
}

/**
 * Options for reading from a stream.
 */
export interface StreamReadOptions {
  /** Number of entries to read (default: 100) */
  count?: number;
  /** Block timeout in milliseconds (0 = no block, default: 5000) */
  blockMs?: number;
}

/**
 * Redis Streams Client
 *
 * Provides durable message streaming with replay capability.
 * Use this instead of pub/sub when messages must not be lost.
 */
export class RedisStreamClient extends RedisConnection {
  constructor(config: RedisConnectionConfig) {
    super(config);
  }

  /**
   * Add an event to a stream.
   *
   * @param streamKey - Stream name (e.g., "stream:user:123:events")
   * @param fields - Event data as key-value pairs
   * @param maxLen - Optional max length for auto-trimming (approximate)
   * @returns The generated entry ID
   */
  async xadd(streamKey: string, fields: Record<string, string>, maxLen?: number): Promise<string> {
    const args: (string | number)[] = [streamKey];

    // Add MAXLEN trimming if specified (approximate with ~)
    if (maxLen) {
      args.push("MAXLEN", "~", maxLen);
    }

    // Auto-generate ID with *
    args.push("*");

    // Add field-value pairs
    for (const [key, value] of Object.entries(fields)) {
      args.push(key, value);
    }

    const [error, id] = await catchError(
      this.client.xadd(...(args as Parameters<typeof this.client.xadd>)),
    );

    if (error) {
      this.logger.error("redis-stream", "Failed to add to stream", {
        streamKey,
        error: error.message,
      });
      throw error;
    }

    this.logger.debug?.("redis-stream", "Added entry to stream", {
      streamKey,
      id,
    });

    return id as string;
  }

  /**
   * Read entries from a stream in a range.
   *
   * Used for replaying missed events after reconnection.
   *
   * @param streamKey - Stream name
   * @param start - Start ID (use "-" for beginning, or lastEventId)
   * @param end - End ID (use "+" for latest)
   * @param count - Max entries to return (default: 100)
   * @returns Array of stream entries
   */
  async xrange(
    streamKey: string,
    start: string,
    end: string = "+",
    count: number = 100,
  ): Promise<StreamEntry[]> {
    const [error, result] = await catchError(
      this.client.xrange(streamKey, start, end, "COUNT", count),
    );

    if (error) {
      this.logger.error("redis-stream", "Failed to read stream range", {
        streamKey,
        start,
        end,
        error: error.message,
      });
      throw error;
    }

    // Transform ioredis result to StreamEntry[]
    const entries: StreamEntry[] = (result || []).map(([id, fieldsArray]) => ({
      id,
      fields: this.parseFieldsArray(fieldsArray),
    }));

    this.logger.debug?.("redis-stream", "Read stream range", {
      streamKey,
      start,
      end,
      count: entries.length,
    });

    return entries;
  }

  /**
   * Blocking read for new stream entries.
   *
   * Used for real-time event streaming.
   *
   * @param streamKey - Stream name
   * @param lastId - Last seen ID (use "$" for only new entries)
   * @param options - Read options (count, blockMs)
   * @returns Array of stream entries, or empty if timeout
   */
  async xread(
    streamKey: string,
    lastId: string = "$",
    options: StreamReadOptions = {},
  ): Promise<StreamEntry[]> {
    const { count = 100, blockMs = 5000 } = options;

    const args: (string | number)[] = [];

    if (blockMs > 0) {
      args.push("BLOCK", blockMs);
    }

    args.push("COUNT", count, "STREAMS", streamKey, lastId);

    const [error, result] = await catchError(
      this.client.xread(...(args as Parameters<typeof this.client.xread>)),
    );

    if (error) {
      this.logger.error("redis-stream", "Failed to read stream", {
        streamKey,
        lastId,
        error: error.message,
      });
      throw error;
    }

    // XREAD returns null on timeout, or [[streamName, [[id, fields], ...]]]
    if (!result) {
      return [];
    }

    // Extract entries from the first (and only) stream
    const streamData = result[0];
    if (!streamData || !streamData[1]) {
      return [];
    }

    const entries: StreamEntry[] = streamData[1].map(([id, fieldsArray]) => ({
      id,
      fields: this.parseFieldsArray(fieldsArray),
    }));

    this.logger.debug?.("redis-stream", "Read new entries", {
      streamKey,
      count: entries.length,
    });

    return entries;
  }

  /**
   * Trim a stream to a maximum length.
   *
   * Use approximate trimming (~) for better performance.
   *
   * @param streamKey - Stream name
   * @param maxLen - Maximum number of entries to keep
   * @param approximate - Use approximate trimming (default: true)
   * @returns Number of entries removed
   */
  async xtrim(streamKey: string, maxLen: number, approximate: boolean = true): Promise<number> {
    const args: (string | number)[] = [streamKey, "MAXLEN"];

    if (approximate) {
      args.push("~");
    }

    args.push(maxLen);

    const [error, removed] = await catchError(
      this.client.xtrim(...(args as Parameters<typeof this.client.xtrim>)),
    );

    if (error) {
      this.logger.error("redis-stream", "Failed to trim stream", {
        streamKey,
        maxLen,
        error: error.message,
      });
      throw error;
    }

    if (removed && removed > 0) {
      this.logger.debug?.("redis-stream", "Trimmed stream", {
        streamKey,
        removed,
      });
    }

    return removed as number;
  }

  /**
   * Get the length of a stream.
   *
   * @param streamKey - Stream name
   * @returns Number of entries in the stream
   */
  async xlen(streamKey: string): Promise<number> {
    const [error, length] = await catchError(this.client.xlen(streamKey));

    if (error) {
      this.logger.error("redis-stream", "Failed to get stream length", {
        streamKey,
        error: error.message,
      });
      throw error;
    }

    return length as number;
  }

  /**
   * Delete a stream entirely.
   *
   * @param streamKey - Stream name
   * @returns True if deleted, false if didn't exist
   */
  async del(streamKey: string): Promise<boolean> {
    const [error, result] = await catchError(this.client.del(streamKey));

    if (error) {
      this.logger.error("redis-stream", "Failed to delete stream", {
        streamKey,
        error: error.message,
      });
      throw error;
    }

    return result === 1;
  }

  /**
   * Parse ioredis field array to Record.
   *
   * ioredis returns fields as [key1, value1, key2, value2, ...]
   */
  private parseFieldsArray(fieldsArray: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (let i = 0; i < fieldsArray.length; i += 2) {
      const key = fieldsArray[i];
      const value = fieldsArray[i + 1];
      if (key !== undefined && value !== undefined) {
        fields[key] = value;
      }
    }
    return fields;
  }
}
