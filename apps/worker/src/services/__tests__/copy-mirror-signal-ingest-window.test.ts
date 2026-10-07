import { describe, expect, it } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { findMirrorCandidateSources } from "../copy-mirror-candidate-sources";

/**
 * The discovery window has to be measured on the clock that stamps a row when it
 * ARRIVES, not on the clock the source used when it posted.
 *
 * `poll()` reads `windowEnd` from the database and `stageWindow` advances the
 * durable checkpoint to it unconditionally, so the cursor is an INGEST cursor.
 * The x_author half of discovery used to select on `signals.timestamp`, which is
 * the source's own publication time: discord-poller writes the Discord message's
 * stamp and paste-trade-poller writes the external board's `author_date`. Any
 * row whose ingestion lag exceeds one poll window is therefore already below
 * `windowStart` the first time it is visible, and because the checkpoint has
 * already stepped over it no later cycle ever re-scans it. It is dropped
 * silently, with no log line, because discovery never sees the row at all.
 *
 * `signals.createdAt` is `defaultNow()`, the same DB-assigned ingest stamp the
 * social-trade half of this very function already compares against, so it is the
 * value the watermark is actually a cursor over.
 *
 * These tests drive the real `findMirrorCandidateSources` and stand in for
 * Postgres with a db that renders the module's own predicate through drizzle's
 * PgDialect and applies it to in-memory rows. Whatever column the query names is
 * the column the rows are filtered on, exactly as the database would.
 */

const AUTHOR = "TraderJoe";
const FOLLOWER = "follower-1";
const CREDENTIAL = "00000000-0000-4000-8000-000000000001";

/** A signals row as the database holds it: two different clocks, on purpose. */
type SignalRow = {
  id: string;
  source: string;
  symbol: string;
  content: string;
  metadata: unknown;
  /** The SOURCE's publication time (Discord message stamp / board author_date). */
  timestamp: Date;
  /** `defaultNow()`: when this worker's poller actually inserted the row. */
  createdAt: Date;
};

/**
 * Which physical column a rendered predicate term is about.
 *
 * Discovery now compares a millisecond-truncated key rather than the raw
 * column, so both spellings of `created_at` map to the same field. A window
 * bound on `"signals"."timestamp"` is the exact regression these tests exist
 * to catch, so it is recognised too and then refused below.
 */
function columnOfTerm(term: string): keyof SignalRow | null {
  if (/"signals"\."created_at"/.test(term)) return "createdAt";
  if (/"signals"\."timestamp"/.test(term)) return "timestamp";
  return null;
}

/**
 * Apply the rendered predicate to one row.
 *
 * Only simple `<column> <op> $n` comparisons are evaluated. Keyset and fence
 * terms (which compare a tuple against the page cursor) are left alone: this
 * fixture holds a single row per test, so paging cannot change the answer, and
 * modelling drizzle's tuple comparison here would be re-implementing Postgres.
 * A window bound read off the SOURCE clock throws instead of being evaluated,
 * because that is the defect under test and it must fail loudly.
 */
function rowMatches(rendered: { sql: string; params: unknown[] }, row: SignalRow): boolean {
  const terms = rendered.sql.split(" and ").map((term) => term.trim());
  return terms.every((term) => {
    const parsed = /(>|>=|<|<=) \$(\d+)\)?$/.exec(term);
    const column = columnOfTerm(term);
    if (column === "timestamp") {
      throw new Error(`discovery windowed on the source clock: ${term}`);
    }
    if (!parsed || column !== "createdAt") return true;
    const [, op, index] = parsed;
    const left = row.createdAt.getTime();
    const right = new Date(String(rendered.params[Number(index) - 1])).getTime();
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "<") return left < right;
    return left <= right;
  });
}

/**
 * Stands in for the worker pool db across discovery's fence capture and its
 * keyset-paged signal scan. `orderBy`/`limit` are answered rather than
 * modelled: with one row per test the page always fits, so what is under test
 * is which column the WHERE clause bounds, not the pagination.
 */
function fakeSignalsDb(rows: SignalRow[]): WorkerPoolDb {
  const dialect = new PgDialect();
  const newest = [...rows].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  );
  let table: unknown = null;
  let predicate: SQL | null = null;
  const query: any = {
    from(selected: unknown) {
      table = selected;
      return query;
    },
    innerJoin: () => query,
    leftJoin: () => query,
    where(value: SQL) {
      predicate = value;
      return query;
    },
    orderBy: () => query,
    limit(limit: number) {
      const forSignals = table === schema.signals;
      const applied = predicate;
      predicate = null;
      if (!forSignals) return Promise.resolve([]);
      // The pre-scan fence: newest row, no predicate.
      if (!applied) return Promise.resolve(newest.slice(0, limit));
      const rendered = dialect.sqlToQuery(applied);
      return Promise.resolve(rows.filter((row) => rowMatches(rendered, row)).slice(0, limit));
    },
  };
  return {
    select: () => {
      table = null;
      predicate = null;
      return query;
    },
    query: { sourceAuthorAliases: {}, sourceAuthorIdentities: {} },
  } as unknown as WorkerPoolDb;
}

