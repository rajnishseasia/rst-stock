/**
 * @trade-bot/utils
 *
 * Shared utilities for error handling and async operations.
 */

// Error handling
export { catchError } from "./utils/catch_error.js";

// Async utilities
export { withTimeout } from "./utils/with-timeout.js";
export { withRetry, type RetryOptions } from "./utils/with-retry.js";
export {
  withRetryAndTimeout,
  type RetryWithTimeoutOptions,
} from "./utils/with-retry-and-timeout.js";

// Encryption utilities
export {
  encrypt,
  decrypt,
  encryptIfPresent,
  decryptIfPresent,
  generateEncryptionKey,
  DecryptionAuthenticationError,
} from "./utils/encryption.js";

// Signal instrument classification (perp / short vs plain equity long)
export {
  classifySignalInstrument,
  classifySignalText,
  isMirrorableEquitySignal,
  signalSideFromMetadata,
  isPerpVenue,
  isPerpInstrument,
  isShortDirection,
  type SignalDirectionSide,
  type SignalInstrumentClassification,
  type SignalTextSignals,
} from "./utils/signal-instrument.js";

// Shared bounds for values that cross ingestion, mirroring, and leaderboard math.
export {
  MAX_SAFE_TRADING_PERP_SIZE,
  MAX_SAFE_TRADING_PERP_NUMBER,
  MAX_SAFE_TRADING_VALUE,
  isSafePositiveTradingPerpDecimal,
  isSafeTradingPerpDecimal,
} from "./utils/safe-trading-number.js";

export {
  isPlausibleSourceEventTimestamp,
  isStrictSignalTickerShape,
  MAX_SOURCE_EVENT_FUTURE_SKEW_MS,
  STRICT_SIGNAL_TICKER_PATTERN,
} from "./utils/signal-ticker.js";

// Canonical source-author identity shared by ingestion, API matching, and UI readers.
export {
  CANONICAL_AUTHOR_KEY_PREFIX,
  SOURCE_AUTHOR_ALIAS_KEY_PREFIX,
  authorMatchKeys,
  buildCanonicalAuthorMetadata,
  canonicalAuthorKey,
  canonicalAuthorSource,
  isCanonicalAuthorKey,
  isSourceAuthorAliasKey,
  normalizeAuthorAlias,
  parseSourceAuthorAliasKey,
  readCanonicalAuthor,
  readCanonicalAuthorForSource,
  resolveCanonicalAuthorAlias,
  type CanonicalAliasObservation,
  type CanonicalAuthorObservation,
  type CanonicalAuthorView,
  type CanonicalAuthorIdentityKind,
  sourceAuthorAliasKey,
} from "./utils/canonical-author.js";
