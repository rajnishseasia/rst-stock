import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export const PERP_ENUM_COMMIT_BOUNDARY = "0015_overrated_franklin_richards";
export const NO_TRANSACTION_DIRECTIVE = "-- @no-transaction";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const MIGRATION_LOCK_KEY = "trade-bot:drizzle-forward-migrations";
export const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
export const MIGRATION_LOCK_POLL_INTERVAL_MS = 250;

/**
 * 0032 was corrected twice after it first shipped. These are the only older
 * hashes we accept from an existing journal; 0035 is the committed forward
 * repair that restores the current index definitions. Unknown hashes still
 * fail closed so a hand-edited or unreviewed migration cannot be skipped.
 */
export const ACCEPTED_LEGACY_MIGRATION_HASHES: Readonly<Record<string, readonly string[]>> = {
  "0032_new_moon_knight": [
    "34008a9b82cab33e89cc844ba4d108583882c0c879996b30b7b7e8460b099428",
    "8c2c076ae7857817ca9ff7657c3fe1433badda092e852d4582649ad6c00b13d5",
  ],
};

export type MigrationExecutionMode = "transactional" | "nontransactional";

export interface MigrationClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface MigrationRunnerOptions {
  createClient?: (databaseUrl: string) => MigrationClient;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface MigrationJournalEntry {
  tag: string;
  when: number | string | null | undefined;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

export interface MigrationFile {
  tag: string;
  folderMillis: number;
  hash: string;
  statements: string[];
  executionMode?: MigrationExecutionMode;
}

export interface LastDatabaseMigration {
  created_at: number | string | null | undefined;
}

export interface DatabaseMigrationJournalEntry {
  hash: string | null | undefined;
  created_at: number | string | null | undefined;
}

function parseMigrationCreatedAt(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Read the committed Drizzle journal without changing any migration files. */
export function readMigrationFiles(
  migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url)),
): MigrationFile[] {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as MigrationJournal;
  if (!Array.isArray(journal.entries)) {
    throw new Error("Migration journal has no entries");
  }

  let previousFolderMillis = -1;
  return journal.entries.map((entry, index) => {
    const folderMillis = parseMigrationCreatedAt(entry.when);
    if (folderMillis === null) {
      throw new Error(`Migration journal has an invalid timestamp at entry ${index}.`);
    }
    if (folderMillis <= previousFolderMillis) {
      throw new Error("Migration journal timestamps must be strictly increasing.");
    }
    previousFolderMillis = folderMillis;
    const sql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    const lines = sql.split(/\r?\n/);
    const executionMode = lines[0]?.trim() === NO_TRANSACTION_DIRECTIVE
      ? "nontransactional"
      : "transactional";
    const executableSql = executionMode === "nontransactional"
      ? lines.slice(1).join("\n")
      : sql;
    return {
      tag: entry.tag,
      folderMillis,
      hash: createHash("sha256").update(sql).digest("hex"),
      statements: executableSql
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter(Boolean),
      executionMode,
    };
  });
}

/**
 * Ensure the database journal is exactly a prefix of the committed journal.
 *
 * Drizzle normally uses the latest timestamp to find pending migrations. That
 * is not sufficient if a row was deleted, inserted out of order, or its SQL
 * hash was changed. Failing closed here prevents a deploy from silently
 * running against a schema whose migration history no longer matches the
 * repository.
 */
export function validateAppliedMigrationJournal(
  migrations: readonly MigrationFile[],
  appliedEntries: readonly DatabaseMigrationJournalEntry[],
): void {
  const migrationsByTimestamp = new Map<number, MigrationFile>();
  let previousMigrationTimestamp = -1;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.folderMillis) || migration.folderMillis < 0) {
      throw new Error(`Committed migration ${migration.tag} has an invalid timestamp.`);
    }
    if (migration.folderMillis <= previousMigrationTimestamp) {
      throw new Error("Committed migration timestamps must be strictly increasing.");
    }
    if (migrationsByTimestamp.has(migration.folderMillis)) {
      throw new Error(`Committed migrations contain duplicate timestamp ${migration.folderMillis}.`);
    }
    migrationsByTimestamp.set(migration.folderMillis, migration);
    previousMigrationTimestamp = migration.folderMillis;
  }

  const seenTimestamps = new Set<number>();
  for (const [index, entry] of appliedEntries.entries()) {
    const createdAt = parseMigrationCreatedAt(entry.created_at);
    if (createdAt === null) {
      throw new Error(`Database migration journal has an invalid timestamp at row ${index}.`);
    }
    if (seenTimestamps.has(createdAt)) {
      throw new Error(`Database migration journal contains duplicate timestamp ${createdAt}.`);
    }
    seenTimestamps.add(createdAt);

    const migration = migrationsByTimestamp.get(createdAt);
    if (!migration) {
      throw new Error(`Database migration journal contains unknown timestamp ${createdAt}.`);
    }
    const expectedMigration = migrations[index];
    if (!expectedMigration || expectedMigration.folderMillis !== createdAt) {
      throw new Error(
        `Database migration journal is not a contiguous committed prefix: expected ${expectedMigration?.tag ?? "no further committed migrations"} before ${migration.tag}.`,
      );
    }
    const acceptedLegacyHashes = ACCEPTED_LEGACY_MIGRATION_HASHES[migration.tag] ?? [];
    if (entry.hash !== migration.hash && !acceptedLegacyHashes.includes(entry.hash ?? "")) {
      throw new Error(`Database migration journal hash mismatch for ${migration.tag}.`);
    }
  }
}

function migrationExecutionMode(migration: MigrationFile): MigrationExecutionMode {
  return migration.executionMode ?? "transactional";
}

