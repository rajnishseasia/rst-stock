import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { assertWorkerCopyMirrorDestinationsCompatibility } from "../src/migration-compatibility.js";
import { runForwardMigrations } from "./migrate-forward.js";

const migrationsDir = join(import.meta.dir, "../migrations");
const migrationTestDatabaseUrl = process.env.COPY_TRADE_MIRROR_MIGRATION_TEST_DATABASE_URL;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

/** Generate a disposable database name that cannot overlap a normal RST database. */
function databaseName(): string {
  return `rst_copy_mirror_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** Validate the opt-in URL before allowing the test to issue database DDL. */
function parseMigrationTestDatabaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("COPY_TRADE_MIRROR_MIGRATION_TEST_DATABASE_URL must be a valid URL.", {
      cause: error,
    });
  }

  if (![
    "postgres:",
    "postgresql:",
  ].includes(parsed.protocol)) {
    throw new Error(
      "COPY_TRADE_MIRROR_MIGRATION_TEST_DATABASE_URL must use postgres:// or postgresql://.",
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!loopbackHosts.has(hostname)) {
    throw new Error(
      "Copy-mirror migration validation only permits a loopback Postgres host.",
    );
  }
  if (parsed.pathname === "" || parsed.pathname === "/") {
    throw new Error(
      "COPY_TRADE_MIRROR_MIGRATION_TEST_DATABASE_URL must name an admin database.",
    );
  }

  return parsed;
}

/** Preserve the explicit test credentials and connection options for the child database. */
function databaseUrlFor(baseUrl: URL, database: string): string {
  const childUrl = new URL(baseUrl);
  childUrl.pathname = `/${database}`;
  return childUrl.toString();
}

/** Quote the internally generated database name for PostgreSQL identifier syntax. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

/** Copy the committed pre-0040 migration set into a temporary runner directory. */
function createPreMigrationDirectory(): string {
  const directory = join(tmpdir(), `rst-copy-mirror-migrations-${randomUUID()}`);
  const metaDirectory = join(directory, "meta");
  mkdirSync(metaDirectory, { recursive: true });

  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    version: string;
    entries: Array<Record<string, unknown>>;
  };
  const preEntries = journal.entries.slice(0, 40);
  writeFileSync(join(metaDirectory, "_journal.json"), JSON.stringify({
    version: journal.version,
    entries: preEntries,
  }, null, 2));

  for (const entry of preEntries) {
    const tag = entry.tag;
    if (typeof tag !== "string") throw new Error("Migration journal contains an invalid tag.");
    copyFileSync(join(migrationsDir, `${tag}.sql`), join(directory, `${tag}.sql`));
  }
  return directory;
}

/** Execute a query and expose rows with a stable shape for migration assertions. */
async function queryRows(client: Client, text: string, values: readonly unknown[] = []) {
  const result = await client.query(text, values);
  return result.rows as Array<Record<string, unknown>>;
}

describe.skipIf(migrationTestDatabaseUrl === undefined)("copy mirror migration 0040", () => {
  it("backfills only owned ready destinations and enforces valid enabled pairs", async () => {
    if (migrationTestDatabaseUrl === undefined) {
      throw new Error(
        "COPY_TRADE_MIRROR_MIGRATION_TEST_DATABASE_URL is required when this test is enabled.",
      );
    }

    const adminDatabaseUrl = parseMigrationTestDatabaseUrl(migrationTestDatabaseUrl);
    const name = databaseName();
    const databaseUrl = databaseUrlFor(adminDatabaseUrl, name);
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    let created = false;
    let migrationDirectory: string | undefined;
    let databaseClient: Client | undefined;

    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
      created = true;

      migrationDirectory = createPreMigrationDirectory();
      await runForwardMigrations(databaseUrl, migrationDirectory);

      databaseClient = new Client({ connectionString: databaseUrl });
      await databaseClient.connect();
      await databaseClient.query(`
        insert into users (id, email) values
          ('migration-owner', 'migration-owner@example.test'),
          ('migration-foreign', 'migration-foreign@example.test')
      `);
      await databaseClient.query(`
        insert into user_api_credentials
          (id, user_id, provider, encrypted_access_token, account_id, account_type)
        values
          ('00000000-0000-4000-8000-000000000401', 'migration-owner', 'alpaca', 'cipher', 'PA-401', 'PAPER'),
          ('00000000-0000-4000-8000-000000000402', 'migration-owner', 'hyperliquid', 'cipher', '0x402', 'LIVE'),
          ('00000000-0000-4000-8000-000000000403', 'migration-foreign', 'alpaca', 'cipher', 'PA-403', 'PAPER'),
          ('00000000-0000-4000-8000-000000000404', 'migration-owner', 'alpaca', 'cipher', 'SIM-404', 'SIM')
      `);
      await databaseClient.query(`
        insert into copy_trade_follows
          (id, follower_user_id, target_type, target_key, sizing_mode, sizing_value, auto_mirror, credential_id)
        values
          ('00000000-0000-4000-8000-000000000411', 'migration-owner', 'user', 'valid-stock', 'pct', 12, true, '00000000-0000-4000-8000-000000000401'),
          ('00000000-0000-4000-8000-000000000412', 'migration-owner', 'user', 'valid-perp', 'ratio', 2, true, '00000000-0000-4000-8000-000000000402'),
          ('00000000-0000-4000-8000-000000000413', 'migration-owner', 'user', 'foreign', 'pct', 12, true, '00000000-0000-4000-8000-000000000403'),
          ('00000000-0000-4000-8000-000000000414', 'migration-owner', 'user', 'bad-mode', 'bogus', 90, true, '00000000-0000-4000-8000-000000000401'),
          ('00000000-0000-4000-8000-000000000415', 'migration-owner', 'user', 'bad-value', 'usd', 0, true, '00000000-0000-4000-8000-000000000401'),
          ('00000000-0000-4000-8000-000000000416', 'migration-owner', 'user', 'unready', 'usd', 100, true, '00000000-0000-4000-8000-000000000404'),
          ('00000000-0000-4000-8000-000000000417', 'migration-owner', 'user', 'disabled-stock', 'usd', 25, false, '00000000-0000-4000-8000-000000000401')
      `);

      await runForwardMigrations(databaseUrl, migrationsDir);
      await assertWorkerCopyMirrorDestinationsCompatibility(drizzle(databaseClient));

      const rows = await queryRows(databaseClient, `
        select
          target_key,
          auto_mirror,
          credential_id,
          destination_policy_initialized,
          stock_auto_mirror,
          stock_credential_id,
          stock_sizing_mode,
          stock_sizing_value,
          perp_auto_mirror,
          perp_credential_id,
          perp_sizing_mode,
          perp_sizing_value
        from copy_trade_follows
        order by target_key
      `);
      const byTarget = new Map(rows.map((row) => [String(row.target_key), row]));

      expect(byTarget.get("valid-stock")).toMatchObject({
        auto_mirror: true,
        credential_id: "00000000-0000-4000-8000-000000000401",
        destination_policy_initialized: true,
        stock_auto_mirror: true,
        stock_credential_id: "00000000-0000-4000-8000-000000000401",
        stock_sizing_mode: "pct",
        stock_sizing_value: "12.00",
        perp_auto_mirror: false,
        perp_credential_id: null,
      });
      expect(byTarget.get("valid-perp")).toMatchObject({
        auto_mirror: true,
        destination_policy_initialized: true,
        stock_auto_mirror: false,
        stock_credential_id: null,
        perp_auto_mirror: true,
        perp_credential_id: "00000000-0000-4000-8000-000000000402",
        perp_sizing_mode: "ratio",
        perp_sizing_value: "2.00",
      });
      for (const target of ["foreign", "bad-mode", "bad-value", "unready"]) {
        expect(byTarget.get(target)).toMatchObject({
          auto_mirror: false,
          credential_id: null,
          destination_policy_initialized: true,
          stock_auto_mirror: false,
          stock_credential_id: null,
          perp_auto_mirror: false,
          perp_credential_id: null,
        });
      }
      expect(byTarget.get("disabled-stock")).toMatchObject({
        auto_mirror: false,
        credential_id: "00000000-0000-4000-8000-000000000401",
        destination_policy_initialized: true,
        stock_auto_mirror: false,
        stock_credential_id: "00000000-0000-4000-8000-000000000401",
        stock_sizing_mode: "usd",
        stock_sizing_value: "25.00",
      });

      const constraintRows = await queryRows(databaseClient, `
        select conname
        from pg_constraint
        where conrelid = 'public.copy_trade_follows'::regclass
          and convalidated
          and conname in (
            'copy_trade_follows_auto_mirror_valid_check',
            'copy_trade_follows_stock_auto_mirror_valid_check',
            'copy_trade_follows_perp_auto_mirror_valid_check'
          )
        order by conname
      `);
      expect(constraintRows.map((row) => row.conname)).toEqual([
        "copy_trade_follows_auto_mirror_valid_check",
        "copy_trade_follows_perp_auto_mirror_valid_check",
        "copy_trade_follows_stock_auto_mirror_valid_check",
      ]);

      await expect(databaseClient.query(`
        insert into copy_trade_follows
          (follower_user_id, target_type, target_key, auto_mirror, stock_auto_mirror, stock_sizing_mode, stock_sizing_value)
        values ('migration-owner', 'user', 'constraint-null-credential', false, true, 'pct', 5)
      `)).rejects.toThrow();
      await expect(databaseClient.query(`
        insert into copy_trade_follows
          (follower_user_id, target_type, target_key, auto_mirror, stock_credential_id, stock_auto_mirror, stock_sizing_mode, stock_sizing_value)
        values ('migration-owner', 'user', 'constraint-bad-mode', false, '00000000-0000-4000-8000-000000000401', true, 'bogus', 90)
      `)).rejects.toThrow();
      await expect(databaseClient.query(`
        insert into copy_trade_follows
          (follower_user_id, target_type, target_key, auto_mirror, perp_credential_id, perp_auto_mirror, perp_sizing_mode, perp_sizing_value)
        values ('migration-owner', 'user', 'constraint-bad-ratio', false, '00000000-0000-4000-8000-000000000402', true, 'ratio', 11)
      `)).rejects.toThrow();

      const provenanceColumns = await queryRows(databaseClient, `
        select column_name, data_type, is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'orders'
          and column_name in ('manual_copy_source_item_id', 'manual_copy_source_order_id')
        order by column_name
      `);
      expect(provenanceColumns).toEqual([
        { column_name: "manual_copy_source_item_id", data_type: "text", is_nullable: "YES" },
        { column_name: "manual_copy_source_order_id", data_type: "uuid", is_nullable: "YES" },
      ]);
    } finally {
      await databaseClient?.end().catch(() => undefined);
      try {
        if (created) {
          await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
        }
      } finally {
        if (migrationDirectory) rmSync(migrationDirectory, { recursive: true, force: true });
        await admin.end().catch(() => undefined);
      }
    }
  }, { timeout: 120_000 });
});
