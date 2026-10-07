/**
 * Source-qualified author identity helpers shared by ingestion and readers.
 *
 * A canonical key is deliberately based on the immutable source ID rather than
 * a handle or display name. The key is reversible enough to remain useful for
 * server-side diagnostics, but it is source-qualified so an identical numeric
 * ID from two systems can never merge.
 */

export const CANONICAL_AUTHOR_KEY_PREFIX = "source_author:";
export const SOURCE_AUTHOR_ALIAS_KEY_PREFIX = "source_alias:";

export type CanonicalAuthorIdentityKind = "source_author" | "relay" | "unknown";

export interface CanonicalAuthorObservation {
  source: string;
  sourceAuthorId?: string | null;
  identityKind?: CanonicalAuthorIdentityKind;
  currentHandle?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  /** Aliases already checked against the durable identity table for ambiguity. */
  safeAliases?: readonly string[];
}

export interface CanonicalAuthorView {
  source: string | null;
  sourceAuthorId: string | null;
  canonicalAuthorKey: string | null;
  identityKind: CanonicalAuthorIdentityKind;
  authorName: string;
  authorHandle: string | null;
  authorAvatar: string | null;
  authorAliases: string[];
  authorAliasHistory: string[];
}

export interface CanonicalAliasObservation {
  source: string;
  canonicalKey: string;
  aliases: readonly string[];
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return metadataRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\s*[•·|–-]\s*TweetShift\s*$/i, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned || null;
}

function normalizedSource(value: unknown): string | null {
  const source = cleanText(value)?.toLowerCase() ?? null;
  return source && source.length <= 80 ? source : null;
}

function normalizedSourceAuthorId(value: unknown): string | null {
  const id = cleanText(value);
  return id && id.length <= 256 ? id : null;
}

function validIdentityKind(value: unknown): CanonicalAuthorIdentityKind | null {
  return value === "source_author" || value === "relay" || value === "unknown"
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/** Normalize a handle/display-name alias for matching only. */
export function normalizeAuthorAlias(value: unknown): string | null {
  const cleaned = cleanText(value)?.replace(/^@+/, "").trim().toLowerCase() ?? null;
  return cleaned && cleaned !== "unknown" ? cleaned : null;
}

/** Build the stable public follow/profile key for an immutable source ID. */
export function canonicalAuthorKey(
  source: string | null | undefined,
  sourceAuthorId: string | null | undefined,
): string | null {
  const normalizedSourceValue = normalizedSource(source);
  const normalizedId = normalizedSourceAuthorId(sourceAuthorId);
  if (!normalizedSourceValue || !normalizedId) return null;
  const key = `${CANONICAL_AUTHOR_KEY_PREFIX}${encodeURIComponent(normalizedSourceValue)}:${encodeURIComponent(normalizedId)}`;
  return key.length <= 256 ? key : null;
}

/** Return the source embedded in a canonical author key, if it is valid. */
export function canonicalAuthorSource(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(CANONICAL_AUTHOR_KEY_PREFIX)) {
    return null;
  }
  const body = value.slice(CANONICAL_AUTHOR_KEY_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0 || separator >= body.length - 1) return null;
  try {
    const source = decodeURIComponent(body.slice(0, separator));
    const sourceAuthorId = decodeURIComponent(body.slice(separator + 1));
    return canonicalAuthorKey(source, sourceAuthorId) === value ? source : null;
  } catch {
    return null;
  }
}

export function isCanonicalAuthorKey(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(CANONICAL_AUTHOR_KEY_PREFIX)) {
    return false;
  }
  const body = value.slice(CANONICAL_AUTHOR_KEY_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0 || separator >= body.length - 1 || value.length > 256) {
    return false;
  }
  try {
    const source = decodeURIComponent(body.slice(0, separator));
    const sourceAuthorId = decodeURIComponent(body.slice(separator + 1));
    return canonicalAuthorKey(source, sourceAuthorId) === value;
  } catch {
    return false;
  }
}

/** Build the source-qualified compatibility key for a mutable alias. */
export function sourceAuthorAliasKey(
  source: string | null | undefined,
  alias: string | null | undefined,
): string | null {
  const normalizedSourceValue = normalizedSource(source);
  const normalizedAlias = normalizeAuthorAlias(alias);
  if (!normalizedSourceValue || !normalizedAlias) return null;
  const key = `${SOURCE_AUTHOR_ALIAS_KEY_PREFIX}${encodeURIComponent(normalizedSourceValue)}:${encodeURIComponent(normalizedAlias)}`;
  return key.length <= 256 ? key : null;
}

