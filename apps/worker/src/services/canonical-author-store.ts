import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  buildCanonicalAuthorMetadata,
  canonicalAuthorKey,
  normalizeAuthorAlias,
  readCanonicalAuthor,
  type CanonicalAuthorObservation,
} from "@trade-bot/utils";

type AuthorStoreDb = WorkerPoolDb;

function hasAuthorStore(db: AuthorStoreDb): boolean {
  const query = (db as unknown as { query?: Record<string, unknown> }).query;
  return Boolean(
    query?.sourceAuthorIdentities &&
      query.sourceAuthorAliases &&
      typeof (db as unknown as { insert?: unknown }).insert === "function",
  );
}

async function executeInsert(builder: unknown): Promise<void> {
  if (!builder || typeof builder !== "object") return;
  const value = builder as {
    onConflictDoNothing?: () => Promise<unknown>;
    then?: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => unknown;
  };
  if (typeof value.onConflictDoNothing === "function") {
    await value.onConflictDoNothing();
    return;
  }
  if (typeof value.then === "function") {
    await new Promise<void>((resolve, reject) => {
      value.then?.(() => resolve(), reject);
    });
  }
}

/**
 * Persist one source-author observation and return metadata with the durable,
 * unambiguous aliases available at the time of observation.
 *
 * Test doubles and old development schemas may not expose the new tables. In
 * that case the pure metadata result is still returned, while the compatibility
 * gate prevents a production worker from starting against that schema.
 */
export async function observeCanonicalAuthor(
  db: AuthorStoreDb,
  existingMetadata: unknown,
  observation: CanonicalAuthorObservation,
): Promise<{ metadata: Record<string, unknown>; sourceAuthorId: string | null }> {
  const baseMetadata = buildCanonicalAuthorMetadata(existingMetadata, observation);
  const key = canonicalAuthorKey(observation.source, observation.sourceAuthorId);
  const sourceAuthorId = observation.identityKind === "relay"
    ? null
    : observation.sourceAuthorId?.trim() || null;
  if (!key || !sourceAuthorId || !hasAuthorStore(db)) {
    return { metadata: baseMetadata, sourceAuthorId };
  }

  const observedAt = new Date();
  const currentHandle = observation.currentHandle?.trim() || null;
  const displayName = observation.displayName?.trim() || null;
  const avatarUrl = observation.avatar?.trim() || null;
  const dbAny = db as any;
  const identityUpdates: Record<string, unknown> = {
    lastSeenAt: observedAt,
    updatedAt: observedAt,
  };
  // A partial upstream observation must not erase the last known identity
  // label or avatar. Null here means "not supplied", not "delete it".
  if (currentHandle) identityUpdates.currentHandle = currentHandle;
  if (displayName) identityUpdates.currentDisplayName = displayName;
  if (avatarUrl) identityUpdates.avatarUrl = avatarUrl;

  await executeInsert(
    dbAny
      .insert(schema.sourceAuthorIdentities)
      .values({
        source: observation.source,
        sourceAuthorId,
        canonicalKey: key,
        currentHandle,
        currentDisplayName: displayName,
        avatarUrl,
        lastSeenAt: observedAt,
      })
      .onConflictDoUpdate({
        target: [schema.sourceAuthorIdentities.source, schema.sourceAuthorIdentities.sourceAuthorId],
        set: identityUpdates,
      }),
  );

  const identity = await db.query.sourceAuthorIdentities.findFirst({
    where: and(
      eq(schema.sourceAuthorIdentities.source, observation.source),
      eq(schema.sourceAuthorIdentities.sourceAuthorId, sourceAuthorId),
    ),
    columns: { id: true },
  });
  if (!identity) return { metadata: baseMetadata, sourceAuthorId };

  const observedAliases = [
    ...readCanonicalAuthor(baseMetadata).authorAliasHistory,
    normalizeAuthorAlias(observation.currentHandle),
    normalizeAuthorAlias(observation.displayName),
  ].filter((alias): alias is string => alias !== null).filter(
    (alias, index, aliases) => aliases.indexOf(alias) === index,
  );
  for (const alias of observedAliases) {
    await executeInsert(
      dbAny
        .insert(schema.sourceAuthorAliases)
        .values({
          identityId: identity.id,
          source: observation.source,
          alias,
          lastSeenAt: observedAt,
        })
        .onConflictDoUpdate({
          target: [schema.sourceAuthorAliases.identityId, schema.sourceAuthorAliases.alias],
          set: { lastSeenAt: observedAt, updatedAt: observedAt },
        }),
    );
  }

  const aliasRows = observedAliases.length > 0
    ? await db
        .select({ alias: schema.sourceAuthorAliases.alias, identityId: schema.sourceAuthorAliases.identityId })
        .from(schema.sourceAuthorAliases)
        .where(
          and(
            eq(schema.sourceAuthorAliases.source, observation.source),
            inArray(schema.sourceAuthorAliases.alias, observedAliases),
          ),
        )
    : [];
  const owners = new Map<string, Set<string>>();
  for (const row of aliasRows) {
    const ownerSet = owners.get(row.alias) ?? new Set<string>();
    ownerSet.add(row.identityId);
    owners.set(row.alias, ownerSet);
  }
  const safeAliases = observedAliases.filter(
    (alias) => owners.get(alias)?.size === 1 && owners.get(alias)?.has(identity.id),
  );
  const metadata = buildCanonicalAuthorMetadata(baseMetadata, {
    ...observation,
    safeAliases,
  });
  // Replacing this list is intentional. An alias that was once unique can
  // become ambiguous after another identity claims it, and it must stop being
  // used for compatibility matching without deleting historical evidence.
  metadata.authorAliases = safeAliases;

  return {
    metadata,
    sourceAuthorId,
  };
}

/** Best-effort enrichment for ingestion paths that must keep old test doubles usable. */
export async function tryObserveCanonicalAuthor(
  db: AuthorStoreDb,
  existingMetadata: unknown,
  observation: CanonicalAuthorObservation,
): Promise<{ metadata: Record<string, unknown>; sourceAuthorId: string | null }> {
  try {
    return await observeCanonicalAuthor(db, existingMetadata, observation);
  } catch (error) {
    if (hasAuthorStore(db)) throw error;
    return {
      metadata: buildCanonicalAuthorMetadata(existingMetadata, observation),
      sourceAuthorId: observation.identityKind === "relay"
        ? null
        : observation.sourceAuthorId?.trim() || null,
    };
  }
}
