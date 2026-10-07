import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

interface Snapshot {
  id: string;
  prevId: string;
  version: string;
  dialect: string;
}

export function validateMigrationHistory(migrationsDir: string): void {
  const metaDir = join(migrationsDir, "meta");
  const journalPath = join(metaDir, "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;

  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Migration journal has no entries");
  }

  const sqlFiles = new Set(
    readdirSync(migrationsDir).filter((file) => /^\d{4}_.+\.sql$/.test(file)),
  );
  const seenTags = new Set<string>();
  const seenSnapshotIds = new Set<string>();
  let previousSnapshotId = "00000000-0000-0000-0000-000000000000";

  journal.entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      throw new Error(`Migration journal index ${entry.idx} is not contiguous at position ${position}`);
    }
    if (seenTags.has(entry.tag)) {
      throw new Error(`Migration journal contains duplicate tag ${entry.tag}`);
    }
    seenTags.add(entry.tag);

    const sqlFile = `${entry.tag}.sql`;
    if (!sqlFiles.delete(sqlFile)) {
      throw new Error(`Migration journal entry ${entry.tag} has no matching SQL file`);
    }

    const snapshotPath = join(metaDir, `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
    if (!existsSync(snapshotPath)) {
      throw new Error(`Migration ${entry.tag} has no matching snapshot`);
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
    if (snapshot.version !== "7" || snapshot.dialect !== "postgresql") {
      throw new Error(`Snapshot ${basename(snapshotPath)} has incompatible metadata`);
    }
    if (snapshot.prevId !== previousSnapshotId) {
      throw new Error(`Snapshot ${basename(snapshotPath)} does not continue the snapshot chain`);
    }
    if (seenSnapshotIds.has(snapshot.id)) {
      throw new Error(`Snapshot ${basename(snapshotPath)} reuses snapshot id ${snapshot.id}`);
    }
    seenSnapshotIds.add(snapshot.id);
    previousSnapshotId = snapshot.id;
  });

  if (sqlFiles.size > 0) {
    throw new Error(`Unjournaled migration SQL: ${[...sqlFiles].sort().join(", ")}`);
  }
}

if (import.meta.main) {
  // `fileURLToPath` rather than `new URL(...).pathname`: on Windows the latter
  // yields a leading-slash, percent-encoded string such as `/C:/Users/...`, which
  // is not a usable filesystem path. That made the migration scripts fail with
  // ENOENT on any Windows checkout while working on the Linux CI box.
  validateMigrationHistory(fileURLToPath(new URL("../migrations", import.meta.url)));
  console.log("Migration journal, SQL files, and snapshot chain are valid.");
}
