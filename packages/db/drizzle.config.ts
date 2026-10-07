import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit Configuration
 *
 * This config is used by drizzle-kit CLI for:
 * - Generating migrations from schema changes
 * - Pushing schema directly to database
 * - Running Drizzle Studio
 *
 * Database URL environment variable:
 * - For migrations/push: Use DATABASE_URL_DIRECT (port 5432, direct connection)
 * - For API runtime: Apps use DATABASE_URL_POOLED (port 6543, pooled) via createPoolDb()
 * - For Worker runtime: Apps use DATABASE_URL_DIRECT via createClientDb()
 *
 * Usage:
 *   bun db:generate  # Generate migration from schema changes
 *   bun db:push      # Push schema to DB (requires DATABASE_URL_DIRECT)
 *   bun db:migrate   # Run migrations (requires DATABASE_URL_DIRECT)
 *   bun db:studio    # Open Drizzle Studio (requires DATABASE_URL_DIRECT)
 */

const directDatabaseUrl = process.env.DATABASE_URL_DIRECT;

export default defineConfig({
  // Schema location - all TypeScript schema files
  schema: "./src/schema/**/*.ts",

  // Output directory for generated migrations
  out: "./migrations",

  // Database driver and connection
  dialect: "postgresql",

  // Database connection from environment variable
  // IMPORTANT: Use direct connection (port 5432) for migrations
  // Pooled connections (PgBouncer) don't support all DDL operations
  // Generation is schema-only and must work in a clean checkout without
  // credentials. Database-touching commands are guarded by run-drizzle.ts.
  ...(directDatabaseUrl ? { dbCredentials: { url: directDatabaseUrl } } : {}),

  // Verbose logging for migration generation
  verbose: true,

  // Strict mode - fail on warnings during migration generation
  strict: true,
});