/** Parse a source-qualified alias key without accepting an unqualified alias. */
export function parseSourceAuthorAliasKey(
  value: unknown,
): { source: string; alias: string } | null {
  if (typeof value !== "string" || !value.startsWith(SOURCE_AUTHOR_ALIAS_KEY_PREFIX)) {
    return null;
  }
  const body = value.slice(SOURCE_AUTHOR_ALIAS_KEY_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0 || separator >= body.length - 1 || value.length > 256) return null;
  try {
    const source = decodeURIComponent(body.slice(0, separator));
    const alias = decodeURIComponent(body.slice(separator + 1));
    return sourceAuthorAliasKey(source, alias) === value ? { source, alias } : null;
  } catch {
    return null;
  }
}

export function isSourceAuthorAliasKey(value: unknown): value is string {
  return parseSourceAuthorAliasKey(value) !== null;
}

function safeAuthorAliases(
  value: unknown,
): string[] {
  const explicit = stringArray(value)
    .map((alias) => normalizeAuthorAlias(alias))
    .filter((alias): alias is string => alias !== null);
  return unique(explicit);
}

function isRelayMetadata(record: Record<string, unknown>): boolean {
  if (record.authorIdentityKind === "relay" || record.authorIsRelay === true) return true;
  return ["webhookId", "webhook_id", "authorWebhookId"].some(
    (key) => normalizedSourceAuthorId(record[key]) !== null,
  ) || record.authorIsBot === true || /^TweetShift$/i.test(
    typeof record.authorName === "string" ? record.authorName.trim() : "",
  );
}

/** Read a canonical identity view from old or new JSON metadata. */
export function readCanonicalAuthor(metadata: unknown): CanonicalAuthorView {
  const record = metadataRecord(metadata);
  const relay = isRelayMetadata(record);
  const explicitKind = validIdentityKind(record.authorIdentityKind);
  const storedKey = !relay && isCanonicalAuthorKey(record.canonicalAuthorKey)
    ? record.canonicalAuthorKey
    : null;
  const keySource = canonicalAuthorSource(storedKey);
  const source = normalizedSource(record.authorSource) ?? keySource;
  const explicitSourceAuthorId = normalizedSourceAuthorId(record.sourceAuthorId);
  const sourceAuthorId = relay
    ? null
    : explicitSourceAuthorId ?? (
        storedKey && keySource && (!source || keySource === source)
          ? decodeCanonicalAuthorId(storedKey)
          : null
      );
  const canonicalKey = relay
    ? null
    : storedKey && (!source || keySource === source)
      ? storedKey
      : canonicalAuthorKey(source, explicitSourceAuthorId);
  const identityKind: CanonicalAuthorIdentityKind = relay
    ? "relay"
    : explicitKind ?? (sourceAuthorId || canonicalKey ? "source_author" : "unknown");
  const authorHandle = cleanText(record.authorHandle);
  const authorName = cleanText(record.authorName) ?? authorHandle ?? "Unknown";
  const currentAliases = [
    normalizeAuthorAlias(authorName),
    normalizeAuthorAlias(authorHandle),
  ].filter((alias): alias is string => alias !== null);
  const authorAliasHistory = unique([
    ...stringArray(record.authorAliasHistory)
      .map((alias) => normalizeAuthorAlias(alias))
      .filter((alias): alias is string => alias !== null),
    ...stringArray(record.authorAliases)
      .map((alias) => normalizeAuthorAlias(alias))
      .filter((alias): alias is string => alias !== null),
    ...currentAliases,
  ]);
  const authorAliases = safeAuthorAliases(record.authorAliases);
  const authorAvatar = cleanText(record.authorAvatar);

  return {
    source,
    sourceAuthorId,
    canonicalAuthorKey: canonicalKey,
    identityKind,
    authorName,
    authorHandle,
    authorAvatar,
    authorAliases,
    authorAliasHistory,
  };
}

/** Resolve legacy signal metadata when the row source is stored beside it. */
export function readCanonicalAuthorForSource(
  metadata: unknown,
  source: string | null | undefined,
): CanonicalAuthorView {
  const record = metadataRecord(metadata);
  if (source) record.authorSource = source;
  return readCanonicalAuthor(record);
}

function decodeCanonicalAuthorId(value: string): string | null {
  const body = value.slice(CANONICAL_AUTHOR_KEY_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0 || separator >= body.length - 1) return null;
  try {
    return normalizedSourceAuthorId(decodeURIComponent(body.slice(separator + 1)));
  } catch {
    return null;
  }
}

