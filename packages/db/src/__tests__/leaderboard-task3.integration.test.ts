import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertWorkerCanonicalIngestionCompatibility } from "../migration-compatibility";

const runLiveDatabaseTests = process.env.LEADERBOARD_RUN_LIVE_DB_TESTS === "1";
const liveDatabaseUrl =
  process.env.LEADERBOARD_LIVE_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/tradebot";

let pool: Pool | null = null;

describe.skipIf(!runLiveDatabaseTests)("leaderboard Task 3 local Postgres validation", () => {
  beforeAll(async () => {
    const parsed = new URL(liveDatabaseUrl);
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
      throw new Error("Live leaderboard validation only permits a local Postgres host.");
    }

    const candidate = new Pool({
      connectionString: liveDatabaseUrl,
      max: 10,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await candidate.query("select 1");
      pool = candidate;
    } catch (error) {
      await candidate.end().catch(() => undefined);
      throw new Error(
        `Local Postgres is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    pool = null;
  });

  it("deduplicates concurrent source-event inserts with the partial unique index", async () => {
    if (!pool) throw new Error("Live Postgres pool was not initialized.");
    const source = `task3-live-dedup-${process.pid}-${Date.now()}`;
    const sourceEventId = "discord:task3:concurrent-event";
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          pool!.query(
            `
              insert into signals
                (source, source_event_id, symbol, content, timestamp, metadata)
              values ($1, $2, 'AAPL', 'task3 dedup', now(), '{}'::jsonb)
              on conflict do nothing
            `,
            [source, sourceEventId],
          ),
        ),
      );

      const result = await pool.query<{ count: string }>(
        "select count(*)::text as count from signals where source = $1 and source_event_id = $2",
        [source, sourceEventId],
      );
      expect(result.rows[0]?.count).toBe("1");
    } finally {
      await pool.query("delete from signals where source = $1", [source]);
    }
  });

  it("fails closed when any Discord/paste runtime column is removed", async () => {
    if (!pool) throw new Error("Live Postgres pool was not initialized.");
    const client = await pool.connect();
    const requiredColumns = [
      ["signals", "id"],
      ["signals", "source"],
      ["signals", "source_event_id"],
      ["signals", "source_author_id"],
      ["signals", "symbol"],
      ["signals", "content"],
      ["signals", "url"],
      ["signals", "timestamp"],
      ["signals", "metadata"],
      ["signals", "created_at"],
      ["signal_ingestion_cursors", "source"],
      ["signal_ingestion_cursors", "cursor"],
      ["signal_ingestion_cursors", "cursor_sequence"],
      ["signal_ingestion_cursors", "backfill_cursor"],
      ["signal_ingestion_cursors", "backfill_complete"],
      ["signal_ingestion_cursors", "watermark"],
      ["signal_ingestion_cursors", "status"],
      ["signal_ingestion_cursors", "last_error"],
      ["signal_ingestion_cursors", "created_at"],
      ["signal_ingestion_cursors", "updated_at"],
      ["source_author_identities", "id"],
      ["source_author_identities", "source"],
      ["source_author_identities", "source_author_id"],
      ["source_author_identities", "canonical_key"],
      ["source_author_identities", "current_handle"],
      ["source_author_identities", "current_display_name"],
      ["source_author_identities", "avatar_url"],
      ["source_author_identities", "first_seen_at"],
      ["source_author_identities", "last_seen_at"],
      ["source_author_identities", "created_at"],
      ["source_author_identities", "updated_at"],
      ["source_author_aliases", "id"],
      ["source_author_aliases", "identity_id"],
      ["source_author_aliases", "source"],
      ["source_author_aliases", "alias"],
      ["source_author_aliases", "alias_type"],
      ["source_author_aliases", "first_seen_at"],
      ["source_author_aliases", "last_seen_at"],
      ["source_author_aliases", "created_at"],
      ["source_author_aliases", "updated_at"],
    ] as const;
    const execute = async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = new PgDialect().sqlToQuery(query);
      return client.query(compiled.sql, compiled.params);
    };

    try {
      await assertWorkerCanonicalIngestionCompatibility({ execute });
      for (const [table, column] of requiredColumns) {
        await client.query("begin");
        try {
          await client.query(`alter table "${table}" drop column "${column}" cascade`);
          await expect(
            assertWorkerCanonicalIngestionCompatibility({ execute }),
          ).rejects.toThrow(/0031_useful_pixie/);
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      client.release();
    }
  }, { timeout: 60_000 });

  it("fails closed when a required ingestion index or constraint is removed", async () => {
    if (!pool) throw new Error("Live Postgres pool was not initialized.");
    const client = await pool.connect();
    const requiredIndexes = [
      ["public", "signals_source_event_unique_idx"],
      ["public", "signals_source_author_idx"],
      ["public", "source_author_aliases_source_alias_lookup_idx"],
      ["public", "source_author_aliases_identity_lookup_idx"],
      ["public", "source_author_identities_source_lookup_idx"],
    ] as const;
    const requiredConstraints = [
      ["source_author_aliases", "source_author_aliases_pkey"],
      ["source_author_identities", "source_author_identities_pkey"],
      ["source_author_aliases", "source_author_aliases_identity_id_source_author_identities_id_fk"],
      ["source_author_aliases", "source_author_aliases_identity_alias_unique"],
      ["source_author_identities", "source_author_identities_source_author_unique"],
      ["source_author_identities", "source_author_identities_canonical_key_unique"],
      ["signal_ingestion_cursors", "signal_ingestion_cursors_pkey"],
    ] as const;
    const execute = async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = new PgDialect().sqlToQuery(query);
      return client.query(compiled.sql, compiled.params);
    };

    try {
      await assertWorkerCanonicalIngestionCompatibility({ execute });
      for (const [schemaName, indexName] of requiredIndexes) {
        await client.query("begin");
        try {
          await client.query(`drop index "${schemaName}"."${indexName}"`);
          await expect(
            assertWorkerCanonicalIngestionCompatibility({ execute }),
          ).rejects.toThrow(/0031_useful_pixie/);
        } finally {
          await client.query("rollback");
        }
      }
      for (const [table, constraint] of requiredConstraints) {
        await client.query("begin");
        try {
          await client.query(`alter table "${table}" drop constraint "${constraint}" cascade`);
          await expect(
            assertWorkerCanonicalIngestionCompatibility({ execute }),
          ).rejects.toThrow(/0031_useful_pixie/);
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      client.release();
    }
  }, { timeout: 60_000 });

  it("keeps stale Discord and paste cursor writes from moving state backwards", async () => {
    if (!pool) throw new Error("Live Postgres pool was not initialized.");
    const discordSource = `task3-live-discord-${process.pid}-${Date.now()}`;
    const pasteSource = `task3-live-paste-${process.pid}-${Date.now()}`;
    try {
      await Promise.all([
        pool.query(
          `
            insert into signal_ingestion_cursors
              (source, cursor, cursor_sequence, watermark, status, backfill_complete)
            values ($1, $2, $2, now(), 'healthy', true)
            on conflict (source) do update set
              cursor = excluded.cursor,
              cursor_sequence = excluded.cursor_sequence,
              watermark = excluded.watermark,
              status = excluded.status,
              updated_at = now()
            where signal_ingestion_cursors.cursor_sequence is null
              or signal_ingestion_cursors.cursor_sequence::numeric <= excluded.cursor_sequence::numeric
          `,
          [discordSource, "900"],
        ),
        pool.query(
          `
            insert into signal_ingestion_cursors
              (source, cursor, cursor_sequence, watermark, status, backfill_complete)
            values ($1, $2, $2, now(), 'healthy', true)
            on conflict (source) do update set
              cursor = excluded.cursor,
              cursor_sequence = excluded.cursor_sequence,
              watermark = excluded.watermark,
              status = excluded.status,
              updated_at = now()
            where signal_ingestion_cursors.cursor_sequence is null
              or signal_ingestion_cursors.cursor_sequence::numeric <= excluded.cursor_sequence::numeric
          `,
          [discordSource, "100"],
        ),
      ]);

      const discordResult = await pool.query<{ cursor: string; cursor_sequence: string }>(
        "select cursor, cursor_sequence from signal_ingestion_cursors where source = $1",
        [discordSource],
      );
      expect(discordResult.rows[0]).toEqual({ cursor: "900", cursor_sequence: "900" });

      const oldWatermark = new Date("2026-08-21T12:00:01.000Z");
      const newWatermark = new Date("2026-08-21T12:00:02.000Z");
      await Promise.all([
        pool.query(
          `
            insert into signal_ingestion_cursors
              (source, cursor, cursor_sequence, watermark, status, backfill_complete)
            values ($1, $2, $3, $4, 'healthy', true)
            on conflict (source) do update set
              cursor = excluded.cursor,
              cursor_sequence = excluded.cursor_sequence,
              watermark = excluded.watermark,
              status = excluded.status,
              updated_at = now()
            where signal_ingestion_cursors.watermark is null
              or excluded.watermark > signal_ingestion_cursors.watermark
              or (
                excluded.watermark = signal_ingestion_cursors.watermark
                and (
                  signal_ingestion_cursors.cursor_sequence is null
                  or signal_ingestion_cursors.cursor_sequence::numeric <= excluded.cursor_sequence::numeric
                )
              )
          `,
          [pasteSource, "2:2026-08-21T12:00:02.000Z", "2", newWatermark],
        ),
        pool.query(
          `
            insert into signal_ingestion_cursors
              (source, cursor, cursor_sequence, watermark, status, backfill_complete)
            values ($1, $2, $3, $4, 'healthy', true)
            on conflict (source) do update set
              cursor = excluded.cursor,
              cursor_sequence = excluded.cursor_sequence,
              watermark = excluded.watermark,
              status = excluded.status,
              updated_at = now()
            where signal_ingestion_cursors.watermark is null
              or excluded.watermark > signal_ingestion_cursors.watermark
              or (
                excluded.watermark = signal_ingestion_cursors.watermark
                and (
                  signal_ingestion_cursors.cursor_sequence is null
                  or signal_ingestion_cursors.cursor_sequence::numeric <= excluded.cursor_sequence::numeric
                )
              )
          `,
          [pasteSource, "1:2026-08-21T12:00:01.000Z", "1", oldWatermark],
        ),
      ]);

      const pasteResult = await pool.query<{
        cursor: string;
        cursor_sequence: string;
        watermark: Date;
      }>(
        "select cursor, cursor_sequence, watermark from signal_ingestion_cursors where source = $1",
        [pasteSource],
      );
      expect(pasteResult.rows[0]?.cursor).toBe("2:2026-08-21T12:00:02.000Z");
      expect(pasteResult.rows[0]?.cursor_sequence).toBe("2");
      expect(new Date(pasteResult.rows[0]!.watermark).toISOString()).toBe(
        newWatermark.toISOString(),
      );
    } finally {
      await pool.query(
        "delete from signal_ingestion_cursors where source in ($1, $2)",
        [discordSource, pasteSource],
      );
    }
  });
});
