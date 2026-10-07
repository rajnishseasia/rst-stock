import { describe, it, expect } from "bun:test";
import { buildCorsOrigins } from "../lib/cors-origins.js";

describe("buildCorsOrigins", () => {
  it("excludes localhost origins in production (audit M1)", () => {
    const origins = buildCorsOrigins({
      webUrl: "https://app.example.com",
      nodeEnv: "production",
    });
    expect(origins).toEqual(["https://app.example.com"]);
    expect(origins.some((o) => o.includes("localhost"))).toBe(false);
  });

  it("includes localhost origins in development", () => {
    const origins = buildCorsOrigins({ nodeEnv: "development" });
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://localhost:3001");
    expect(origins).toContain("http://localhost:5100");
  });

  it("includes localhost in test env (only production is locked down)", () => {
    expect(buildCorsOrigins({ nodeEnv: "test" })).toContain(
      "http://localhost:3000",
    );
  });

  it("splits comma-separated WEB_URL values and trims whitespace", () => {
    const origins = buildCorsOrigins({
      webUrl: "https://a.example.com, https://b.example.com ,",
      nodeEnv: "production",
    });
    expect(origins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("returns an empty list in production with no WEB_URL rather than trusting localhost", () => {
    expect(buildCorsOrigins({ nodeEnv: "production" })).toEqual([]);
  });
});
