import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMigrationHistory } from "./validate-migrations";
import { fileURLToPath } from "node:url";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { includeSql?: boolean; prevId?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "migration-history-"));
  roots.push(root);
  mkdirSync(join(root, "meta"));
  writeFileSync(
    join(root, "meta", "_journal.json"),
    JSON.stringify({ entries: [{ idx: 0, tag: "0000_initial" }] }),
  );
  writeFileSync(
    join(root, "meta", "0000_snapshot.json"),
    JSON.stringify({
      id: "snapshot-0",
      prevId: options.prevId ?? "00000000-0000-0000-0000-000000000000",
      version: "7",
      dialect: "postgresql",
    }),
  );
  if (options.includeSql !== false) writeFileSync(join(root, "0000_initial.sql"), "SELECT 1;");
  return root;
}

describe("validateMigrationHistory", () => {
  test("accepts the repository's committed migration history", () => {
    expect(() =>
      validateMigrationHistory(fileURLToPath(new URL("../migrations", import.meta.url)))
    ).not.toThrow();
  });

  test("accepts a contiguous journal, SQL set, and snapshot chain", () => {
    expect(() => validateMigrationHistory(fixture())).not.toThrow();
  });

  test("rejects missing SQL and broken snapshot ancestry", () => {
    expect(() => validateMigrationHistory(fixture({ includeSql: false }))).toThrow("no matching SQL");
    expect(() => validateMigrationHistory(fixture({ prevId: "wrong-parent" }))).toThrow("snapshot chain");
  });
});
