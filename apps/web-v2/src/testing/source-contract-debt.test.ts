import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const SOURCE_CONTRACT_ALLOWLIST = [
  "app/app/page-layout.test.ts",
  "components/copy-trade/copy-trade-panel.test.ts",
  "components/trade/__tests__/positions-panel.test.ts",
  "components/trade/__tests__/trade-form.test.ts",
  "components/trade/trade-form-review.test.ts",
] as const;

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.(test|spec)\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("source-contract test debt", () => {
  test("does not add new UI tests that inspect implementation source", () => {
    const srcRoot = resolve(import.meta.dir, "..");
    const debt = testFiles(srcRoot)
      .filter((path) => path !== import.meta.path)
      .filter((path) => /readFileSync\s*\(/.test(readFileSync(path, "utf8")))
      // `relative` returns OS-native separators, so on Windows every entry
      // arrives backslashed and no comparison against the forward-slash
      // allowlist can ever match. Normalize so the debt list means the same
      // thing on every machine, not just the Linux CI box.
      .map((path) => relative(srcRoot, path).split(sep).join("/"))
      .sort();

    expect(debt).toEqual([...SOURCE_CONTRACT_ALLOWLIST].sort());
  });
});
