/**
 * Debug: show the name/twitterName/username/image stored for twitter-linked users.
 */
import { getDb, schema } from "@trade-bot/db";
import { eq } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-twitter-identity");

const db = getDb();

const twitterAccounts = await db
  .select({ userId: schema.accounts.userId, accountId: schema.accounts.accountId })
  .from(schema.accounts)
  .where(eq(schema.accounts.providerId, "twitter"));

for (const acct of twitterAccounts) {
  const user = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.id, acct.userId),
    columns: { id: true, name: true, twitterName: true, username: true, image: true },
  });
  if (!user) continue;
  console.log("---");
  console.log("userId:", user.id.slice(0, 12) + "...");
  console.log("name:", user.name);
  console.log("twitterName:", user.twitterName);
  console.log("username:", user.username);
  console.log("image:", user.image ? user.image.slice(0, 80) + "..." : null);
  console.log("accountId (twitter numeric ID):", acct.accountId);
}

process.exit(0);
