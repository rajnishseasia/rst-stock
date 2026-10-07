/**
 * Per-person, per-ticker throttle for venue-close Discord alerts.
 *
 * A Hyperliquid stop does not have to fill in one go. A single stop on ENA came
 * back as two fills a fraction of a cent apart, and because each external fill
 * is ingested as its own order row, each one produced its own "🛑 STOP HIT"
 * line:
 *
 *   🛑 STOP HIT - ✅ Close 5561.0 ENA @ $0.15251 (market) [at venue]
 *   🛑 STOP HIT - ✅ Close 15521.0 ENA @ $0.15252 (market) [at venue]
 *
 * That is one event reported twice, and it reads as two stop-outs. So the first
 * close alert for a (person, ticker) wins and the rest of the minute is dropped.
 *
 * Scope: venue closes are throttled, including manual closes whose fill rows do
 * not carry a `closeReason`. Ordinary fills are not deduplicated, because two
 * orders a user places on the same ticker inside a minute are two real actions,
 * and silently swallowing the second would be worse than a duplicate line. A
 * venue-close, by contrast, can be split into several fill rows for one order.
 *
 * The window is in memory and therefore per worker process. The worker runs as
 * a single instance, so this covers the observed duplication; it is a display
 * throttle, not a correctness guarantee, and nothing but the webhook depends on
 * it (the order rows are all still written).
 */

/** How long one (person, ticker, reason) alert silences its repeats. */
export const CLOSE_ALERT_WINDOW_MS = 60_000;

/**
 * How many keys to hold before sweeping expired ones. Sweeping is O(size) and
 * only pays off once the map is big enough to matter, so it runs on a threshold
 * rather than on every alert.
 */
const SWEEP_AT_SIZE = 512;

/** The fields the throttle key is derived from. A structural subset of `OrderNotification`. */
export interface ThrottledAlert {
  symbol: string;
  userId?: string | null;
  side?: string | null;
  externalOrigin?: boolean;
  reduceOnly?: boolean | null;
  closeReason?: "stop_loss" | "take_profit" | "liquidation" | null;
}

/**
 * The throttle key for an alert, or `null` when it is not subject to throttling.
 *
 * A reason always proves this is a position close. For otherwise-unclassified
 * external fills, reduce-only or an explicit closing trade action proves the
 * same thing. This matters for Hyperliquid manual closes: one order can produce
 * several fill rows, but those rows have no stop/target/liquidation reason.
 *
 * Null for ordinary fills and for anything without a user id: an alert we
 * cannot attribute to a person cannot be rate-limited per person, and guessing
 * a shared key would let one user's close silence another's.
 */
export function closeAlertKey(alert: ThrottledAlert): string | null {
  const closingSide =
    alert.side === "SellToClose" ||
    alert.side === "BuyToClose" ||
    alert.side === "BuyToCover";
  const isVenueClose =
    Boolean(alert.closeReason) ||
    (alert.externalOrigin === true && (alert.reduceOnly === true || closingSide));
  if (!isVenueClose) return null;
  const userId = alert.userId?.trim();
  if (!userId) return null;
  const symbol = alert.symbol?.trim().toUpperCase();
  if (!symbol) return null;
  // Use one shared close class so inconsistent reason enrichment across pieces
  // of the same venue order cannot leak a second alert.
  return `${userId}\u0000${symbol}\u0000close`;
}

export interface AlertThrottle {
  /**
   * Whether to send this alert now. Records the send when it returns true, so
   * call it exactly once per alert, immediately before sending.
   */
  allow: (alert: ThrottledAlert) => boolean;
}

/**
 * Build a throttle. `now` is injectable so tests can advance the clock instead
 * of sleeping through a real minute.
 */
export function createCloseAlertThrottle({
  windowMs = CLOSE_ALERT_WINDOW_MS,
  now = () => Date.now(),
}: { windowMs?: number; now?: () => number } = {}): AlertThrottle {
  const sentAt = new Map<string, number>();

  return {
    allow(alert) {
      const key = closeAlertKey(alert);
      // Not a throttled class of alert: always send, and do not grow the map.
      if (key === null) return true;

      const at = now();
      const previous = sentAt.get(key);
      if (previous !== undefined && at - previous < windowMs) return false;

      if (sentAt.size >= SWEEP_AT_SIZE) {
        for (const [existing, when] of sentAt) {
          if (at - when >= windowMs) sentAt.delete(existing);
        }
      }
      sentAt.set(key, at);
      return true;
    },
  };
}
