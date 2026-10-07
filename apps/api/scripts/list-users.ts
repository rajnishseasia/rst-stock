import { getDb, schema } from "@trade-bot/db";
import { desc } from "drizzle-orm";
import { maskEmail, requireLocalDbOrExplicitConsent } from "./lib/guard.js";

// Audit M2: refuse to touch a non-local DB without explicit consent, and
// never print full user emails (mask them).
requireLocalDbOrExplicitConsent("list-users");

const db = getDb();
const users = await db
  .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, createdAt: schema.users.createdAt })
  .from(schema.users)
  .orderBy(desc(schema.users.createdAt))
  .limit(20);
console.table(users.map((u) => ({ ...u, email: maskEmail(u.email) })));
process.exit(0);
