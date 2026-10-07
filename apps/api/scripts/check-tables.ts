import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";

const db = getDb();
const result = await db.execute(sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('chat_conversations', 'chat_messages', 'copy_trade_follows')
  ORDER BY table_name;
`);
console.log("Tables present:", result.rows.map((r: any) => r.table_name));
process.exit(0);
