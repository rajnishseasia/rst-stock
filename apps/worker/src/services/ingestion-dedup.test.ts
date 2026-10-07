import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "@trade-bot/db";
import { applySourceEventDedup } from "./ingestion-dedup";

describe("source-event dedup SQL", () => {
  it("uses intentional targetless DO NOTHING for the partial unique index", () => {
    const db = drizzle(
      { query: () => Promise.resolve({ rows: [], fields: [] }) } as never,
      { schema },
    );
    const builder = db.insert(schema.signals).values({
      source: "discord",
      sourceEventId: "discord:channel:1:AAPL",
      symbol: "AAPL",
      content: "$AAPL",
      timestamp: new Date("2026-08-21T12:00:00.000Z"),
    });

    const compiled = (applySourceEventDedup(builder) as typeof builder).toSQL();

    expect(compiled.sql.toLowerCase()).toContain("on conflict do nothing");
    expect(compiled.sql.toLowerCase()).not.toContain(
      'on conflict ("source","source_event_id")',
    );
  });
});