function xAuthorFollow(): typeof schema.copyTradeFollows.$inferSelect {
  return {
    id: "follow-1",
    followerUserId: FOLLOWER,
    credentialId: CREDENTIAL,
    targetType: "x_author",
    // Discovery matches a caller by their canonical/alias key, not by the raw
    // display name: `resolveMirrorAuthorMatchKeys` normalises the metadata
    // author into "source_alias:<source>:<normalised name>".
    targetKey: `source_alias:x:${AUTHOR.toLowerCase()}`,
    targetLabel: AUTHOR,
    autoMirror: true,
    sizingMode: "usd",
    sizingValue: "500",
    destinationPolicyInitialized: true,
    stockAutoMirror: true,
    stockCredentialId: CREDENTIAL,
    stockSizingMode: "usd",
    stockSizingValue: "500",
    perpAutoMirror: false,
    perpCredentialId: null,
    perpSizingMode: "pct",
    perpSizingValue: "5",
  } as unknown as typeof schema.copyTradeFollows.$inferSelect;
}

function signal(overrides: Partial<SignalRow> & Pick<SignalRow, "timestamp" | "createdAt">): SignalRow {
  return {
    id: "signal-1",
    source: "x",
    symbol: "AAPL",
    content: "AAPL breaking out here",
    metadata: { authorName: AUTHOR },
    ...overrides,
  };
}

describe("x_author discovery window", () => {
  it("stages a signal the poller ingested late, whose source stamp predates the window", async () => {
    // The failure scenario. The board published at 12:00:00; PasteTradePoller
    // (60s interval) inserted the row at 12:00:45 carrying that author_date. The
    // cycle at 12:00:50 has windowStart = 12:00:20, so a source-time filter puts
    // the row below the window on the one and only cycle that could see it, and
    // the checkpoint then advances to 12:00:50.
    const windowStart = new Date("2026-08-19T12:00:20.000Z");
    const windowEnd = new Date("2026-08-19T12:00:50.000Z");
    const rows = [
      signal({
        timestamp: new Date("2026-08-19T12:00:00.000Z"),
        createdAt: new Date("2026-08-19T12:00:45.000Z"),
      }),
    ];

    const candidates = await findMirrorCandidateSources(
      fakeSignalsDb(rows),
      [xAuthorFollow()],
      windowStart,
      windowEnd,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceItemId).toBe("x_signal:signal-1");
    expect(candidates[0]!.symbol).toBe("AAPL");
  });

  it("stages a signal whose source stamp runs ahead of the window end", async () => {
    // The same defect from the other side: an upstream board whose clock leads
    // ours (or a scheduled author_date) stamps the row past windowEnd, so an
    // upper bound read off the source clock discards it while the checkpoint
    // still steps past its ingest time. Held on the ingest clock the row is
    // staged, and a source stamp we cannot trust is then the freshness gate's
    // decision to make, with a log line, instead of a silent disappearance.
    const windowStart = new Date("2026-08-19T12:00:20.000Z");
    const windowEnd = new Date("2026-08-19T12:00:50.000Z");
    const rows = [
      signal({
        timestamp: new Date("2026-08-19T12:05:00.000Z"),
        createdAt: new Date("2026-08-19T12:00:45.000Z"),
      }),
    ];

    const candidates = await findMirrorCandidateSources(
      fakeSignalsDb(rows),
      [xAuthorFollow()],
      windowStart,
      windowEnd,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceItemId).toBe("x_signal:signal-1");
  });

  it("leaves a signal ingested after this window for the next cycle", async () => {
    // The upper bound still has to hold, now on the ingest clock: a row written
    // after windowEnd belongs to the next cycle, which will see it because
    // windowStart there is exactly this windowEnd.
    const windowStart = new Date("2026-08-19T12:00:20.000Z");
    const windowEnd = new Date("2026-08-19T12:00:50.000Z");
    const rows = [
      signal({
        timestamp: new Date("2026-08-19T12:00:00.000Z"),
        createdAt: new Date("2026-08-19T12:00:55.000Z"),
      }),
    ];

    const candidates = await findMirrorCandidateSources(
      fakeSignalsDb(rows),
      [xAuthorFollow()],
      windowStart,
      windowEnd,
    );

    expect(candidates).toEqual([]);
  });

  it("still stamps sourceEventAt from the source's own publication time", async () => {
    // Moving the WINDOW onto the ingest clock must not move the EVENT time with
    // it. `sourceEventAt` orders an open ahead of its own close and feeds the
    // staleness bound, and both of those questions are about when the source
    // traded, not about when we happened to read it.
    const windowStart = new Date("2026-08-19T12:00:20.000Z");
    const windowEnd = new Date("2026-08-19T12:00:50.000Z");
    const rows = [
      signal({
        timestamp: new Date("2026-08-19T12:00:00.000Z"),
        createdAt: new Date("2026-08-19T12:00:45.000Z"),
      }),
    ];

    const candidates = await findMirrorCandidateSources(
      fakeSignalsDb(rows),
      [xAuthorFollow()],
      windowStart,
      windowEnd,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceEventAt).toBe("2026-08-19T12:00:00.000Z");
  });
});
