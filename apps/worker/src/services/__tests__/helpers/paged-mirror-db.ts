import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@trade-bot/db";

/**
 * A worker-pool db stand-in for discovery's keyset-paged source scans.
 *
 * `findMirrorCandidateSources` captures a created_at/id fence per source table
 * before it pages, then walks social trades and signals with `orderBy` +
 * `limit`. This models exactly that call shape over in-memory rows: `bounded`
 * applies the ingest window, `newest` answers the fence read, and each source
 * hands back one page per `limit` call so the caller's loop terminates.
 *
 * Shared by every test that drives real discovery, so the fixture only has to
 * be taught a new query shape once when the scan changes.
 */
export function createPagedMirrorDb(options: {
  signalRows?: readonly Record<string, unknown>[];
  socialRows?: readonly Record<string, unknown>[];
  aliasRows?: readonly Record<string, unknown>[];
  windowStart: Date;
  windowEnd: Date;
}) {
  let selected: "signals" | "social" | "aliases" | "identities" = "signals";
  let signalPage = 0;
  let socialPage = 0;
  let aliasQueryParams: unknown[] = [];
  const signalLimitCalls: number[] = [];
  const socialLimitCalls: number[] = [];
  let orderByCalls = 0;

  const signalRows = [...(options.signalRows ?? [])];
  const socialRows = [...(options.socialRows ?? [])];
  const aliasRows = [...(options.aliasRows ?? [])];
  const bounded = (rows: readonly Record<string, unknown>[]) => rows
    .filter((row) => {
      const createdAt = row.createdAt;
      return createdAt instanceof Date &&
        createdAt > options.windowStart &&
        createdAt <= options.windowEnd;
    })
    .sort((left, right) => {
      const leftAt = (left.createdAt as Date).getTime();
      const rightAt = (right.createdAt as Date).getTime();
      return leftAt - rightAt || String(left.id).localeCompare(String(right.id));
    });
  const newest = (rows: readonly Record<string, unknown>[]) => [...rows]
    .filter((row) => row.createdAt instanceof Date)
    .sort((left, right) => {
      const leftAt = (left.createdAt as Date).getTime();
      const rightAt = (right.createdAt as Date).getTime();
      return rightAt - leftAt || String(right.id).localeCompare(String(left.id));
    })
    .slice(0, 1);

  const query: any = {
    from(table: unknown) {
      if (table === schema.signals) selected = "signals";
      else if (table === schema.sourceAuthorAliases) selected = "aliases";
      else if (table === schema.sourceAuthorIdentities) selected = "identities";
      else selected = "social";
      return query;
    },
    innerJoin() {
      return query;
    },
    where(condition: unknown) {
      if (selected === "aliases") {
        aliasQueryParams = new PgDialect().sqlToQuery(condition as never).params;
      }
      return query;
    },
    orderBy() {
      orderByCalls += 1;
      return query;
    },
    limit(limit: number) {
      if (selected === "aliases") {
        const hasLegacyQualifiedKey = aliasQueryParams.includes("source_alias:x:shared");
        return Promise.resolve(hasLegacyQualifiedKey ? [] : aliasRows.slice(0, limit));
      }
      if (selected === "identities") return Promise.resolve([]);
      if (selected === "signals") {
        signalLimitCalls.push(limit);
        if (limit === 1) return Promise.resolve(newest(signalRows));
        if (limit >= 5_000) return Promise.resolve(signalRows.slice(0, limit));
        const rows = bounded(signalRows);
        const page = rows.slice(signalPage * limit, (signalPage + 1) * limit);
        signalPage += 1;
        return Promise.resolve(page);
      }
      socialLimitCalls.push(limit);
      if (limit === 1) return Promise.resolve(newest(socialRows));
      const rows = bounded(socialRows);
      const page = rows.slice(socialPage * limit, (socialPage + 1) * limit);
      socialPage += 1;
      return Promise.resolve(page);
    },
  };

  return {
    db: {
      select: () => {
        selected = "signals";
        return query;
      },
      query: {
        sourceAuthorAliases: {},
        sourceAuthorIdentities: {},
      },
    } as never,
    signalLimitCalls,
    socialLimitCalls,
    get orderByCalls() {
      return orderByCalls;
    },
  };
}
