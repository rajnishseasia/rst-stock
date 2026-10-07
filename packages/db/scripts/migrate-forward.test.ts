import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  NO_TRANSACTION_DIRECTIVE,
  planMigrationBatches,
  readMigrationFiles,
  runForwardMigrations,
  validateAppliedMigrationJournal,
  withMigrationLock,
  type DatabaseMigrationJournalEntry,
  type MigrationFile,
} from "./migrate-forward";

const migration = (tag: string, folderMillis: number): MigrationFile => ({
  tag,
  folderMillis,
  hash: `${tag}-hash`,
  statements: [`select '${tag}'`],
});

describe("forward migration execution boundary", () => {
  test("commits the enum addition before migrations that use PERP", () => {
    const batches = planMigrationBatches([
      migration("0014_before", 14),
      migration("0015_overrated_franklin_richards", 15),
      migration("0025_easy_ezekiel", 25),
      migration("0031_useful_pixie", 31),
    ], null);

    expect(batches.map((batch) => batch.map((entry) => entry.tag))).toEqual([
      ["0014_before", "0015_overrated_franklin_richards"],
      ["0025_easy_ezekiel", "0031_useful_pixie"],
    ]);
  });

  test("does not re-run already journaled migrations", () => {
    const batches = planMigrationBatches([
      migration("0015_overrated_franklin_richards", 15),
      migration("0025_easy_ezekiel", 25),
    ], { created_at: 15 });

    expect(batches.map((batch) => batch.map((entry) => entry.tag))).toEqual([
      ["0025_easy_ezekiel"],
    ]);
  });

  test("keeps nontransactional migrations in their own execution phase", () => {
    const batches = planMigrationBatches([
      migration("0031_before", 31),
      { ...migration("0032_indexes", 32), executionMode: "nontransactional" },
      migration("0033_after", 33),
    ], null);

    expect(batches.map((batch) => batch.map((entry) => entry.tag))).toEqual([
      ["0031_before"],
      ["0032_indexes"],
      ["0033_after"],
    ]);
  });
});

describe("applied migration journal integrity", () => {
  const migrations = [
    migration("0001_first", 1),
    migration("0002_second", 2),
    migration("0003_third", 3),
  ];

  const journalEntry = (entry: MigrationFile): DatabaseMigrationJournalEntry => ({
    hash: entry.hash,
    created_at: String(entry.folderMillis),
  });

  test("accepts a journal that matches a committed migration prefix", () => {
    expect(() => validateAppliedMigrationJournal(
      migrations,
      migrations.slice(0, 2).map(journalEntry),
    )).not.toThrow();
  });

  test("rejects a journal with a missing migration in the middle", () => {
    expect(() => validateAppliedMigrationJournal(migrations, [
      journalEntry(migrations[0]!),
      journalEntry(migrations[2]!),
    ])).toThrow("not a contiguous committed prefix");
  });

  test("rejects a journal hash that does not match committed SQL", () => {
    expect(() => validateAppliedMigrationJournal(migrations, [
      { ...journalEntry(migrations[0]!), hash: "tampered-hash" },
    ])).toThrow("hash mismatch");
  });

  test("rejects an unknown journal timestamp", () => {
    expect(() => validateAppliedMigrationJournal(migrations, [
      { hash: "unknown-hash", created_at: 99 },
    ])).toThrow("unknown timestamp");
  });

  test("accepts only documented legacy hashes while the forward repair is pending", () => {
    const legacyMigration = migration("0032_new_moon_knight", 32);
    const migrationsWithLegacy = [legacyMigration, migration("0033_after", 33)];
    const legacyHash = "34008a9b82cab33e89cc844ba4d108583882c0c879996b30b7b7e8460b099428";

    expect(() => validateAppliedMigrationJournal(migrationsWithLegacy, [{
      hash: legacyHash,
      created_at: 32,
    }])).not.toThrow();
    expect(() => validateAppliedMigrationJournal(migrationsWithLegacy, [{
      hash: "unrecognized-legacy-hash",
      created_at: 32,
    }])).toThrow("hash mismatch");
  });
});

