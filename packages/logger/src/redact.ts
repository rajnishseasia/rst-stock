/**
 * Secret redaction for structured log context (audit L1).
 *
 * The logger serializes arbitrary context objects to console/file/HTTP
 * transports. Nothing previously stopped a caller from accidentally logging
 * a decrypted broker secret or auth header. This module recursively replaces
 * values whose KEY looks secret-bearing before anything is serialized.
 *
 * Key-based matching (not value sniffing) keeps false positives near zero:
 * a value is only redacted when its key names it as sensitive.
 */

const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|api[-_]?key|authorization|auth[-_]?header|cookie|credential|private[-_]?key|encryption[-_]?key|access[-_]?key)/i;

const MAX_DEPTH = 6;

export const REDACTED = "[REDACTED]";

/** True when a context key should have its value hidden. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Returns a deep copy of `value` with secret-keyed values replaced by
 * "[REDACTED]". Non-objects pass through. Cycles/depth are bounded so a
 * pathological context object cannot hang the logger.
 */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    // Fail safe at the depth cutoff: an uninspected subtree could contain
    // secret-keyed values, so truncate it entirely rather than pass it
    // through unredacted.
    return REDACTED as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }
  if (value instanceof Error || value instanceof Date) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactSecrets(entry, depth + 1);
    }
  }
  return out as T;
}
