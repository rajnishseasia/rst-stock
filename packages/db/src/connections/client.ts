import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../schema/index.js";

/**
 * Create long-running PostgreSQL connection using pg.Client
 *
 * Designed for long-running worker processes on VPS (not serverless).
 *
 * Suitable for:
 * - Background workers (listener, pending-sell-processor, etc.)
 * - LISTEN/NOTIFY operations
 * - Long-running jobs that need persistent connections
 * - PM2-managed processes
 *
 * IMPORTANT: Use DIRECT connection string (port 5432) for workers:
 * postgresql://postgres.[REF]:[PASS]@db.[REF].supabase.co:5432/postgres
 *
 * DO NOT use Transaction Pooler (port 6543) for workers - it's designed for serverless.
 * DO NOT use ?pgbouncer=true parameter - direct connections support prepared statements.
 *
 * For serverless/Vercel deployments, use createPoolDb() instead.
 *
 * @param connectionString - PostgreSQL connection string (direct connection, port 5432)
 * @returns Drizzle database instance with client connection
 */
export function createClientDb(connectionString: string) {
  if (!connectionString) {
    throw new Error("Database connection string is required for client connection");
  }

  // Create single persistent client for long-running processes
  const client = new Client({
    connectionString,
    // Long-lasting connection settings for workers
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: 30000,
  });

  // Connect to database
  client.connect().catch((err) => {
    console.error("[DB Client] Failed to connect to database (worker):", err);
  });

  // Add error handling
  client.on("error", (err) => {
    console.error("[DB Client] Database connection error (worker):", err);
  });

  client.on("end", () => {
    if (process.env.NODE_ENV !== "production") {
      console.log("[DB Client] Database connection ended (worker)");
    }
  });

  // Log connection info in development
  if (process.env.NODE_ENV !== "production") {
    console.log("[DB Client] Worker database connection initialized (single persistent Client)");
    console.log("[DB Client] IMPORTANT: Use direct connection (port 5432) for workers");
  }

  // Create and return Drizzle instance with node-postgres adapter and schema
  // Schema is required for proper TypeScript inference and query API access
  return drizzle(client, { schema });
}

/**
 * Type-safe database instance for long-running worker processes
 */
export type ClientDb = ReturnType<typeof createClientDb>;
