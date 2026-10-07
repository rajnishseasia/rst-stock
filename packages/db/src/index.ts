/**
 * @trade-bot/db - Database package exports
 *
 * Main entry point for the database package.
 */

// ============================================================================
// SCHEMA EXPORTS (Drizzle tables and relations)
// ============================================================================

import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { schema };

// ============================================================================
// CONNECTION EXPORTS
// ============================================================================

export * from "./connections/index.js";
export type { PoolDb } from "./connections/pool.js";
export type { ClientDb } from "./connections/client.js";
export type { WorkerPoolDb } from "./connections/worker-pool.js";
export { createPoolDb, getDb } from "./connections/index.js";
export { createClientDb } from "./connections/client.js";
export { createWorkerPoolDb } from "./connections/worker-pool.js";
export {
  assertWorkerCanonicalIngestionCompatibility,
  assertWorkerCopyMirrorCompatibility,
  assertWorkerCopyMirrorDestinationsCompatibility,
  assertWorkerCopyTradeCapsCompatibility,
  assertWorkerCopyTradeLeverageCompatibility,
  assertWorkerWalletCopyCursorCompatibility,
  assertWorkerSchemaCompatibility,
  workerSchemaHasCanonicalIngestion,
  workerSchemaHasCopyMirrorIndexes,
  workerSchemaHasCopyMirrorDestinations,
  workerSchemaHasCopyTradeCaps,
  workerSchemaHasCopyTradeLeverage,
  workerSchemaHasWalletCopyCursor,
  workerSchemaHasOrderId,
  WORKER_CANONICAL_INGESTION_MIGRATION,
  WORKER_COPY_MIRROR_INDEX_MIGRATION,
  WORKER_COPY_MIRROR_DESTINATIONS_MIGRATION,
  WORKER_COPY_TRADE_CAP_MIGRATION,
  WORKER_COPY_TRADE_LEVERAGE_MIGRATION,
  WORKER_WALLET_COPY_CURSOR_MIGRATION,
  WORKER_ORDER_ID_MIGRATION,
} from "./migration-compatibility.js";

// ============================================================================
// REPOSITORY EXPORTS
// ============================================================================

export { UserRepository } from "./repositories/user.repository.js";

// Shared SQL timestamp key used by stable worker and API pagination.
export { millisecondTimestamp, millisecondTimestampValue } from "./pagination/timestamp-key.js";


// Order lifecycle CAS helpers shared by API and worker writers.
export {
  canAdvanceOrderStatus,
  monotonicOrderStatusValue,
  orderStatusRankSql,
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
  ORDER_STATUS_RANK,
  type OrderStatus,
} from "./order-status.js";

// ============================================================================
// ERROR EXPORTS
// ============================================================================

export * from "./errors/index.js";