describe("copy-mirror normalized-key migration", () => {
  test("drops and rebuilds every exact expression index without name-skipping", () => {
    const sql = readFileSync(
      new URL("../migrations/0032_new_moon_knight.sql", import.meta.url),
      "utf8",
    );
    const expectedIndexes = [
      "copy_trade_follows_follower_created_at_id_idx",
      "copy_trade_follows_auto_mirror_created_at_id_idx",
      "signals_created_at_id_idx",
      "signals_timestamp_id_idx",
      "social_trades_created_at_id_idx",
    ];

    expect(sql).not.toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(sql).toContain(
      "date_trunc('milliseconds', \"created_at\" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    );
    for (const indexName of expectedIndexes) {
      const dropAt = sql.indexOf(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
      const createAt = sql.indexOf(`CREATE INDEX CONCURRENTLY "${indexName}"`);
      expect(dropAt).toBeGreaterThanOrEqual(0);
      expect(createAt).toBeGreaterThan(dropAt);
    }
  });

  test("includes a forward repair migration for older journaled 0032 variants", () => {
    const sql = readFileSync(
      new URL("../migrations/0035_restore_copy_mirror_indexes.sql", import.meta.url),
      "utf8",
    );
    expect(sql.startsWith(NO_TRANSACTION_DIRECTIVE)).toBe(true);
    for (const indexName of [
      "copy_trade_follows_follower_created_at_id_idx",
      "copy_trade_follows_auto_mirror_created_at_id_idx",
      "signals_created_at_id_idx",
      "signals_timestamp_id_idx",
      "social_trades_created_at_id_idx",
    ]) {
      expect(sql).toContain(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${indexName}"`);
      expect(sql).toContain(`CREATE INDEX CONCURRENTLY "${indexName}" ON "public"`);
    }
  });
});

type FakeMigrationClient = {
  calls: Array<{ text: string; values: readonly unknown[] }>;
  journaledAt: number | null;
  journaledHash: string | null;
  indexRelations: Map<string, { definition: string; valid: boolean }>;
  endCalls: number;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<void>;
  end(): Promise<void>;
};

function fakeMigrationClient(
  failOnceOn?: string,
  initialIndexDefinitions: Record<string, string> = {},
  advisoryLockAcquired = true,
): FakeMigrationClient {
  let failed = false;
  const client: FakeMigrationClient = {
    calls: [],
    journaledAt: null,
    journaledHash: null,
    indexRelations: new Map(
      Object.entries(initialIndexDefinitions).map(([name, definition]) => [
        name,
        { definition, valid: true },
      ]),
    ),
    endCalls: 0,
    async connect() {},
    async end() {
      client.endCalls += 1;
    },
    async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      client.calls.push({ text: normalized, values });

      if (normalized.startsWith("select pg_try_advisory_lock")) {
        return { rows: [{ locked: advisoryLockAcquired }] as T[] };
      }
      if (normalized.startsWith("select hash, created_at from")) {
        return {
          rows: (client.journaledAt === null
            ? []
            : [{ hash: client.journaledHash, created_at: client.journaledAt }]) as T[],
        };
      }
      if (normalized.startsWith("select created_at from")) {
        return {
          rows: (client.journaledAt === null ? [] : [{ created_at: client.journaledAt }]) as T[],
        };
      }
      if (normalized.startsWith('insert into "drizzle"."__drizzle_migrations"')) {
        client.journaledHash = String(values[0]);
        client.journaledAt = Number(values[1]);
        return { rows: [] as T[] };
      }
      const drop = normalized.match(/^drop index concurrently if exists "([^"]+)"/i);
      if (drop) {
        client.indexRelations.delete(drop[1]!);
        return { rows: [] as T[] };
      }
      const create = normalized.match(/^create index concurrently(?: if not exists)? "([^"]+)"/i);
      if (create) {
        const name = create[1]!;
        if (failOnceOn && !failed && normalized.includes(failOnceOn)) {
          failed = true;
          client.indexRelations.set(name, { definition: normalized, valid: false });
          throw new Error("simulated later index failure");
        }
        if (client.indexRelations.has(name) && !normalized.includes("if not exists")) {
          throw new Error(`relation ${name} already exists`);
        }
        client.indexRelations.set(name, { definition: normalized, valid: true });
        return { rows: [] as T[] };
      }
      if (failOnceOn && !failed && normalized.includes(failOnceOn)) {
        failed = true;
        throw new Error("simulated later index failure");
      }
      return { rows: [] as T[] };
    },
  };
  return client;
}

