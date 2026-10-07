import { describe, expect, test } from "bun:test";
import { validateDirectDatabaseUrl } from "./run-drizzle";

describe("validateDirectDatabaseUrl", () => {
  test("accepts local, direct Supabase, and Supavisor session URLs", () => {
    expect(validateDirectDatabaseUrl("postgresql://postgres:secret@localhost:5432/tradebot"))
      .toContain("localhost:5432");
    expect(validateDirectDatabaseUrl("postgresql://postgres:secret@db.example.supabase.co:5432/postgres"))
      .toContain("db.example.supabase.co:5432");
    expect(validateDirectDatabaseUrl("postgresql://postgres.project:secret@pooler.supabase.com:5432/postgres"))
      .toContain("pooler.supabase.com:5432");
  });

  test("rejects missing, malformed, and transaction-pooled URLs", () => {
    expect(() => validateDirectDatabaseUrl(undefined)).toThrow("DATABASE_URL_DIRECT is required");
    expect(() => validateDirectDatabaseUrl("not-a-url")).toThrow("valid PostgreSQL connection URL");
    expect(() => validateDirectDatabaseUrl("https://example.com/database")).toThrow("postgres://");
    expect(() => validateDirectDatabaseUrl("postgresql://postgres:secret@pooler.supabase.com:6543/postgres"))
      .toThrow("transaction pooler");
  });
});
