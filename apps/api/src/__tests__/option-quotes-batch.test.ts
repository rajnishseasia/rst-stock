import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../routers/quotes.ts", import.meta.url), "utf8");

describe("batch option quotes", () => {
  it("exposes a credential-scoped batch endpoint for copy-trade sizing", () => {
    expect(source).toContain("getOptionQuotes: protectedProcedure");
    expect(source).toContain("client.getLatestOptionQuote(occSymbol)");
    expect(source).toMatch(/contracts:\s*z\s*\.array\(/);
  });
});
