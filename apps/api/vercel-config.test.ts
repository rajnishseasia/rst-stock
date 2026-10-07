import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(here, "../..");
const vercelConfig = JSON.parse(readFileSync(resolve(here, "vercel.json"), "utf8")) as {
  buildCommand?: string;
};

// Migrations are owned solely by the Railway worker's preDeployCommand
// (see docs/deployment/worker-railway.md). The Vercel API build must never apply
// them: two independent migrators racing the same Supabase database is how the
// worker crash-looped on 2026-08-31.
describe("Vercel API build does not touch the database", () => {
  test("build command runs no migration step", () => {
    const buildCommand = vercelConfig.buildCommand ?? "";
    expect(buildCommand).not.toInclude("vercel-migrate");
    expect(buildCommand).not.toInclude("db:migrate");
    expect(buildCommand).not.toInclude("migrate-forward");
    expect(buildCommand).not.toInclude("drizzle");
  });

  test("the migration scripts are gone, not merely unreferenced", () => {
    expect(existsSync(resolve(here, "scripts/vercel-migrate.mjs"))).toBe(false);
    expect(existsSync(resolve(here, "scripts/vercel-migrate-url.mjs"))).toBe(false);
  });

  test("release docs keep Railway as the sole production migrator", () => {
    const docs = [
      "README.md",
      "docs/deployment/worker-railway.md",
      "docs/deployment/perp-pnl-column-split.md",
      "docs/tasks/LEADERBOARD-TASK3-MAINTAINER-NOTES.md",
    ].map((relativePath) =>
      readFileSync(resolve(repoRoot, relativePath), "utf8"),
    );

    for (const doc of docs) {
      expect(doc).not.toMatch(/Vercel(?:'s| production)? API build (?:runs|uses) the same forward runner/i);
      expect(doc).not.toInclude("MIGRATE_ON_VERCEL_PREVIEW");
      expect(doc).not.toMatch(/SKIP_DB_MIGRATE.*(?:rejected|preview-only)/i);
    }

    expect(docs[0]).toInclude("The Vercel API build does not apply or verify migrations");
    expect(docs[1]).toInclude("The Vercel API build does not run the migration runner");
  });
});