async function acquireMigrationLock(
  client: MigrationClient,
  options: MigrationRunnerOptions,
): Promise<void> {
  const timeoutMs = options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.lockPollIntervalMs ?? MIGRATION_LOCK_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Migration lock timeout must be a finite nonnegative number.");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Migration lock poll interval must be a finite positive number.");
  }

  const deadline = now() + timeoutMs;
  while (true) {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [MIGRATION_LOCK_KEY],
    );
    if (result.rows[0]?.locked === true) return;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `Could not acquire migration lock within ${timeoutMs}ms; another migration may be running. Retry the deployment.`,
      );
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

async function releaseMigrationLock(client: MigrationClient): Promise<void> {
  await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
}

/**
 * Run work while holding the same session-scoped lock used by migrations.
 *
 * Schema verification must use this helper too. Otherwise two deploys can
 * interleave like this: deploy A finishes migrations, deploy B starts a
 * nontransactional index repair, and deploy A verifies the half-rebuilt
 * schema. Keeping the verification on the lock makes the deployment
 * preflight deterministic without extending the lock across processes.
 */
export async function withMigrationLock<T>(
  client: MigrationClient,
  options: MigrationRunnerOptions = {},
  work: () => Promise<T>,
): Promise<T> {
  await acquireMigrationLock(client, options);
  let result: T | undefined;
  let workError: unknown;
  let workFailed = false;
  try {
    result = await work();
  } catch (error) {
    workFailed = true;
    workError = error;
  }

  let releaseError: unknown;
  let releaseFailed = false;
  try {
    await releaseMigrationLock(client);
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  // Preserve the useful migration/verification error if the connection is
  // already failing, but surface a lock-release failure on success.
  if (workFailed) throw workError;
  if (releaseFailed) throw releaseError;
  return result as T;
}

/**
 * Split pending migrations at the historical enum introduction.
 *
 * `asset_type` receives PERP in 0015, while 0025 contains a partial index
 * whose predicate parses PERP. PostgreSQL cannot use a newly-added enum value
 * in the same transaction that adds it. A committed boundary is therefore
 * required for a clean database, while already-journaled production history
 * naturally starts after the boundary.
 */
export function planMigrationBatches(
  migrations: MigrationFile[],
  lastDatabaseMigration: LastDatabaseMigration | null,
): MigrationFile[][] {
  const lastCreatedAt = lastDatabaseMigration?.created_at == null
    ? null
    : Number(lastDatabaseMigration.created_at);
  const pending = migrations.filter((migration) =>
    lastCreatedAt === null || migration.folderMillis > lastCreatedAt,
  );
  if (pending.length === 0) return [];

  const batches: MigrationFile[][] = [];
  let current: MigrationFile[] = [];
  let currentMode: MigrationExecutionMode | null = null;
  for (const migration of pending) {
    const mode = migrationExecutionMode(migration);
    const modeChanged = currentMode !== null && mode !== currentMode;
    const enumBoundary = current.at(-1)?.tag === PERP_ENUM_COMMIT_BOUNDARY;
    if (current.length > 0 && (modeChanged || enumBoundary)) {
      batches.push(current);
      current = [];
      currentMode = null;
    }
    current.push(migration);
    currentMode = mode;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function journalMigration(client: MigrationClient, migration: MigrationFile): Promise<void> {
  await client.query(
    'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)',
    [migration.hash, migration.folderMillis],
  );
}

async function applyMigrationStatements(
  client: MigrationClient,
  migration: MigrationFile,
): Promise<void> {
  for (const statement of migration.statements) {
    await client.query(statement);
  }
  // Journal only after every statement for this migration has succeeded. The
  // concurrent-index migration explicitly drops each named relation before its
  // create, so a retry repairs invalid or wrong same-name indexes instead of
  // accepting them by name.
  await journalMigration(client, migration);
}

function migrationBatchError(batch: MigrationFile[], error: unknown): Error {
  return new Error(
    `Migration batch failed at ${batch[0]?.tag ?? "unknown"}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

/** Apply committed migrations with the minimum transaction boundaries needed by PostgreSQL. */
export async function runForwardMigrations(
  databaseUrl: string,
  migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url)),
  options: MigrationRunnerOptions = {},
): Promise<void> {
  const migrations = readMigrationFiles(migrationsDir);
  const client = options.createClient?.(databaseUrl) ?? new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await withMigrationLock(client, options, async () => {
      await client.query('create schema if not exists "drizzle"');
      await client.query(`
        create table if not exists "drizzle"."__drizzle_migrations" (
          id serial primary key,
          hash text not null,
          created_at numeric
        )
      `);
      const appliedMigrations = await client.query<DatabaseMigrationJournalEntry>(
        'select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at asc',
      );
      validateAppliedMigrationJournal(migrations, appliedMigrations.rows);
      const latest = appliedMigrations.rows.at(-1);
      const batches = planMigrationBatches(migrations, latest ?? null);

      for (const batch of batches) {
        const batchMode = migrationExecutionMode(batch[0]!);
        if (batch.some((migration) => migrationExecutionMode(migration) !== batchMode)) {
          throw new Error(`Migration batch mixes transaction modes at ${batch[0]?.tag ?? "unknown"}`);
        }

        if (batchMode === "nontransactional") {
          try {
            for (const migration of batch) {
              await applyMigrationStatements(client, migration);
            }
          } catch (error) {
            throw migrationBatchError(batch, error);
          }
          continue;
        }

        await client.query("begin");
        try {
          for (const migration of batch) {
            await applyMigrationStatements(client, migration);
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw migrationBatchError(batch, error);
        }
      }
    });
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL_DIRECT;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_DIRECT is required for forward migrations.");
  }
  await runForwardMigrations(databaseUrl);
  console.log("Forward migrations applied successfully.");
}
