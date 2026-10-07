import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const positionsRouterSource = readFileSync(
  new URL("../routers/positions.ts", import.meta.url),
  "utf8"
);

describe("closed order history", () => {
  test("fetches flat Alpaca rows so filled OCO legs are not hidden by canceled siblings", () => {
    expect(positionsRouterSource).toContain('client.getOrders("closed", fetchLimit, false)');
  });
});
