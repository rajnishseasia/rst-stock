import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const CASES = [
  "order-idempotency-router.case.ts",
  "position-idempotency-router.case.ts",
  "positions-account-no-day-trade.case.ts",
  "positions-list-realized-pnl.case.ts",
] as const;

describe("order idempotency router isolation", () => {
  for (const file of CASES) {
    test(`${file} passes in an isolated Bun process`, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, "test", resolve(import.meta.dir, file)],
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(
        result.exitCode,
        `${file} failed\n${stdout}\n${stderr}`,
      ).toBe(0);
    });
  }
});
