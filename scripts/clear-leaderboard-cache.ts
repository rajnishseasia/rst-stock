/**
 * Clear stale leaderboard Redis cache entries so the next request re-queries.
 */
import IORedis from "ioredis";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("clear-leaderboard-cache");

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL not set");
  process.exit(1);
}

const client = new IORedis(redisUrl);

const patterns = [
  "leaderboard:users:v11:*",
  "leaderboard:users:v10:*",
];

let totalDeleted = 0;
for (const pattern of patterns) {
  const keys = await client.keys(pattern);
  if (keys.length > 0) {
    await client.del(...keys);
    console.log(`Deleted ${keys.length} keys matching "${pattern}":`, keys);
    totalDeleted += keys.length;
  } else {
    console.log(`No keys found matching "${pattern}"`);
  }
}

console.log(`Total deleted: ${totalDeleted}`);
await client.quit();
process.exit(0);
