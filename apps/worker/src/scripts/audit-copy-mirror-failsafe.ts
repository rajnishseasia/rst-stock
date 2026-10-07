/** Read-only operator audit. This script cannot stage or submit an order. */
import { createWorkerPoolDb } from "@trade-bot/db";

import { CopyMirrorPositionFailsafe } from "../services/copy-mirror-position-failsafe";

const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL is required");
const db = createWorkerPoolDb(connectionString, 2);
process.env.COPY_MIRROR_FAILSAFE_AUDIT_DETAIL = "true";
const failsafe = new CopyMirrorPositionFailsafe(db, async () => {
  throw new Error("read-only audit attempted to stage a close");
});
const candidates = await failsafe.auditExposureCandidates();
const rogue = await failsafe.auditOnce();
console.error(`Audited ${candidates.length} attributed mirrored exposure candidate(s)`);
console.log(JSON.stringify(rogue.map((row) => ({
  followerUserId: row.followerUserId,
  followerWallet: `${row.followerWallet.slice(0, 8)}...${row.followerWallet.slice(-4)}`,
  sourceWallet: `${row.sourceWallet.slice(0, 8)}...${row.sourceWallet.slice(-4)}`,
  network: row.venueNetwork,
  coin: row.coin,
  side: row.side,
  mirroredSize: row.size,
  exposureKey: row.exposureKey.slice(0, 12),
})), null, 2));
process.exit(0);
