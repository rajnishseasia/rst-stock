import { fileURLToPath } from "node:url";

import { runForwardMigrations } from "./migrate-forward.js";
import { validateMigrationHistory } from "./validate-migrations.js";

const databaseCommands = new Set(["migrate", "push", "studio"]);

export function validateDirectDatabaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error(
      "DATABASE_URL_DIRECT is required for database commands. Use a direct PostgreSQL connection, not a pooled/PgBouncer URL.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_DIRECT must be a valid PostgreSQL connection URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL_DIRECT must use the postgres:// or postgresql:// protocol.");
  }

  if (parsed.port === "6543") {
    throw new Error(
      "DATABASE_URL_DIRECT points to a transaction pooler on port 6543. Use the direct database endpoint or Supavisor session mode on port 5432 for DDL.",
    );
  }

  return value;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (!command || !databaseCommands.has(command)) {
    throw new Error(`Expected one of: ${[...databaseCommands].join(", ")}`);
  }

  const databaseUrl = validateDirectDatabaseUrl(process.env.DATABASE_URL_DIRECT);

  if (command === "migrate") {
    validateMigrationHistory(fileURLToPath(new URL("../migrations", import.meta.url)));
    await runForwardMigrations(databaseUrl);
    console.log("Forward migrations applied successfully.");
    process.exit(0);
  }

  // drizzle-kit 0.22 needs tsx's loader to resolve the schema's ESM-style
  // `.js` imports back to their TypeScript sources.
  const child = Bun.spawn(["bunx", "tsx", "node_modules/drizzle-kit/bin.cjs", command], {
    // `fileURLToPath` rather than `new URL(...).pathname`: on Windows the latter
    // yields a leading-slash, percent-encoded string such as `/C:/Users/...`, which
    // is not a usable filesystem path. That made the migration scripts fail with
    // ENOENT on any Windows checkout while working on the Linux CI box.
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