function migrationFixture(sql: string, tag = "0032_fixture_indexes", folderMillis = 32) {
  const dir = mkdtempSync(join(tmpdir(), "trade-bot-migrations-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({
    entries: [{ idx: 0, version: "7", when: folderMillis, tag }],
  }));
  writeFileSync(join(dir, `${tag}.sql`), sql);
  return dir;
}

describe("forward migration runner transaction modes", () => {
  test("runs a normal migration transactionally and journals inside the transaction", async () => {
    const dir = migrationFixture("create table normal_fixture (id integer);");
    const client = fakeMigrationClient();
    try {
      await runForwardMigrations("fake://database", dir, { createClient: () => client });
      const texts = client.calls.map((call) => call.text);
      expect(texts).toContain("begin");
      expect(texts).toContain("commit");
      expect(texts).not.toContain("rollback");
      expect(texts.findIndex((text) => text === "commit")).toBeGreaterThan(
        texts.findIndex((text) => text.startsWith('insert into "drizzle"."__drizzle_migrations"')),
      );
      expect(client.journaledAt).toBe(32);
      expect(client.journaledHash).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs the explicit no-transaction phase without BEGIN or COMMIT", async () => {
    const dir = migrationFixture([
      NO_TRANSACTION_DIRECTIVE,
      'create index concurrently if not exists first_fixture_idx on normal_fixture (id);',
      '--> statement-breakpoint',
      'create index concurrently if not exists second_fixture_idx on normal_fixture (id);',
    ].join("\n"));
    const client = fakeMigrationClient();
    try {
      const [file] = readMigrationFiles(dir);
      expect(file?.executionMode).toBe("nontransactional");
      expect(file?.statements).toHaveLength(2);

      await runForwardMigrations("fake://database", dir, { createClient: () => client });
      const texts = client.calls.map((call) => call.text);
      expect(texts).not.toContain("begin");
      expect(texts).not.toContain("commit");
      const journalIndex = texts.findIndex((text) => text.startsWith('insert into "drizzle"."__drizzle_migrations"'));
      expect(journalIndex).toBeGreaterThan(texts.findIndex((text) => text.startsWith("create index concurrently") && text.includes("second_fixture_idx")));
      expect(client.journaledAt).toBe(32);
      expect(client.journaledHash).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retries a partial concurrent-index phase without journaling or duplicating its durable result", async () => {
    const dir = migrationFixture([
      NO_TRANSACTION_DIRECTIVE,
      'drop index concurrently if exists "first_fixture_idx";',
      '--> statement-breakpoint',
      'create index concurrently "first_fixture_idx" on normal_fixture (id);',
      '--> statement-breakpoint',
      'drop index concurrently if exists "second_fixture_idx";',
      '--> statement-breakpoint',
      'create index concurrently "second_fixture_idx" on normal_fixture (id);',
    ].join("\n"));
    const client = fakeMigrationClient("second_fixture_idx");
    try {
      await expect(
        runForwardMigrations("fake://database", dir, { createClient: () => client }),
      ).rejects.toThrow("simulated later index failure");
      expect(client.journaledAt).toBeNull();

      await runForwardMigrations("fake://database", dir, { createClient: () => client });
      const firstIndexCalls = client.calls.filter((call) => call.text.includes("first_fixture_idx"));
      const secondIndexCalls = client.calls.filter((call) => call.text.includes("second_fixture_idx"));
      const journalCalls = client.calls.filter((call) => call.text.startsWith('insert into "drizzle"."__drizzle_migrations"'));
      expect(firstIndexCalls).toHaveLength(4);
      expect(secondIndexCalls).toHaveLength(4);
      expect(journalCalls).toHaveLength(1);
      expect(client.journaledAt).toBe(32);
      expect(client.journaledHash).toBeTruthy();
      expect(client.indexRelations.get("first_fixture_idx")).toMatchObject({ valid: true });
      expect(client.indexRelations.get("second_fixture_idx")).toMatchObject({ valid: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replaces a wrong same-name index before journaling the migration", async () => {
    const dir = migrationFixture([
      NO_TRANSACTION_DIRECTIVE,
      'drop index concurrently if exists "first_fixture_idx";',
      '--> statement-breakpoint',
      'create index concurrently "first_fixture_idx" on normal_fixture (id);',
    ].join("\n"));
    const client = fakeMigrationClient(undefined, {
      first_fixture_idx: 'create index "first_fixture_idx" on normal_fixture (wrong_column);',
    });
    try {
      await runForwardMigrations("fake://database", dir, { createClient: () => client });
      const dropIndex = client.calls.findIndex((call) => call.text.includes("drop index concurrently"));
      const createIndex = client.calls.findIndex((call) => call.text.includes("create index concurrently"));
      expect(dropIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThan(dropIndex);
      expect(client.indexRelations.get("first_fixture_idx")).toEqual({
        definition: 'create index concurrently "first_fixture_idx" on normal_fixture (id);',
        valid: true,
      });
      expect(client.journaledAt).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails with a bounded diagnostic when another migration holds the lock", async () => {
    const dir = migrationFixture("create table lock_fixture (id integer);");
    const client = fakeMigrationClient(undefined, {}, false);
    try {
      await expect(
        runForwardMigrations("fake://database", dir, {
          createClient: () => client,
          lockTimeoutMs: 0,
          sleep: async () => {},
        }),
      ).rejects.toThrow("Could not acquire migration lock within 0ms");
      expect(client.endCalls).toBe(1);
      expect(client.calls.map((call) => call.text)).not.toContain("create schema if not exists \"drizzle\"");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("releases the shared lock after schema verification work completes", async () => {
    const client = fakeMigrationClient();

    await expect(withMigrationLock(client, {}, async () => "verified")).resolves.toBe("verified");

    expect(client.calls.map((call) => call.text)).toEqual([
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      "select pg_advisory_unlock(hashtext($1))",
    ]);
  });
});

const testCleanDatabase = process.env.LEADERBOARD_RUN_CLEAN_MIGRATION_TESTS === "1"
  ? test
  : test.skip;

const testLiveMigrationRetry = process.env.LEADERBOARD_RUN_LIVE_MIGRATION_RETRY_TESTS === "1"
  ? test
  : test.skip;

function quoteDatabaseIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$-]*$/.test(value)) {
    throw new Error(`Unsafe database identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

testLiveMigrationRetry("rebuilds a failed concurrent index on a real PostgreSQL retry", async () => {
  const databaseUrl = process.env.LEADERBOARD_LIVE_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
  if (!databaseUrl) {
    throw new Error(
      "LEADERBOARD_LIVE_MIGRATION_DATABASE_URL or DATABASE_URL_DIRECT is required for the live retry test",
    );
  }
  const targetUrl = new URL(databaseUrl);
  if (!/^(localhost|127\.0\.0\.1|::1)$/.test(targetUrl.hostname)) {
    throw new Error("The live migration retry test only permits a local PostgreSQL host");
  }

  const folderMillis = Date.now();
  const tableName = `migration_retry_rows_${process.pid}_${folderMillis}`;
  const indexName = `migration_retry_value_${process.pid}_${folderMillis}`;
  const tag = `9999_live_retry_${process.pid}_${folderMillis}`;
  const table = quoteDatabaseIdentifier(tableName);
  const index = quoteDatabaseIdentifier(indexName);
  const dir = migrationFixture([
    NO_TRANSACTION_DIRECTIVE,
    `drop index concurrently if exists ${index};`,
    "--> statement-breakpoint",
    `create unique index concurrently ${index} on ${table} (value);`,
  ].join("\n"), tag, folderMillis);
  const client = new Client({ connectionString: databaseUrl });
  let connected = false;

  try {
    await client.connect();
    connected = true;
    await client.query(`create table ${table} (value integer not null)`);
    await client.query(`insert into ${table} (value) values (1), (1)`);

    await expect(runForwardMigrations(databaseUrl, dir)).rejects.toThrow();
    const beforeRetry = await client.query<{ count: number }>(
      'select count(*)::int as count from "drizzle"."__drizzle_migrations" where created_at = $1',
      [folderMillis],
    );
    expect(beforeRetry.rows[0]?.count).toBe(0);

    await client.query(
      `delete from ${table} where value = 1 and ctid <> (select min(ctid) from ${table} where value = 1)`,
    );
    await runForwardMigrations(databaseUrl, dir);

    const rebuilt = await client.query<{
      indisvalid: boolean;
      indisready: boolean;
      definition: string;
    }>(
      `select index_meta.indisvalid, index_meta.indisready, pg_get_indexdef(index_rel.oid) as definition
       from pg_class index_rel
       inner join pg_index index_meta on index_meta.indexrelid = index_rel.oid
       where index_rel.relname = $1`,
      [indexName],
    );
    expect(rebuilt.rows).toHaveLength(1);
    expect(rebuilt.rows[0]).toMatchObject({ indisvalid: true, indisready: true });
    expect(rebuilt.rows[0]?.definition).toContain("CREATE UNIQUE INDEX");

    const afterRetry = await client.query<{ count: number }>(
      'select count(*)::int as count from "drizzle"."__drizzle_migrations" where created_at = $1',
      [folderMillis],
    );
    expect(afterRetry.rows[0]?.count).toBe(1);
  } finally {
    if (connected) {
      await client.query(`drop index concurrently if exists ${index}`);
      await client.query(`drop table if exists ${table}`);
      await client.query(
        'delete from "drizzle"."__drizzle_migrations" where created_at = $1',
        [folderMillis],
      );
      await client.end();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

testCleanDatabase("applies the complete committed history to an empty Docker database", async () => {
  const databaseUrl = process.env.LEADERBOARD_CLEAN_DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
  if (!databaseUrl) {
    throw new Error(
      "LEADERBOARD_CLEAN_DATABASE_URL or DATABASE_URL_DIRECT is required for the clean migration test",
    );
  }
  const targetUrl = new URL(databaseUrl);
  if (!/^(localhost|127\.0\.0\.1|::1)$/.test(targetUrl.hostname)) {
    throw new Error("The clean migration test only permits a local PostgreSQL host");
  }
  const databaseName = `tradebot_clean_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = "/postgres";
  const cleanUrl = new URL(targetUrl);
  cleanUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false;

  try {
    await admin.connect();
    await admin.query(`create database ${quoteDatabaseIdentifier(databaseName)}`);
    created = true;
    await runForwardMigrations(cleanUrl.toString());

    const verify = new Client({ connectionString: cleanUrl.toString() });
    try {
      await verify.connect();
      const result = await verify.query<{
        migration_count: number;
        has_perp: boolean;
        has_perp_index: boolean;
        has_cursor_table: boolean;
      }>(`
        select
          (select count(*)::int from "drizzle"."__drizzle_migrations") as migration_count,
          exists (
            select 1
            from pg_type type_rel
            inner join pg_enum enum_rel on enum_rel.enumtypid = type_rel.oid
            where type_rel.typname = 'asset_type' and enum_rel.enumlabel = 'PERP'
          ) as has_perp,
          to_regclass('public.orders_hl_perp_active_idx') is not null as has_perp_index,
          to_regclass('public.signal_ingestion_cursors') is not null as has_cursor_table
      `);
      expect(result.rows[0]).toEqual({
        migration_count: readMigrationFiles().length,
        has_perp: true,
        has_perp_index: true,
        has_cursor_table: true,
      });
    } finally {
      await verify.end();
    }
  } finally {
    if (created) {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`drop database ${quoteDatabaseIdentifier(databaseName)}`);
    }
    await admin.end();
  }
}, { timeout: 120_000 });
