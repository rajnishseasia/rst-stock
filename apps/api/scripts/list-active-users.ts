import { getDb, schema } from "@trade-bot/db";
import { eq } from "drizzle-orm";
import { maskEmail, requireLocalDbOrExplicitConsent } from "./lib/guard.js";

// Audit M2: refuse non-local DBs without consent; mask emails in output.
requireLocalDbOrExplicitConsent("list-active-users");

const db = getDb();

// Who has an Alpaca + LLM credential already?
const usersWithCreds = await db
  .select({
    userId: schema.users.id,
    email: schema.users.email,
    name: schema.users.name,
  })
  .from(schema.users);

for (const u of usersWithCreds) {
  const llm = await db
    .select()
    .from(schema.userLlmApiCredentials)
    .where(eq(schema.userLlmApiCredentials.userId, u.userId));
  const broker = await db
    .select()
    .from(schema.userApiCredentials)
    .where(eq(schema.userApiCredentials.userId, u.userId));
  if (llm.length > 0 || broker.length > 0) {
    console.log(
      `${maskEmail(u.email).padEnd(34)}  llm=${llm.map((c) => c.provider).join(",") || "-"}  broker=${broker.map((c) => `${c.provider}/${c.accountType ?? "?"}`).join(",") || "-"}`,
    );
  }
}
process.exit(0);
