/**
 * @trade-bot/db - Database Connections
 *
 * Factory functions for creating database connections:
 * - createPoolDb: Serverless-optimized pool connection for API (Vercel)
 * - createClientDb: Long-running single client connection for listener (VPS/PM2)
 * - createWorkerPoolDb: Worker-optimized pool for parallel DB operations (VPS/PM2)
 * - getDb: Singleton getter for lazy-initialized pool database connection
 */

import { createPoolDb, type PoolDb } from "./pool.js";

export { createPoolDb, type PoolDb } from "./pool.js";
export { createClientDb, type ClientDb } from "./client.js";
export { createWorkerPoolDb, type WorkerPoolDb } from "./worker-pool.js";

// Database instance (singleton, lazy-initialized)
// Use DATABASE_URL_POOLED for serverless (Vercel) or DATABASE_URL as fallback
let db: PoolDb | null = null;

/**
 * Get or create a singleton database connection instance
 *
 * Lazy initialization allows graceful handling in development.
 * Uses DATABASE_URL_POOLED for serverless environments or DATABASE_URL as fallback.
 *
 * @returns PoolDb instance
 * @throws Error if neither DATABASE_URL_POOLED nor DATABASE_URL is set
 */
export function getDb(): PoolDb {
  if (!db) {
    const databaseUrl = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;

    if (!databaseUrl) {
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "❌ DATABASE_URL_POOLED or DATABASE_URL not set. API requires database connection.",
        );
        console.error("   Set DATABASE_URL_POOLED or DATABASE_URL environment variable.");
        console.error("   API server will exit. Set environment variables to continue.");
      }
      throw new Error(
        "DATABASE_URL_POOLED or DATABASE_URL environment variable is required",
      );
    }
    db = createPoolDb(databaseUrl);
  }
  return db;
}
