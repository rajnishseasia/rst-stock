/**
 * Strict shape shared by external signal parsers. Separators are allowed only
 * between non-empty alphanumeric segments, and slash is never a ticker
 * separator. Venue-qualified symbols use exactly one colon.
 */
export const STRICT_SIGNAL_TICKER_PATTERN =
  /^(?:[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*|[A-Za-z0-9]+:[A-Za-z0-9]+)$/;

export function isStrictSignalTickerShape(value: unknown): value is string {
  return typeof value === "string" && STRICT_SIGNAL_TICKER_PATTERN.test(value);
}

/** Maximum source timestamp skew accepted by pollers. */
export const MAX_SOURCE_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isPlausibleSourceEventTimestamp(
  timestamp: Date,
  now: Date = new Date(),
): boolean {
  return timestamp.getTime() <= now.getTime() + MAX_SOURCE_EVENT_FUTURE_SKEW_MS;
}
