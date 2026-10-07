import { schema } from "@trade-bot/db";
import { sql, type SQL } from "drizzle-orm";

/** The single internal account allowed to see Shardi's relayed tweets. */
export function isProfessorUser(user: {
  name?: string | null;
  username?: string | null;
  email?: string | null;
}): boolean {
  return user.email?.trim().toLowerCase() === "napindc@vt.edu";
}

/** Matches modern and legacy metadata for every Shardi author-name variant. */
export function shardiSignalCondition(): SQL<boolean> {
  const modern = sql<boolean>`
    coalesce(${schema.signals.metadata}->>'authorName', '') ~* 'shardi'
  `;
  const legacy = sql<boolean>`
    jsonb_typeof(${schema.signals.metadata}) = 'string'
    and coalesce(${schema.signals.metadata} #>> '{}', '') ~* '"authorName"\\s*:\\s*"[^"]*shardi'
  `;
  return sql<boolean>`(${modern}) or (${legacy})`;
}
