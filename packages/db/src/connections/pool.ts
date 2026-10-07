import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "../schema/index.js";

/**
 * Create serverless-optimized PostgreSQL connection using pg.Pool
 *
 * Configuration based on 2025 Vercel Fluid Compute + Supabase best practices:
 * - Uses connection pooling to reuse connections across requests in Vercel's Fluid Compute
 * - attachDatabasePool helper manages idle connections in Fluid Compute (prevents phantom connections)
 * - Low idle timeout (5s) prevents connection leaks in suspended serverless functions
 * - No eager minimum and two connections per instance by default, balancing
 *   concurrent requests with Supabase's project-wide session cap
 * - allowExitOnIdle allows pool to close gracefully when idle
 *
 * CRITICAL: Use Supabase's Transaction Pooler (port 6543) connection string in production:
 * postgresql://postgres.[REF]:[PASS]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true
 *
 * DO NOT use direct connection (port 5432) - it will exhaust connection pool in serverless.
 *
 * The ?pgbouncer=true parameter is REQUIRED to disable prepared statements which are
 * incompatible with Supabase's transaction pooler.
 *
 * @param connectionString - PostgreSQL connection string (must include ?pgbouncer=true for Supabase)
 * @returns Drizzle database instance with pool connection
 */
export function createPoolDb(connectionString: string) {
  if (!connectionString) {
    throw new Error("Database connection string is required for pool connection");
  }

  const poolConfig = serverlessPoolConfig(connectionString);
  const client = new Pool(poolConfig);

  // CRITICAL: Attach database pool for Vercel Fluid Compute
  // This helper uses waitUntil to keep the instance alive during connection cleanup,
  // preventing "phantom" connections from suspended functions.
  // Official Vercel recommendation: https://vercel.com/guides/connection-pooling-with-functions
  attachDatabasePool(client);

  // Graceful error handling for unexpected pool errors
  client.on("error", (err) => {
    console.error("[DB Pool] Unexpected database pool error:", err);
    // Don't exit process - let Vercel handle restart
  });

  // Log pool info in development
  if (process.env.NODE_ENV !== "production") {
    console.log("[DB Pool] Database connection pool initialized for serverless");
    console.log(
      `[DB Pool] Config: min=0, max=${poolConfig.max}, idleTimeout=5s, maxLifetime=5m`,
    );
    console.log("[DB Pool] IMPORTANT: Use Transaction Pooler (port 6543) in production");
  }

  // Create and return Drizzle instance with node-postgres adapter and schema
  // Schema is required for proper TypeScript inference and query API access
  return drizzle(client, { schema });
}

const DEFAULT_SERVERLESS_POOL_MAX = 2;
const MAX_SERVERLESS_POOL_MAX = 4;

/**
 * Build the serverless pool configuration without opening a connection.
 *
 * Supabase counts PgBouncer client sessions as well as direct connections.
 * Because each warm function instance owns its own pg.Pool, a large per-instance
 * maximum quickly exhausts a small project-wide session allowance. Keep the
 * default at two and only permit a small, explicit operational override.
 */
export function serverlessPoolConfig(
  connectionString: string,
  configuredMax = process.env.SERVERLESS_DB_POOL_MAX,
): PoolConfig {
  return {
    connectionString,
    min: 0,
    max: parseServerlessPoolMax(configuredMax),
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 15000,
    allowExitOnIdle: true,
    maxLifetimeSeconds: 5 * 60,
    statement_timeout: 30000,
  };
}

export function parseServerlessPoolMax(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SERVERLESS_POOL_MAX;
  if (!/^\d+$/.test(value.trim())) return DEFAULT_SERVERLESS_POOL_MAX;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SERVERLESS_POOL_MAX) {
    return DEFAULT_SERVERLESS_POOL_MAX;
  }
  return parsed;
}

/**
 * Type-safe database instance for serverless environments
 */
export type PoolDb = ReturnType<typeof createPoolDb>;