/**
 * Merge one observed identity into metadata while retaining the full alias
 * history. `safeAliases` is optional because pure mappers cannot prove that an
 * alias is unique across all identities; the durable store supplies it later.
 */
export function buildCanonicalAuthorMetadata(
  existing: unknown,
  observation: CanonicalAuthorObservation,
): Record<string, unknown> {
  const record = metadataRecord(existing);
  const current = readCanonicalAuthor(record);
  const source = normalizedSource(observation.source) ?? current.source;
  const observedIdentityKind = observation.identityKind ?? (
    observation.sourceAuthorId ? "source_author" : current.identityKind
  );
  const isRelay = observedIdentityKind === "relay";
  const sourceAuthorId = isRelay
    ? null
    : normalizedSourceAuthorId(observation.sourceAuthorId) ?? current.sourceAuthorId;
  const canonicalKey =
    isRelay ? null : canonicalAuthorKey(source, sourceAuthorId) ?? current.canonicalAuthorKey;
  const observedName = cleanText(observation.displayName);
  const observedHandle = cleanText(observation.currentHandle);
  const observedAvatar = cleanText(observation.avatar);
  const aliases = [
    ...current.authorAliasHistory,
    normalizeAuthorAlias(observedName),
    normalizeAuthorAlias(observedHandle),
  ].filter((alias): alias is string => alias !== null);
  const aliasHistory = unique(aliases);
  const explicitlySafe = (observation.safeAliases ?? [])
    .map((alias) => normalizeAuthorAlias(alias))
    .filter((alias): alias is string => alias !== null);
  const safeAliases = unique([
    ...current.authorAliases,
    ...explicitlySafe,
  ]);

  if (source) record.authorSource = source;
  record.authorIdentityKind = observedIdentityKind;
  if (isRelay) {
    delete record.sourceAuthorId;
    delete record.canonicalAuthorKey;
    delete record.authorAliases;
  } else {
    if (sourceAuthorId) record.sourceAuthorId = sourceAuthorId;
    if (canonicalKey) record.canonicalAuthorKey = canonicalKey;
  }
  if (observedName) record.authorName = observedName;
  if (observedHandle) record.authorHandle = observedHandle;
  if (observedAvatar) record.authorAvatar = observedAvatar;
  if (aliasHistory.length > 0) record.authorAliasHistory = aliasHistory;
  if (!isRelay && safeAliases.length > 0) record.authorAliases = safeAliases;

  return record;
}

/** Return keys that may be used for a compatibility follow lookup. */
export function authorMatchKeys(metadata: unknown): string[] {
  const view = readCanonicalAuthor(metadata);
  if (view.identityKind === "relay") return [];
  const fallback = normalizeAuthorAlias(view.authorName);
  const aliases = [...view.authorAliases, ...view.authorAliasHistory]
    .map((alias) => view.source
      ? sourceAuthorAliasKey(view.source, alias)
      : normalizeAuthorAlias(alias))
    .filter((alias): alias is string => alias !== null);
  return unique([
    ...(view.canonicalAuthorKey ? [view.canonicalAuthorKey] : []),
    ...aliases,
    ...(view.source ? [] : fallback ? [fallback] : []),
  ]);
}

/** Resolve a non-canonical alias only when it has one unambiguous owner. */
export function resolveCanonicalAuthorAlias(
  alias: string,
  source: string | null | undefined,
  observations: readonly CanonicalAliasObservation[],
): string | null {
  const parsedKey = parseSourceAuthorAliasKey(alias);
  const normalizedAlias = normalizeAuthorAlias(parsedKey?.alias ?? alias);
  const normalizedSourceValue = normalizedSource(source) ?? parsedKey?.source ?? null;
  if (parsedKey && normalizedSourceValue !== parsedKey.source) return null;
  if (!normalizedAlias) return null;
  const owners = new Set<string>();
  for (const observation of observations) {
    if (!isCanonicalAuthorKey(observation.canonicalKey)) continue;
    const observationSource = normalizedSource(observation.source) ?? canonicalAuthorSource(observation.canonicalKey);
    if (!normalizedSourceValue || observationSource !== normalizedSourceValue) continue;
    if (
      observation.aliases.some(
        (candidate) => normalizeAuthorAlias(parseSourceAuthorAliasKey(candidate)?.alias ?? candidate) === normalizedAlias,
      )
    ) {
      owners.add(observation.canonicalKey);
    }
  }
  return owners.size === 1 ? [...owners][0]! : null;
}
