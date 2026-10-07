import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  assertWorkerCanonicalIngestionCompatibility,
  assertWorkerCopyMirrorCompatibility,
  assertWorkerCopyMirrorDestinationsCompatibility,
  assertWorkerCopyTradeCapsCompatibility,
  assertWorkerCopyTradeLeverageCompatibility,
  assertWorkerWalletCopyCursorCompatibility,
  assertWorkerSchemaCompatibility,
} from "../src/migration-compatibility.js";
import { withMigrationLock } from "./migrate-forward.js";
import { validateDirectDatabaseUrl } from "./run-drizzle.js";

/** Verify every schema contract the worker needs before it starts processing jobs. */
export async function verifyWorkerSchema(databaseUrl: string): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
  });
  let connected = false;

  try {
    await client.connect();
    connected = true;
    await withMigrationLock(client, {}, async () => {
      const db = drizzle(client);
      await assertWorkerSchemaCompatibility(db);
      await assertWorkerCanonicalIngestionCompatibility(db);
      await assertWorkerCopyMirrorCompatibility(db);
      await assertWorkerCopyMirrorDestinationsCompatibility(db);
      await assertWorkerCopyTradeLeverageCompatibility(db);
      await assertWorkerCopyTradeCapsCompatibility(db);
      await assertWorkerWalletCopyCursorCompatibility(db);
    });
  } finally {
    if (connected) await client.end();
  }
}

if (import.meta.main) {
  const databaseUrl = validateDirectDatabaseUrl(process.env.DATABASE_URL_DIRECT);
  await verifyWorkerSchema(databaseUrl);
  console.log("Worker schema compatibility checks passed.");
}
