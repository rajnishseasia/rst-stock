import { describe, expect, it } from "bun:test";
import { parseServerlessPoolMax, serverlessPoolConfig } from "./pool.js";

describe("serverlessPoolConfig", () => {
  it("uses a lazy, bounded two-connection pool by default", () => {
    expect(serverlessPoolConfig("postgresql://example/db", undefined)).toMatchObject({
      connectionString: "postgresql://example/db",
      min: 0,
      max: 2,
      idleTimeoutMillis: 5000,
      maxLifetimeSeconds: 300,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 15000,
    });
  });

  it("accepts only the bounded operational override", () => {
    expect(parseServerlessPoolMax("2")).toBe(2);
    expect(parseServerlessPoolMax("4")).toBe(4);
    expect(parseServerlessPoolMax("0")).toBe(2);
    expect(parseServerlessPoolMax("5")).toBe(2);
    expect(parseServerlessPoolMax("2.5")).toBe(2);
    expect(parseServerlessPoolMax("not-a-number")).toBe(2);
  });
});
