/**
 * Types shared between the Python Discord reader and the TypeScript worker
 * poller for external Discord signal execution.
 *
 * The Python bot pushes one Redis stream entry per detected signal. All Redis
 * stream fields are strings; arrays are JSON-encoded. The worker parses them
 * back into this shape.
 */

export interface ExternalDiscordSignal {
  /** Schema version - always "1" for now. */
  v: string;
  /** Discord snowflake message ID. Used as the idempotency key. */
  messageId: string;
  /** Discord channel ID the message came from. */
  channelId: string;
  /** Display name of the author. */
  authorName: string;
  /** Immutable Discord user ID when the upstream event exposes it. */
  authorId: string;
  /** Mutable Discord username, retained as an alias for display/follow lookup. */
  authorHandle?: string;
  /** Absolute Discord avatar URL when available. */
  authorAvatar?: string;
  /** Absolute permalink to the original Discord message, when available. */
  sourceUrl?: string;
  /** ISO 8601 timestamp of the original Discord message. */
  messageTimestamp: string;
  /** Full original message text, unmodified. */
  rawMessage: string;
  /**
   * Hyperliquid coin ticker in its canonical spelling, with no $ sign.
   * e.g. "LIT", "kPEPE", "xyz:GOOGL".
   */
  coin: string;
  /** Direction. Neil only calls longs, but the field supports both. */
  side: "long" | "short";
  /**
   * Entry price as a decimal string, or empty string for a market/CMP order.
   * When empty the worker uses the live Hyperliquid mid price for sizing.
   */
  entryPrice: string;
  /**
   * Hard stop-loss price as a decimal string. Extracted from the "close under X
   * for stops" / "SL X" text in the message. Required for trade execution.
   */
  stopLoss: string;
  /**
   * Take-profit levels as a JSON-encoded array of decimal strings.
   * Usually empty ("[]") because Neil posts TPs on chart images.
   */
  takeProfits: string;
  /**
   * True when this is a new trade entry. False for updates, TP hits, closes,
   * analysis posts, or anything else. The worker only acts when this is "true".
   */
  isNewEntry: string;
  /** "high" | "medium" | "low" - how confident the parser was. */
  confidence: string;
  /** ISO 8601 timestamp when the Python script processed this message. */
  parsedAt: string;
}

/** Parsed (typed) version after the worker converts string fields. */
export interface ParsedSignal {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorHandle: string | null;
  authorAvatar: string | null;
  sourceUrl: string | null;
  rawMessage: string;
  coin: string;
  side: "long" | "short";
  entryPrice: number | null;
  /**
   * Null when the message carried no stop. The worker then derives one at 20%
   * adverse to the live entry (see slFallback). Sizing is risk/stop-distance,
   * so a wider derived stop yields a smaller position at the same dollar risk.
   */
  stopLoss: number | null;
  /** True when stopLoss was absent and the -20% fallback applies. */
  slFallback: boolean;
  takeProfits: number[];
  confidence: "high" | "medium" | "low";
  parsedAt: Date;
  messageTimestamp: Date;
}

/**
 * Exit instructions the Discord bot emits alongside entries (wire format v2).
 *
 * These never open exposure. Every one of them resolves the follower's LIVE
 * position first and acts reduce-only, so a mis-parsed message can shrink or
 * protect a position but can never create one.
 */
export type ExternalDiscordExitAction = "close" | "reduce" | "stop_be";

export interface ParsedExitSignal {
  action: ExternalDiscordExitAction;
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  rawMessage: string;
  coin: string;
  /**
   * Percentage of the live position to close, 0 < pct <= 100.
   * Only present for action "reduce"; null for every other action.
   */
  reducePct: number | null;
  parsedAt: Date;
  messageTimestamp: Date;
}

export interface FollowerConfig {
  email: string;
  riskPerTradeUsd: number;
  leverage: number;
  marginMode: "cross" | "isolated";
  enabled: boolean;
}

/**
 * One sliding-window cap on how many positions automation may OPEN.
 * `maxOpens: 0` blocks entries outright - a way to pause a channel without
 * disabling the follower.
 */
export interface OpenRateLimitWindow {
  windowSeconds: number;
  maxOpens: number;
}

/**
 * Per-Discord-channel execution policy, keyed by channel snowflake.
 *
 * Following is per channel, not global: the same person can size a call from
 * one caller at $150 of risk and a call from another at $10. A channel with no
 * entry here is not followed at all, so a new caller cannot be executed by
 * accident just because the Discord bot started forwarding their messages.
 */
export interface ChannelConfig {
  /** Human label for logs and for reading the config file. Not used in logic. */
  label?: string;
  /**
   * False pauses the channel's ENTRIES without deleting its followers.
   * Exits still route (see `FollowersConfigFile`), because a paused caller may
   * still be managing a position opened while the channel was live.
   * Absent means true.
   */
  enabled: boolean;
  openRateLimits: OpenRateLimitWindow[];
  /** Who follows this channel, and at what size. May be empty. */
  followers: FollowerConfig[];
}

/**
 * Entries execute for a channel's followers only when both the channel and the
 * follower are enabled. Exits execute for every follower listed on the channel
 * regardless of either flag: an exit is reduce-only and can never create
 * exposure, so refusing to run one can only strand a live position.
 */
export interface FollowersConfigFile {
  minConfidence: "high" | "medium" | "low";
  /** Applied to any channel that does not set its own `openRateLimits`. */
  defaultOpenRateLimits: OpenRateLimitWindow[];
  channels: Record<string, ChannelConfig>;
}
