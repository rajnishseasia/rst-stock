import { describe, it, expect } from "bun:test";
import { isRemoteDatabaseUrl, maskEmail } from "../../scripts/lib/guard.js";

describe("isRemoteDatabaseUrl (audit M2)", () => {
  it("treats localhost variants as local", () => {
    expect(isRemoteDatabaseUrl("postgresql://postgres:postgres@localhost:5432/tradebot")).toBe(false);
    expect(isRemoteDatabaseUrl("postgresql://postgres@127.0.0.1:5432/db")).toBe(false);
  });

  it("treats hosted databases as remote", () => {
    expect(isRemoteDatabaseUrl("postgresql://user:pw@db.abc123.supabase.co:5432/postgres")).toBe(true);
    expect(isRemoteDatabaseUrl("postgresql://user:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toBe(true);
  });

  it("fails closed on unparsable URLs and open on unset", () => {
    expect(isRemoteDatabaseUrl("not a url at all :: 5432")).toBe(true);
    expect(isRemoteDatabaseUrl(undefined)).toBe(false);
    expect(isRemoteDatabaseUrl("")).toBe(false);
  });
});

describe("maskEmail (audit M2)", () => {
  it("keeps two chars of the local part and the domain", () => {
    expect(maskEmail("someone@example.com")).toBe("so***@example.com");
  });

  it("handles short and malformed values", () => {
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail(null)).toBe("(none)");
    expect(maskEmail(undefined)).toBe("(none)");
  });
});
