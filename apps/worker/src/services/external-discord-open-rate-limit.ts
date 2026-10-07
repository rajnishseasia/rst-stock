/**
 * Per-channel rate limiting for external Discord signal ENTRIES.
 *
 * A caller can post a burst of setups faster than an account should absorb
 * them. These limits cap how many positions automation will open on a
 * follower's behalf from a given channel, over one or more sliding windows
 * (e.g. at most 1 per 10 minutes and 5 per 24 hours).
 *
 * Two deliberate boundaries:
 *
 *   - EXITS ARE NEVER RATE LIMITED. Refusing to close a position because a
 *     counter is full would turn a safety feature into a way to be trapped in a
 *     trade. Only `open` passes through here.
 *   - Budget is consumed by positions actually OPENED, not by attempts. A
 *     rejected or failed order leaves the budget untouched.
 *
 * Counters are keyed per (channel, follower), so one channel going quiet or
 * loud cannot spend another channel's budget, and two followers of the same
 * channel each get their own allowance.
 */

import type { OpenRateLimitWindow } from "./external-discord-signal-types";

/** Sliding-window counters live under this Redis key prefix. */
export const OPEN_RATE_LIMIT_KEY_PREFIX = "discord:external:opens";

export function openRateLimitKey(channelId: string, followerUserId: string): string {
  return `${OPEN_RATE_LIMIT_KEY_PREFIX}:${channelId}:${followerUserId}`;
}

/** Longest window in the set, which is how long counters need to be retained. */
export function longestWindowSeconds(windows: OpenRateLimitWindow[]): number {
  return windows.reduce((max, window) => Math.max(max, window.windowSeconds), 0);
}

export interface RateLimitDecision {
  allowed: boolean;
  /** The first window that is already full. Null when allowed. */
  exceeded: OpenRateLimitWindow | null;
  /** Opens counted inside `exceeded`. Null when allowed. */
  observed: number | null;
  /**
   * When the oldest open in the exceeded window ages out, in ms since epoch.
   * Null when allowed. Purely informational - used for the log line so an
   * operator can see when the next entry becomes possible.
   */
  retryAtMs: number | null;
}

/**
 * Decide whether one more open is permitted.
 *
 * `openTimestampsMs` is every recorded open for this (channel, follower),
 * newest or oldest order irrelevant. Timestamps outside every window are
 * ignored here and pruned separately in Redis.
 *
 * A window with maxOpens 0 blocks unconditionally, which is a supported way to
 * pause automation for a channel without disabling the follower.
 */
export function evaluateOpenRateLimit(
  openTimestampsMs: number[],
  nowMs: number,
  windows: OpenRateLimitWindow[],
): RateLimitDecision {
  for (const window of windows) {
    const cutoff = nowMs - window.windowSeconds * 1000;
    const inWindow = openTimestampsMs.filter((timestamp) => timestamp > cutoff);
    if (inWindow.length >= window.maxOpens) {
      const oldest = inWindow.length > 0 ? Math.min(...inWindow) : null;
      return {
        allowed: false,
        exceeded: window,
        observed: inWindow.length,
        retryAtMs: oldest === null ? null : oldest + window.windowSeconds * 1000,
      };
    }
  }
  return { allowed: true, exceeded: null, observed: null, retryAtMs: null };
}
