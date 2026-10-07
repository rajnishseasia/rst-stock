import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema/index.js";

/**
 * Create connection pool for long-running worker processes.
 *
 * Unlike serverless pool (pool.ts), this is optimized for:
 * - Long-running VPS workers (PM2-managed)
 * - Parallel database operations within a single process
 * - Direct connection (port 5432) for transaction support
 *
 * IMPORTANT: Use DIRECT connection string (port 5432):
 * postgresql://postgres.[REF]:[PASS]@db.[REF].supabase.co:5432/postgres
 *
 * DO NOT use Transaction Pooler (port 6543) - it doesn't support transactions properly.
 *
 * @param connectionString - PostgreSQL direct connection string (port 5432)
 * @param poolSize - Max connections in pool (default: 5, recommended: 5-10)
 * @returns Drizzle database instance with pool connection
 */
export function createWorkerPoolDb(connectionString: string, poolSize = 5) {
  if (!connectionString) {
    throw new Error("Database connection string is required for worker pool");
  }

  const pool = new Pool({
    connectionString,
    // Worker-optimized pool settings
    min: 1, // Keep at least 1 connection ready
    max: poolSize, // Max parallel operations
    idleTimeoutMillis: 30000, // Close idle connections after 30s
    connectionTimeoutMillis: 10000, // 10s connection timeout
    // Keep connections alive for long-running workers
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  // Error handling
  pool.on("error", (err) => {
    console.error("[DB Worker Pool] Unexpected pool error:", err);
  });

  // Log pool info in development
  if (process.env.NODE_ENV !== "production") {
    console.log(`[DB Worker Pool] Initialized with max=${poolSize} connections`);
    console.log("[DB Worker Pool] Using direct connection (port 5432)");
  }

  return drizzle(pool, { schema });
}

/**
 * Type-safe database instance for worker processes with connection pooling.
 */
export type WorkerPoolDb = ReturnType<typeof createWorkerPoolDb>;
