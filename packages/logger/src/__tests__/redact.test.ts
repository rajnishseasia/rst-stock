import { describe, it, expect } from "bun:test";
import { redactSecrets, isSecretKey, REDACTED } from "../redact.js";

describe("isSecretKey (audit L1)", () => {
  it("flags common secret-bearing key names", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "secretKey",
      "ALPACA_MASTER_SECRET",
      "accessToken",
      "refresh_token",
      "password",
      "Authorization",
      "cookie",
      "encryptedCredential",
      "privateKey",
      "ENCRYPTION_KEY",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const key of ["symbol", "userId", "qty", "message", "orderId", "keyId"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts nested secret-keyed values and preserves everything else", () => {
    const input = {
      symbol: "AAPL",
      apiKey: "pk_live_super_secret",
      nested: {
        accessToken: "tok",
        qty: 3,
        deeper: [{ password: "pw", note: "keep" }],
      },
    };
    const out = redactSecrets(input);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.accessToken).toBe(REDACTED);
    expect(out.nested.deeper[0].password).toBe(REDACTED);
    expect(out.symbol).toBe("AAPL");
    expect(out.nested.qty).toBe(3);
    expect(out.nested.deeper[0].note).toBe("keep");
    // Input object is not mutated.
    expect(input.apiKey).toBe("pk_live_super_secret");
  });

  it("truncates subtrees at the depth cutoff instead of passing them through", () => {
    // Build an object nested deeper than MAX_DEPTH with a secret at the bottom.
    let deep: Record<string, unknown> = { apiKey: "leaky" };
    for (let i = 0; i < 10; i++) deep = { level: deep };
    const out = redactSecrets(deep);
    expect(JSON.stringify(out)).not.toContain("leaky");
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it("passes through primitives, Errors, and Dates", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
    const err = new Error("boom");
    expect(redactSecrets(err)).toBe(err);
    const date = new Date();
    expect(redactSecrets(date)).toBe(date);
  });
});
